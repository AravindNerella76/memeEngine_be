import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import * as fs from 'fs';
import { getConfig } from '../config/app-config';
import { OUTPUT_ROOT } from '../security/path-guard';
import { AuthService } from '../auth/auth.service';
import { WhatsAppLoginService } from '../auth/whatsapp-login.service';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { InternetSubjectDiscoveryService } from './internet-subject-discovery.service';
import { InstagramOAuthService, SanitizedInstagramAccount } from './instagram-oauth.service';
import { PushService } from './push.service';
import { AlertRecord, SignInAlertService } from './signin-alerts.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppCredentialsService, WhatsAppStatus } from './whatsapp-credentials.service';

export type HealthStatus = 'ok' | 'warn' | 'bad' | 'off';

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthStatus;
  /** One line, in plain words. */
  summary: string;
  /** What it means, when there is more to say. */
  detail?: string;
  /** What to do about it. `to` is a place in the studio. */
  fix?: { text: string; to?: string; label?: string };
}

export interface HealthGroup {
  id: string;
  title: string;
  checks: HealthCheck[];
}

export interface HealthReport {
  checkedAt: string;
  live: boolean;
  overall: HealthStatus;
  counts: Record<HealthStatus, number>;
  groups: HealthGroup[];
}

/** Everything the report is built from. Gathered by HealthService, turned into words by buildHealth (pure, tested). */
export interface HealthFacts {
  now: Date;
  live: boolean;
  uptimeSec: number;
  db: { ok: boolean; ms: number | null; error?: string };
  auth: {
    enabled: boolean;
    ownerExists: boolean;
    staticLogin: boolean;
    staticWeak: boolean;
    appUrl: string;
    cookieSecure: boolean;
    hosted: boolean;
    whatsappLogin: { ok: boolean; reason?: string };
    alerts: { enabled: boolean; template: boolean; last: AlertRecord | null };
  };
  whatsapp: {
    status: Pick<WhatsAppStatus, 'configured' | 'missing' | 'expired' | 'expiresAt' | 'lastFailure' | 'unreadable' | 'allowedPhone' | 'live' | 'neverExpires'> | null;
    lastWebhookAt: Date | null;
    lastDeliveryFailure: { at: Date; code: number | null; title: string; recipientTail: string } | null;
  };
  instagram: SanitizedInstagramAccount | null;
  publicBaseUrl: string;
  vision: { configured: boolean; backend: string; source: string } | null;
  providers: { id: string; label: string; enabled: boolean; keyConfigured: boolean; disabledReason: string | null; turnedOffInSettings?: boolean }[];
  usage: { provider: string; used: number | null; limit: number; error?: string }[];
  storage: { writable: boolean; error?: string; freeBytes: number | null; ephemeral: boolean };
  push: { ready: boolean; problem: string | null; devices: number; signedInDevices: number; failingDevices: number } | null;
}

