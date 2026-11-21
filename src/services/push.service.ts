import { BadRequestException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as webpush from 'web-push';
import { getConfig } from '../config/app-config';
import { AuthService } from '../auth/auth.service';
import { describeDevice } from '../auth/device';
import { PushDevice, PushDeviceDocument, PushKeys, PushKeysDocument, PushKind, PUSH_KINDS } from '../schemas/push.schemas';
import { InstagramTokenService } from './instagram-token.service';
import { AdaptationJobService } from './adaptation-job.service';
import type { JobView } from '../jobs/adaptation-progress';

/** What a notification says. `url` is where a tap takes you (a path inside the studio). */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** Same tag = replaces the earlier notification instead of stacking (e.g. one per meme). */
  tag: string;
  /** A picture shown large in the notification where the system supports it (the finished meme). */
  image?: string;
  /** Security alerts stay on screen until dealt with. */
  requireInteraction?: boolean;
  /** Show it even when the studio is open in front of you (a test you asked for). */
  force?: boolean;
}

export interface PushSendResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Push services browsers use. The server sends to the address a browser hands it, so only these hosts are accepted:
 * a signed-in client must not be able to make the server POST to an arbitrary address.
 */
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chromium\.org$/];

export function isAllowedPushEndpoint(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 1000) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch {
    return false;
  }
}