const DAY = 86_400_000;
const ago = (from: Date, now: Date): string => {
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const NGROK_DEFAULT = /jailer-effective-wiring\.ngrok-free\.dev/;
const RANK: Record<HealthStatus, number> = { bad: 3, warn: 2, ok: 1, off: 0 };

export function buildHealth(f: HealthFacts): HealthReport {
  const groups: HealthGroup[] = [];

  // ---- the server itself -----------------------------------------------------------------------
  const server: HealthCheck[] = [];
  server.push(
    f.db.ok
      ? { id: 'database', title: 'Database', status: f.db.ms !== null && f.db.ms > 800 ? 'warn' : 'ok', summary: f.db.ms !== null && f.db.ms > 800 ? `Answering, but slowly (${f.db.ms} ms).` : `Answering in ${f.db.ms ?? '?'} ms.`, detail: f.db.ms !== null && f.db.ms > 800 ? 'Pages and saving will feel slow. A free database plan that is busy, or far from the server, does this.' : undefined }
      : { id: 'database', title: 'Database', status: 'bad', summary: 'Not answering. Memes, settings and sign-in cannot be read or saved.', detail: f.db.error, fix: { text: 'Check that MongoDB is running and that MONGO_URI in the server settings points at it, then restart the server.' } }
  );
  server.push(
    !f.storage.writable
      ? { id: 'storage', title: 'Saving pictures', status: 'bad', summary: 'The server cannot write finished memes to disk.', detail: f.storage.error, fix: { text: 'Give the server write access to its output folder (or free up disk space).' } }
      : f.storage.freeBytes !== null && f.storage.freeBytes < 500 * 1024 * 1024
        ? { id: 'storage', title: 'Saving pictures', status: 'warn', summary: `Less than ${Math.max(1, Math.round(f.storage.freeBytes / 1024 / 1024))} MB of disk left.`, fix: { text: 'Free up disk space before it runs out: a full disk stops new memes from being saved.' } }
        : f.storage.ephemeral
          ? { id: 'storage', title: 'Saving pictures', status: 'warn', summary: 'Works, but this host forgets files on every redeploy.', detail: 'Render (and similar hosts) start each deploy with an empty disk, so pictures in the output folder disappear. The memes’ records stay in the database.', fix: { text: 'Download memes you want to keep, or attach a persistent disk to the service.' } }
          : { id: 'storage', title: 'Saving pictures', status: 'ok', summary: f.storage.freeBytes !== null ? `Writable, ${(f.storage.freeBytes / 1024 ** 3).toFixed(1)} GB free.` : 'Writable.' }
  );
  groups.push({ id: 'server', title: 'Server', checks: server });

  // ---- sign-in ---------------------------------------------------------------------------------
  const signIn: HealthCheck[] = [];
  if (!f.auth.enabled) {
    signIn.push({ id: 'login', title: 'Login', status: f.auth.hosted ? 'bad' : 'warn', summary: 'Login is switched off: anyone who can reach the server can use the studio.', fix: { text: 'Remove AUTH_ENABLED=false from the server settings and restart.' } });
  } else if (!f.auth.ownerExists) {
    signIn.push({ id: 'login', title: 'Login', status: 'bad', summary: 'No owner account exists yet, so nobody can sign in.', fix: { text: 'On the server run: npm run auth:create-owner' } });
  } else if (f.auth.staticLogin) {
    signIn.push({
      id: 'login',
      title: 'Login',
      status: f.auth.staticWeak || f.auth.hosted ? 'warn' : 'ok',
      summary: f.auth.staticWeak ? 'The temporary login from the server settings has an easy-to-guess password.' : 'Uses the temporary login from the server settings.',
      detail: 'Anyone who knows the address and that username and password can sign in, publish to Instagram and delete memes.',
      fix: { text: 'Set a long AUTH_STATIC_PASSWORD, or remove both AUTH_STATIC_ settings and run npm run auth:create-owner.', to: '/settings?section=account', label: 'Account' }
    });
  } else {
    signIn.push({ id: 'login', title: 'Login', status: 'ok', summary: 'Owner account with a private password.' });
  }
  if (f.auth.enabled && /^https:/i.test(f.auth.appUrl) && !f.auth.cookieSecure) {
    signIn.push({ id: 'cookie', title: 'Sign-in cookie', status: 'warn', summary: 'The studio is on HTTPS but its sign-in cookie may also travel over plain HTTP.', fix: { text: 'Remove AUTH_COOKIE_SECURE=false from the server settings.' } });
  }
  if (f.auth.enabled) {
    signIn.push(
      f.auth.whatsappLogin.ok
        ? { id: 'whatsapp-login', title: 'Sign in with WhatsApp', status: 'ok', summary: 'Offered on the sign-in page.' }
        : { id: 'whatsapp-login', title: 'Sign in with WhatsApp', status: 'off', summary: f.auth.whatsappLogin.reason || 'Not available.', fix: { text: 'It appears once the WhatsApp bot is fully set up.', to: '/settings?section=whatsapp', label: 'WhatsApp settings' } }
    );
    const a = f.auth.alerts;
    if (!a.enabled) signIn.push({ id: 'alerts', title: 'New sign-in alerts', status: 'off', summary: 'Switched off (AUTH_SIGNIN_ALERTS=false).' });
    else if (a.last && a.last.whatsappFailed > 0 && a.last.whatsappSent === 0 && a.last.pushSent === 0)
      signIn.push({ id: 'alerts', title: 'New sign-in alerts', status: 'warn', summary: `The last alert (${ago(a.last.at, f.now)}) reached nobody.`, fix: { text: 'Check the WhatsApp bot below, or turn on notifications on your phone.', to: '/settings?section=notifications', label: 'Notifications' } });
    else
      signIn.push({
        id: 'alerts',
        title: 'New sign-in alerts',
        status: 'ok',
        summary: a.last ? `On. The last one went out ${ago(a.last.at, f.now)}${a.last.whatsappSent ? ` to ${a.last.whatsappSent} WhatsApp number${a.last.whatsappSent === 1 ? '' : 's'}` : ''}${a.last.pushSent ? `${a.last.whatsappSent ? ' and' : ' to'} ${a.last.pushSent} device${a.last.pushSent === 1 ? '' : 's'}` : ''}.` : 'On: every new sign-in is sent to WhatsApp and your notification devices.',
        detail: a.template ? undefined : 'WhatsApp only delivers these within 24 hours of your last message to the bot. An approved message template (WHATSAPP_ALERT_TEMPLATE) is delivered any time; notifications on your phone always are.'
      });
  }
  groups.push({ id: 'signin', title: 'Sign-in & security', checks: signIn });

  // ---- WhatsApp bot ------------------------------------------------------------------------------
  const wa: HealthCheck[] = [];
  const st = f.whatsapp.status;
  if (!st || !st.configured) {
    wa.push({ id: 'whatsapp-setup', title: 'Connection', status: 'off', summary: st?.missing?.length ? `Not set up yet: ${st.missing.length} setting${st.missing.length === 1 ? '' : 's'} missing.` : 'Not set up yet.', fix: { text: 'Add the access token, phone number ID, verify token, app secret and allowed numbers.', to: '/settings?section=whatsapp', label: 'WhatsApp settings' } });
  } else {
    const expiresSoon = st.expiresAt && !st.neverExpires && new Date(st.expiresAt).getTime() - f.now.getTime() < 3 * DAY;
    if (st.expired === true || st.lastFailure)
      wa.push({ id: 'whatsapp-token', title: 'Access token', status: 'bad', summary: st.lastFailure ? `Meta refused the token ${ago(new Date(st.lastFailure.at), f.now)}: the bot cannot answer.` : 'The access token has expired: the bot cannot answer.', detail: st.lastFailure?.message, fix: { text: 'Paste a new access token (a permanent System User token stops this happening again).', to: '/settings?section=whatsapp', label: 'Replace token' } });
    else if (st.unreadable?.length)
      wa.push({ id: 'whatsapp-token', title: 'Access token', status: 'bad', summary: 'A saved WhatsApp setting can no longer be read (the encryption key changed).', fix: { text: 'Save the WhatsApp settings again.', to: '/settings?section=whatsapp', label: 'WhatsApp settings' } });
    else if (expiresSoon)
      wa.push({ id: 'whatsapp-token', title: 'Access token', status: 'warn', summary: `Expires ${new Date(st.expiresAt as Date).getTime() < f.now.getTime() + DAY ? 'within a day' : 'in a few days'}.`, fix: { text: 'Replace it before it stops working.', to: '/settings?section=whatsapp', label: 'Replace token' } });
    else
      wa.push({ id: 'whatsapp-token', title: 'Access token', status: 'ok', summary: st.live?.ok ? `Meta confirms it works${st.live.verifiedName ? ` for ${st.live.verifiedName}` : ''}${st.neverExpires ? ' and never expires' : ''}.` : st.live && !st.live.ok ? `Could not confirm with Meta: ${st.live.message || 'no answer'}.` : 'Set. (Check again to ask Meta.)' });
    if (st.live && !st.live.ok && !st.live.unreachable && wa[wa.length - 1].status === 'ok') {
      wa[wa.length - 1] = { id: 'whatsapp-token', title: 'Access token', status: 'bad', summary: `Meta rejects the token: ${st.live.message || 'unknown reason'}.`, fix: { text: 'Paste a new access token.', to: '/settings?section=whatsapp', label: 'Replace token' } };
    }
    const n = String(st.allowedPhone || '').split(',').filter(Boolean).length;
    wa.push({ id: 'whatsapp-numbers', title: 'Allowed numbers', status: n ? 'ok' : 'bad', summary: n ? `${n} number${n === 1 ? '' : 's'} may use the bot and sign in.` : 'No number is allowed, so the bot answers nobody.', fix: n ? undefined : { text: 'Add your number with the country code.', to: '/settings?section=whatsapp', label: 'Add a number' } });
    wa.push(
      f.whatsapp.lastWebhookAt
        ? { id: 'whatsapp-webhook', title: 'Incoming messages', status: 'ok', summary: `Meta last delivered something ${ago(f.whatsapp.lastWebhookAt, f.now)}.` }
        : { id: 'whatsapp-webhook', title: 'Incoming messages', status: 'warn', summary: f.uptimeSec < 600 ? 'Nothing received since the server started a few minutes ago.' : `Nothing received in the ${Math.round(f.uptimeSec / 3600) || 1} hour${Math.round(f.uptimeSec / 3600) === 1 ? '' : 's'} since the server started.`, detail: 'Send the bot "status" from your phone. No answer means Meta is not reaching this server: the webhook address in Meta must be this server’s public address.', fix: { text: 'Compare the webhook URL in Meta (WhatsApp › Configuration) with the one shown in WhatsApp settings.', to: '/settings?section=whatsapp', label: 'WhatsApp settings' } }
    );
    const d = f.whatsapp.lastDeliveryFailure;
    if (d && f.now.getTime() - d.at.getTime() < DAY) {
      const window = d.code === 131047 || /re-?engagement|24 ?hours?/i.test(d.title);
      wa.push({
        id: 'whatsapp-delivery',
        title: 'Messages to you',
        status: 'warn',
        summary: window ? `WhatsApp held back a message ${ago(d.at, f.now)}: the 24-hour window had closed.` : `WhatsApp could not deliver a message ${ago(d.at, f.now)} (to the number ending ${d.recipientTail}).`,
        detail: window ? 'The bot can only write to you within 24 hours of your last message to it. Send it anything to reopen the window, or set an approved alert template (WHATSAPP_ALERT_TEMPLATE).' : `${d.code ? `Error ${d.code}: ` : ''}${d.title}`
      });
    }
  }
  groups.push({ id: 'whatsapp', title: 'WhatsApp bot', checks: wa });

  // ---- Instagram -------------------------------------------------------------------------------
  const ig: HealthCheck[] = [];
  const acct = f.instagram;
  if (!acct || !acct.connected) {
    ig.push({ id: 'instagram-account', title: 'Account', status: 'off', summary: acct && !acct.metaConfigured ? 'The Meta app is not configured on the server.' : 'Not connected: memes can be made but not published.', fix: { text: 'Connect your Instagram account.', to: '/settings?section=instagram', label: 'Instagram settings' } });
  } else {
    const a = acct.account!;
    const days = a.daysUntilExpiration;
    ig.push(
      a.isExpired || a.status === 'expired'
        ? { id: 'instagram-account', title: 'Account', status: 'bad', summary: `@${a.username}: the connection has expired, publishing will fail.`, fix: { text: 'Reconnect Instagram.', to: '/settings?section=instagram', label: 'Reconnect' } }
        : days !== undefined && days < 7
          ? { id: 'instagram-account', title: 'Account', status: 'warn', summary: `@${a.username}: the connection ends in ${days} day${days === 1 ? '' : 's'}.`, fix: { text: 'Reconnect now to get another 60 days.', to: '/settings?section=instagram', label: 'Reconnect' } }
          : { id: 'instagram-account', title: 'Account', status: 'ok', summary: `@${a.username}${days !== undefined ? `, connected for another ${days} days` : ', connected'}.` }
    );
    if (acct.missingSecret) ig.push({ id: 'instagram-secret', title: 'Meta app secret', status: 'warn', summary: 'Missing on the server, so the connection cannot be renewed automatically.', fix: { text: 'Set META_APP_SECRET in the server settings.' } });
  }
  const urlBad = NGROK_DEFAULT.test(f.publicBaseUrl) && f.auth.hosted;
  ig.push(
    urlBad
      ? { id: 'public-url', title: 'Public address', status: 'bad', summary: 'Still the old development tunnel: Instagram cannot fetch the pictures to publish.', fix: { text: 'Set PUBLIC_BASE_URL to this server’s real https address and restart.' } }
      : NGROK_DEFAULT.test(f.publicBaseUrl)
        ? { id: 'public-url', title: 'Public address', status: 'warn', summary: 'The development tunnel address: publishing only works while that tunnel is running.', detail: f.publicBaseUrl }
        : { id: 'public-url', title: 'Public address', status: /^https:/i.test(f.publicBaseUrl) ? 'ok' : 'warn', summary: /^https:/i.test(f.publicBaseUrl) ? f.publicBaseUrl : `${f.publicBaseUrl} is not https: Instagram needs https.` }
  );
  groups.push({ id: 'instagram', title: 'Instagram', checks: ig });

  // ---- the engine ------------------------------------------------------------------------------
  const engine: HealthCheck[] = [];
  engine.push(
    f.vision?.configured
      ? { id: 'vision', title: 'AI vision', status: 'ok', summary: f.vision.backend === 'gemini-api' ? 'Gemini API key set.' : 'Vision CLI found on this computer.' }
      : { id: 'vision', title: 'AI vision', status: 'bad', summary: 'Not found: Viral Adaptation cannot read references or verify pictures.', detail: 'Create Meme (manual) still works.', fix: { text: 'Install the vision CLI on this computer (or set VISION_CLI_PATH), or set GEMINI_API_KEY, then restart.' } }
  );
  const enabled = f.providers.filter(p => p.enabled);
  engine.push(
    enabled.length
      ? { id: 'image-sources', title: 'Image sources', status: 'ok', summary: `${enabled.length} on: ${enabled.map(p => p.label).join(', ')}.` }
      : { id: 'image-sources', title: 'Image sources', status: 'bad', summary: 'Every image source is off, so pictures cannot be found.', fix: { text: 'Turn at least one source on.', to: '/settings?section=discovery', label: 'Image Discovery' } }
  );
  for (const u of f.usage) {
    if (u.used === null || !u.limit) continue;
    const pct = u.used / u.limit;
    if (pct >= 0.8) {
      const label = f.providers.find(p => p.id === u.provider)?.label || u.provider;
      engine.push({ id: `quota-${u.provider}`, title: `${label} quota`, status: pct >= 1 ? 'bad' : 'warn', summary: `${u.used} of ${u.limit} searches used this month${pct >= 1 ? ': it is skipped until next month' : ''}.` });
    }
  }
  groups.push({ id: 'engine', title: 'Meme engine', checks: engine });

  // ---- notifications ---------------------------------------------------------------------------
  const p = f.push;
  groups.push({
    id: 'notifications',
    title: 'Notifications',
    checks: [
      !p || !p.ready
        ? { id: 'push', title: 'Phone & desktop notifications', status: 'bad', summary: 'Unavailable on this server.', detail: p?.problem || undefined }
        : p.signedInDevices === 0
          ? { id: 'push', title: 'Phone & desktop notifications', status: 'off', summary: p.devices ? 'No signed-in device gets them right now.' : 'No device has turned them on yet.', fix: { text: 'Turn them on, on the phone you carry.', to: '/settings?section=notifications', label: 'Notifications' } }
          : { id: 'push', title: 'Phone & desktop notifications', status: p.failingDevices ? 'warn' : 'ok', summary: `${p.signedInDevices} device${p.signedInDevices === 1 ? '' : 's'} get${p.signedInDevices === 1 ? 's' : ''} them${p.failingDevices ? `; ${p.failingDevices} failed recently` : ''}.`, fix: p.failingDevices ? { text: 'Send a test from Notifications settings.', to: '/settings?section=notifications', label: 'Notifications' } : undefined }
    ]
  });

  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, bad: 0, off: 0 };
  let overall: HealthStatus = 'ok';
  for (const g of groups) for (const c of g.checks) {
    counts[c.status]++;
    if (RANK[c.status] > RANK[overall]) overall = c.status;
  }
  return { checkedAt: f.now.toISOString(), live: f.live, overall, counts, groups };
}

/** Never longer than `ms`: one slow service must not hold up the whole report. */
async function within<T>(ms: number, work: () => Promise<T>, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work(), new Promise<T>(resolve => (t = setTimeout(() => resolve(fallback), ms)))]);
  } catch {
    return fallback;
  } finally {
    if (t) clearTimeout(t);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly auth: AuthService,
    @Optional() private readonly whatsappLogin?: WhatsAppLoginService,
    @Optional() private readonly whatsappCreds?: WhatsAppCredentialsService,
    @Optional() private readonly whatsapp?: WhatsAppService,
    @Optional() private readonly instagram?: InstagramOAuthService,
    @Optional() private readonly vision?: VisionCliRunner,
    @Optional() private readonly discovery?: InternetSubjectDiscoveryService,
    @Optional() private readonly push?: PushService,
    @Optional() private readonly alerts?: SignInAlertService
  ) {}

  async report(live = false): Promise<HealthReport> {
    return buildHealth(await this.facts(live));
  }

  private async facts(live: boolean): Promise<HealthFacts> {
    const cfg = getConfig();
    const hosted = Boolean(process.env.RENDER || cfg.auth.appHosts.length || /^https:/i.test(cfg.auth.appPublicUrl));
    const [db, ownerExists, waLogin, waStatus, instagram, usage, push, storage] = await Promise.all([
      this.pingDb(),
      within(3000, () => this.auth.ownerExists(), true),
      within(3000, async () => (this.whatsappLogin ? this.whatsappLogin.configured() : { ok: false, reason: 'Not available.' }), { ok: false, reason: 'Could not check.' }),
      within(live ? 16_000 : 4000, async () => (this.whatsappCreds ? this.whatsappCreds.status(live) : null), null),
      within(4000, async () => (this.instagram ? this.instagram.getSanitizedAccount() : null), null),
      within(4000, async () => (this.discovery ? this.discovery.describeUsage() : []), []),
      within(4000, async () => (this.push ? this.push.describe() : null), null),
      this.storage()
    ]);
    const staticFlags = cfg.auth.staticUsername ? this.auth.staticFlags(String(cfg.auth.staticUsername).trim().toLowerCase()) : {};
    return {
      now: new Date(),
      live,
      uptimeSec: Math.round(process.uptime()),
      db,
      auth: {
        enabled: cfg.auth.enabled,
        ownerExists,
        staticLogin: Boolean(staticFlags.staticCredentials),
        staticWeak: Boolean(staticFlags.staticWeak),
        appUrl: cfg.auth.appPublicUrl,
        cookieSecure: cfg.auth.cookieSecure,
        hosted,
        whatsappLogin: waLogin,
        alerts: { enabled: cfg.auth.signInAlerts, template: Boolean(cfg.whatsapp.alertTemplate), last: this.alerts?.last || null }
      },
      whatsapp: { status: waStatus, lastWebhookAt: this.whatsapp?.lastWebhookAt || null, lastDeliveryFailure: this.whatsapp?.lastDeliveryFailure || null },
      instagram,
      publicBaseUrl: cfg.instagram.publicBaseUrl,
      vision: this.vision ? this.vision.describe() : null,
      providers: this.discovery ? this.discovery.describeProviders() : [],
      usage: usage as HealthFacts['usage'],
      storage,
      push
    };
  }

  private async pingDb(): Promise<HealthFacts['db']> {
    const t0 = Date.now();
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) return { ok: false, ms: null, error: 'Not connected.' };
      const db = this.connection.db;
      const ok = await within(4000, async () => Boolean(await db.admin().ping()), false);
      return ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: null, error: 'No answer within 4 seconds.' };
    } catch (err: any) {
      return { ok: false, ms: null, error: String(err?.message || err).slice(0, 200) };
    }
  }

  private async storage(): Promise<HealthFacts['storage']> {
    const ephemeral = Boolean(process.env.RENDER) && !process.env.RENDER_DISK_PATH;
    try {
      fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
      const probe = `${OUTPUT_ROOT}/.health-${process.pid}`;
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      let freeBytes: number | null = null;
      const statfs = (fs as any).statfsSync as ((p: string) => { bavail: number; bsize: number }) | undefined;
      if (statfs) {
        try {
          const s = statfs(OUTPUT_ROOT);
          freeBytes = Number(s.bavail) * Number(s.bsize);
        } catch {
          freeBytes = null;
        }
      }
      return { writable: true, freeBytes, ephemeral };
    } catch (err: any) {
      return { writable: false, error: String(err?.message || err).slice(0, 200), freeBytes: null, ephemeral };
    }
  }
}