const b64url = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Notifications that reach a device even when the studio is closed (Web Push). The browser subscribes with the
 * server's public key; the server signs each message with its private key (VAPID) and the browser's push service
 * delivers it, encrypted end to end. Devices that are signed out, or that the push service says are gone, stop
 * receiving and are forgotten.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private keys: { publicKey: string; privateKey: string; source: 'env' | 'database' } | null = null;
  private keysProblem: string | null = null;

  constructor(
    @InjectModel(PushDevice.name) private readonly devices: Model<PushDeviceDocument>,
    @InjectModel(PushKeys.name) private readonly keyModel: Model<PushKeysDocument>,
    private readonly auth: AuthService,
    @Optional() private readonly crypto?: InstagramTokenService,
    @Optional() private readonly jobs?: AdaptationJobService
  ) {}

  async onModuleInit(): Promise<void> {
    this.jobs?.events.on('finished', (view: JobView) => void this.announceJob(view));
    try {
      await this.ensureKeys();
    } catch (err: any) {
      this.keysProblem = err?.message || String(err);
      this.logger.warn(`Push notifications are off: ${this.keysProblem}`);
    }
  }

  /** A meme finished (or failed) in the background: tell the devices that want to know. */
  async announceJob(view: JobView): Promise<PushSendResult> {
    if (view.status === 'done') {
      const meme: any = view.result || {};
      const id = String(meme.memeId || meme.id || '');
      const punchline = String(meme.content?.punchline || '').replace(/\s+/g, ' ').trim();
      return this.send('meme', {
        title: 'Your meme is ready',
        body: punchline ? `“${punchline.slice(0, 120)}” · saved in My Memes. Tap to see it.` : 'Saved in My Memes. Tap to see it.',
        url: id ? `/meme/${encodeURIComponent(id)}` : '/memes',
        tag: `job-${view.id}`,
        ...(id ? { image: `/api/memes/${encodeURIComponent(id)}/thumb` } : {})
      });
    }
    if (view.status === 'failed') {
      return this.send('meme', { title: 'The meme could not be made', body: String(view.error?.message || 'Open the studio to see why.').slice(0, 180), url: '/', tag: `job-${view.id}` });
    }
    return { sent: 0, removed: 0, failed: 0 };
  }

  // ---- keys ------------------------------------------------------------------------------------

  private async ensureKeys(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.keys) return this.keys;
    const c = getConfig().push;
    if (c.vapidPublicKey && c.vapidPrivateKey) {
      this.keys = { publicKey: c.vapidPublicKey, privateKey: c.vapidPrivateKey, source: 'env' };
      return this.keys;
    }
    if (!this.crypto) throw new Error('No VAPID keys set and no way to store generated ones.');
    const saved = await this.keyModel.findOne({ name: 'vapid' }).lean();
    if (saved) {
      try {
        this.keys = { publicKey: saved.publicKey, privateKey: this.crypto.decrypt(saved.privateKey), source: 'database' };
        return this.keys;
      } catch {
        // the encryption key changed (e.g. a new host without INSTAGRAM_TOKEN_ENCRYPTION_KEY): start over. Browsers notice
        // the new public key and subscribe again by themselves; the old subscriptions cannot be used any more.
        this.logger.warn('The saved push key could not be read (encryption key changed). Making a new one; devices will subscribe again.');
        await this.devices.deleteMany({});
        await this.keyModel.deleteOne({ name: 'vapid' });
      }
    }
    const fresh = webpush.generateVAPIDKeys();
    await this.keyModel.create({ name: 'vapid', publicKey: fresh.publicKey, privateKey: this.crypto.encrypt(fresh.privateKey) });
    this.keys = { publicKey: fresh.publicKey, privateKey: fresh.privateKey, source: 'database' };
    this.logger.log('Made a key pair for push notifications (saved, private half encrypted).');
    return this.keys;
  }

  async publicKey(): Promise<string | null> {
    try {
      return (await this.ensureKeys()).publicKey;
    } catch (err: any) {
      this.keysProblem = err?.message || String(err);
      return null;
    }
  }

  // ---- devices ---------------------------------------------------------------------------------

  /** A browser allowed notifications. Re-subscribing the same browser updates it (and moves it to this sign-in). */
  async subscribe(sub: unknown, sessionHash: string, userAgent: string, kinds?: unknown): Promise<{ id: string; kinds: PushKind[] }> {
    const s = sub && typeof sub === 'object' ? (sub as any) : {};
    const endpoint = s.endpoint;
    const p256dh = s.keys?.p256dh;
    const auth = s.keys?.auth;
    if (!isAllowedPushEndpoint(endpoint)) throw new BadRequestException({ statusCode: 400, code: 'bad_endpoint', message: 'This browser’s push service is not one the studio knows.' });
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !b64url.test(p256dh) || !b64url.test(auth) || p256dh.length > 200 || auth.length > 100) {
      throw new BadRequestException({ statusCode: 400, code: 'bad_keys', message: 'The subscription keys are missing or malformed.' });
    }
    const chosen = this.cleanKinds(kinds);
    const doc = await this.devices.findOneAndUpdate(
      { endpoint },
      {
        $set: { p256dh, auth, sessionHash, userAgent: String(userAgent || '').slice(0, 300), failures: 0, lastError: '', ...(chosen ? { kinds: chosen } : {}) },
        $setOnInsert: { endpoint, ...(chosen ? {} : { kinds: [...PUSH_KINDS] }) }
      },
      { upsert: true, new: true }
    );
    return { id: String(doc!._id), kinds: doc!.kinds };
  }

  async setKinds(id: string, kinds: unknown): Promise<PushKind[] | null> {
    const chosen = this.cleanKinds(kinds);
    if (!chosen) throw new BadRequestException({ statusCode: 400, code: 'bad_kinds', message: 'Choose from: ' + PUSH_KINDS.join(', ') });
    const doc = await this.devices.findByIdAndUpdate(id, { $set: { kinds: chosen } }, { new: true }).catch(() => null);
    return doc ? doc.kinds : null;
  }

  async unsubscribe(id: string): Promise<boolean> {
    const r = await this.devices.deleteOne({ _id: id }).catch(() => ({ deletedCount: 0 }));
    return (r.deletedCount || 0) > 0;
  }

  async list(): Promise<Array<{ id: string; device: string; kinds: PushKind[]; createdAt: Date; lastSuccessAt: Date | null; failures: number; signedIn: boolean }>> {
    const rows = await this.devices.find({}).sort({ createdAt: -1 }).lean();
    const live = await this.liveSet(rows.map(r => r.sessionHash));
    return rows.map(r => ({
      id: String(r._id),
      device: describeDevice(r.userAgent),
      kinds: r.kinds,
      createdAt: (r as any).createdAt,
      lastSuccessAt: r.lastSuccessAt,
      failures: r.failures,
      signedIn: live.has(r.sessionHash)
    }));
  }

  /** Sessions still signed in. With login switched off there are none to check: every device counts as signed in. */
  private async liveSet(hashes: string[]): Promise<Set<string>> {
    if (!getConfig().auth.enabled) return new Set(hashes);
    return this.auth.liveSessionHashes(hashes).catch(() => new Set<string>());
  }

  private cleanKinds(kinds: unknown): PushKind[] | null {
    if (!Array.isArray(kinds)) return null;
    return PUSH_KINDS.filter(k => kinds.includes(k));
  }

  // ---- sending ---------------------------------------------------------------------------------

  /** Sends to every signed-in device that wants this kind (or only to `onlyId`). Never throws. */
  async send(kind: PushKind, msg: PushMessage, onlyId?: string): Promise<PushSendResult> {
    const out: PushSendResult = { sent: 0, removed: 0, failed: 0 };
    let keys: { publicKey: string; privateKey: string };
    try {
      keys = await this.ensureKeys();
    } catch {
      return out;
    }
    let rows: PushDeviceDocument[];
    try {
      rows = await this.devices.find(onlyId ? { _id: onlyId } : { kinds: kind });
    } catch {
      return out;
    }
    if (!rows.length) return out;
    const live = await this.liveSet(rows.map(r => r.sessionHash));
    const payload = JSON.stringify({ ...msg, kind, sentAt: Date.now() });
    const urgent = kind === 'security';
    await Promise.all(
      rows.map(async row => {
        if (!live.has(row.sessionHash)) return; // signed out on that device: nothing reaches it
        try {
          await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, {
            vapidDetails: { subject: getConfig().push.contact, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: urgent ? 24 * 3600 : 6 * 3600,
            urgency: urgent ? 'high' : 'normal',
            topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
            timeout: 10_000
          });
          out.sent++;
          await this.devices.updateOne({ _id: row._id }, { $set: { lastSuccessAt: new Date(), failures: 0, lastError: '' } });
        } catch (err: any) {
          const status = Number(err?.statusCode) || 0;
          if (status === 404 || status === 410) {
            // the browser unsubscribed or the subscription expired: forget it
            out.removed++;
            await this.devices.deleteOne({ _id: row._id }).catch(() => undefined);
            return;
          }
          out.failed++;
          const failures = row.failures + 1;
          const why = String(err?.body || err?.message || 'push failed').slice(0, 200);
          this.logger.warn(`Push to ${describeDevice(row.userAgent)} failed (${status || 'network'}): ${why}`);
          if (failures >= 10) await this.devices.deleteOne({ _id: row._id }).catch(() => undefined);
          else await this.devices.updateOne({ _id: row._id }, { $set: { failures, lastError: why } }).catch(() => undefined);
        }
      })
    );
    return out;
  }

  /** For the health page. */
  async describe(): Promise<{ ready: boolean; problem: string | null; keySource: 'env' | 'database' | null; devices: number; signedInDevices: number; failingDevices: number }> {
    const key = await this.publicKey();
    let devices = 0;
    let signedIn = 0;
    let failing = 0;
    try {
      const list = await this.list();
      devices = list.length;
      signedIn = list.filter(d => d.signedIn).length;
      failing = list.filter(d => d.failures > 0).length;
    } catch {
      /* database trouble shows in its own check */
    }
    return { ready: Boolean(key), problem: key ? null : this.keysProblem, keySource: this.keys?.source || null, devices, signedInDevices: signedIn, failingDevices: failing };
  }
}
