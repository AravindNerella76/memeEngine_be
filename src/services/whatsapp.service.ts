import { GoneException, Injectable, Logger, Optional, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { ProgressSink } from '../jobs/adaptation-progress';
import { buildCaption } from './instagram-caption';
import { getConfig } from '../config/app-config';
import { isAllowedPhone } from '../config/phone-list';
// a real (not type-only) import: Nest reads the constructor's parameter types at runtime to inject the service
import { BotReply, WhatsAppLoginService } from '../auth/whatsapp-login.service';
import { WhatsAppSession, WhatsAppSessionDocument } from '../schemas/whatsapp-session.schema';
import { ViralAdaptationService } from './viral-adaptation.service';
import { InstagramPublisherService } from './instagram-publisher.service';
import { MemeEngineService } from './meme-engine.service';
import { ImageSelectionService } from './image-selection.service';
import { FormatLibraryService, FormatSummary } from './format-library.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { validateUploadPayload } from '../security/request-validation';
import type { UploadedAsset } from '../types/meme.types';
import { ConvertedFrom, MAX_CONVERT_INPUT_BYTES, normalizeImageBuffer } from '../security/image-normalize';
import { SafeFetchError, safeFetch } from '../security/safe-fetch';
import { loadImage } from '@napi-rs/canvas';
import { OUTPUT_ROOT } from '../security/path-guard';
import { ReactionLibraryService } from './reaction-library.service';
import { ReactionAnalysis, ReactionFraming, analyzeReactionImage } from './reaction-framing';
import {
  SHEET_PAGE,
  describeFraming,
  folderListText,
  framingFromRow,
  framingOptions,
  framingQuestionText,
  parseFolderReply,
  parseFramingAnswer,
  renderFramingSheet,
  renderSheet,
  softWarning
} from './whatsapp-reaction-ui';

/** An image received from the user, already checked and (when needed) converted to JPEG/PNG/WebP. */
export interface ReceivedImage {
  filePath: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  convertedFrom: ConvertedFrom;
}

/** One meme being made for one person. Kept in memory: it ends with the process, which is how a restart is noticed. */
interface Run {
  id: number;
  kind: 'viral' | 'manual';
  startedAt: number;
  /** Set when the person sent Reset: the result is dropped instead of being delivered. */
  cancelled: boolean;
  /** What the engine is doing now, in words (for "still working" answers). */
  stage: string;
  /** When the bot last wrote to the person (so a quiet stretch gets a short "still working"). */
  lastSaid: number;
}

/** What each pipeline stage is called when talking to the person. */
const STAGE_WORDS: Record<string, string> = {
  analysis: 'reading your reference screenshot',
  identity: 'working out who is who',
  discovery: 'finding and checking pictures',
  render: 'setting the type'
};

/** The session state in plain words ("Status" shows this, never the internal name). */
const STATE_WORDS: Record<string, string> = {
  IDLE: 'Ready for a new meme',
  AWAITING_REACTION: 'Waiting for your reaction image',
  AWAITING_PUNCHLINE: 'Waiting for your punchline',
  GENERATING: 'Making your meme',
  AWAITING_APPROVAL: 'Your meme is ready and waiting for you',
  AWAITING_RETRY: 'Waiting for Retry',
  AWAITING_NEW_PUNCHLINE: 'Waiting for your new punchline',
  AWAITING_SLOT_IMAGE: 'Waiting for a picture of your own',
  AWAITING_FRAMING: 'Waiting for you to choose a frame',
  LIBRARY_FOLDERS: 'Browsing your reaction library',
  LIBRARY_PICK: 'Choosing from your reaction library',
  LAYOUT_EXAMPLE: 'Waiting for an example meme',
  LAYOUT_ANALYZING: 'Learning a layout',
  LAYOUT_NAME: 'Waiting for a layout name',
  MANUAL_TYPE: 'Manual meme: choosing a layout',
  MANUAL_HEADLINE: 'Manual meme: waiting for the headline',
  MANUAL_STATEMENT: 'Manual meme: waiting for the statement',
  MANUAL_SUBJECTS: 'Manual meme: collecting subject images',
  MANUAL_REACTION: 'Manual meme: waiting for the reaction image',
  MANUAL_PUNCHLINE: 'Manual meme: waiting for the punchline'
};

/** The honest version of the wait: a viral meme takes minutes, and the person is told as it goes. */
const GENERATING_VIRAL_TEXT = '⏳ *Making your meme.* This usually takes 2–4 minutes: I read the reference, find and check the pictures, then set your punchline. I will message you as I go.';

/** Say "still working" when this much quiet has passed during a run. */
const QUIET_MS = 75_000;
const TYPING_REFRESH_MS = 20_000;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly seenMessageIds = new Set<string>();
  /** One line per person: their messages are handled one at a time, in the order they arrived. */
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly laneStore = new AsyncLocalStorage<{ release: () => void }>();
  /** The meme being made right now for each person. */
  private readonly runs = new Map<string, Run>();
  private runSeq = 0;
  /** The last message id each person sent (the typing indicator answers a message). */
  private readonly lastIncoming = new Map<string, string>();
  private readonly mediaDir = path.join(__dirname, '..', '..', 'uploads', 'whatsapp');
  /** When Meta last delivered anything to the webhook (the health page: "is the bot hearing anything at all?"). */
  lastWebhookAt: Date | null = null;
  /** The last message WhatsApp accepted from us but could not deliver (Meta reports it later, as a status). */
  lastDeliveryFailure: { at: Date; code: number | null; title: string; recipientTail: string } | null = null;
  /** Where picture sheets are written (served publicly under /output so WhatsApp can fetch them). */
  protected sheetDir = OUTPUT_ROOT;

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    private readonly viralAdaptation: ViralAdaptationService,
    private readonly instagramPublisher: InstagramPublisherService,
    private readonly memeEngine: MemeEngineService,
    private readonly selection: ImageSelectionService,
    private readonly formats: FormatLibraryService,
    // Token and phone number ID saved in the app (Settings > WhatsApp); falls back to the server settings
    @Optional() private readonly credentials?: WhatsAppCredentialsService,
    // The owner's saved reaction pictures (the Reactions page of the app)
    @Optional() private readonly reactions?: ReactionLibraryService,
    // "Send this code to sign in" for the studio's sign-in page, and "Sign out everywhere"
    @Optional() private readonly login?: WhatsAppLoginService
  ) {
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  /**
   * Meta Webhook verification handshake for GET /api/whatsapp/webhook
   */
  async verifyWebhook(mode?: string, token?: string, challenge?: string): Promise<string | null> {
    const expectedToken = (await this.currentCredentials()).verifyToken;
    if (expectedToken && mode === 'subscribe' && token === expectedToken && challenge) {
      this.logger.log(`WhatsApp webhook verified successfully`);
      return challenge;
    }
    this.logger.warn('WhatsApp webhook verification failed (mode/token mismatch or WHATSAPP_VERIFY_TOKEN not set)');
    return null;
  }

  /** Server settings with everything saved in the app (Settings > WhatsApp) applied on top. */
  private async currentCredentials() {
    const env = getConfig().whatsapp;
    if (!this.credentials) return env;
    const c = await this.credentials.getEffective();
    return { ...env, accessToken: c.accessToken, phoneNumberId: c.phoneNumberId, verifyToken: c.verifyToken, appSecret: c.appSecret, allowedPhone: c.allowedPhone };
  }

  /**
   * Sends a plain text WhatsApp message via Meta Cloud API
   */
  async sendTextMessage(to: string, text: string): Promise<boolean> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      this.logger.error('WhatsApp credentials missing in configuration');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.error(`Failed to send WhatsApp message: ${JSON.stringify(errJson)}`);
        this.credentials?.noteSendResult(errJson);
        return false;
      }
      this.credentials?.noteSendResult(null);
      return true;
    } catch (err: any) {
      this.logger.error(`Error sending WhatsApp message: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Sends an image message to WhatsApp via public HTTPS URL. WhatsApp's servers must be able to download that address, so
   * prefer sendPicture, which uploads the picture to WhatsApp itself and needs no public address at all.
   */
  async sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<boolean> {
    return this.postImage(to, { link: imageUrl }, caption);
  }

  /** Sends a picture that was uploaded to WhatsApp (uploadMedia) by its media id. */
  async sendImageById(to: string, mediaId: string, caption?: string): Promise<boolean> {
    return this.postImage(to, { id: mediaId }, caption);
  }

  /**
   * Uploads a picture to WhatsApp (Cloud API media upload) and returns its media id, or null when that did not work. The id
   * can be sent to the user right away (and stays valid for 30 days).
   */
  async uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string | null> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) return null;
    try {
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', mimeType);
      form.set('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
      const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        body: form
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out?.id) {
        this.logger.warn(`Could not upload a picture to WhatsApp (it will be sent as a link instead): ${JSON.stringify(out)}`);
        this.credentials?.noteSendResult(out);
        return null;
      }
      this.credentials?.noteSendResult(null);
      return String(out.id);
    } catch (err: any) {
      this.logger.warn(`Error uploading a picture to WhatsApp: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Sends a picture the most dependable way: uploaded to WhatsApp, so nothing outside has to be reachable from the internet.
   * Only if that fails is it sent as a link to the same picture (which WhatsApp must then be able to download). Returns
   * false when neither worked.
   */
  async sendPicture(to: string, pic: { buffer?: Buffer; filePath?: string; mimeType?: string; url: string }, caption?: string): Promise<boolean> {
    try {
      const buffer = pic.buffer ?? (pic.filePath ? await fs.promises.readFile(pic.filePath) : null);
      if (buffer && buffer.length > 0 && buffer.length <= 5 * 1024 * 1024) {
        const mime = pic.mimeType || (pic.filePath && /\.png$/i.test(pic.filePath) ? 'image/png' : 'image/jpeg');
        const id = await this.uploadMedia(buffer, mime, mime === 'image/png' ? 'picture.png' : 'picture.jpg');
        if (id && (await this.sendImageById(to, id, caption))) return true;
      }
    } catch (err: any) {
      this.logger.warn(`Could not send the picture by upload (${err?.message || err}); trying its link.`);
    }
    return this.sendImageMessage(to, pic.url, caption);
  }

  private async postImage(to: string, image: { link?: string; id?: string }, caption?: string): Promise<boolean> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      this.logger.error('WhatsApp credentials missing in configuration');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
      const payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { ...image }
      };
      if (caption) {
        payload.image.caption = caption;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.error(`Failed to send WhatsApp image: ${JSON.stringify(errJson)}`);
        this.credentials?.noteSendResult(errJson);
        return false;
      }
      this.credentials?.noteSendResult(null);
      return true;
    } catch (err: any) {
      this.logger.error(`Error sending WhatsApp image: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Sends a WhatsApp list message (a tap-to-choose menu of up to 10 rows). Rows: { id, title (24), description (72) }.
   * Returns false when it could not be sent, so the caller can ask in plain text instead.
   */
  async sendListMessage(to: string, body: string, buttonText: string, rows: Array<{ id: string; title: string; description?: string }>): Promise<boolean> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) return false;
    try {
      const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: body.slice(0, 1024) },
            action: {
              button: buttonText.slice(0, 20),
              sections: [{ title: 'Choose one', rows: rows.slice(0, 10).map(r => ({ id: r.id.slice(0, 200), title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }]
            }
          }
        })
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.warn(`Could not send a WhatsApp list message (asking in plain text instead): ${JSON.stringify(errJson)}`);
        this.credentials?.noteSendResult(errJson);
        return false;
      }
      this.credentials?.noteSendResult(null);
      return true;
    } catch (err: any) {
      this.logger.warn(`Error sending a WhatsApp list message: ${err?.message || err}`);
      return false;
    }
  }

  /** Verifies and converts the bytes (HEIC/PDF -> image), then stores them for the pipeline. */
  private async storeImage(buf: Buffer): Promise<ReceivedImage> {
    const n = await normalizeImageBuffer(buf);
    const filename = `wa_${randomUUID()}${n.ext}`;
    const filePath = path.join(this.mediaDir, filename);
    await fs.promises.writeFile(filePath, n.buffer, { flag: 'wx' });
    return { filePath, filename, mimeType: n.mime, width: n.width, height: n.height, convertedFrom: n.convertedFrom };
  }

  /**
   * Downloads a file the user sent in WhatsApp (photo or document) at its original quality and
   * converts it when needed (HEIC, PDF).
   */
  async downloadMedia(mediaId: string): Promise<ReceivedImage> {
    const cfg = await this.currentCredentials();
    // The id is interpolated into a Graph API URL that carries our bearer token: digits only.
    if (!/^\d{1,40}$/.test(String(mediaId))) {
      throw new Error('Invalid WhatsApp media id');
    }
    // Step 1: Query media URL
    const metaRes = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      try { this.credentials?.noteSendResult(JSON.parse(err)); } catch { /* not JSON */ }
      throw new Error(`Failed to query WhatsApp media: ${err}`);
    }
    const metaJson = await metaRes.json();
    const mediaUrl = metaJson.url;
    if (Number(metaJson.file_size) > MAX_CONVERT_INPUT_BYTES) {
      throw new Error(`File is too large (${(Number(metaJson.file_size) / 1048576).toFixed(0)} MB; limit ${MAX_CONVERT_INPUT_BYTES / 1048576} MB)`);
    }

    // Step 2: Download the binary file using access token
    const fileRes = await fetch(mediaUrl, {
      headers: {
        'Authorization': `Bearer ${cfg.accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!fileRes.ok) {
      throw new Error(`Failed to download WhatsApp media bytes: HTTP ${fileRes.status}`);
    }
    if (Number(fileRes.headers.get('content-length')) > MAX_CONVERT_INPUT_BYTES) {
      throw new Error('File is too large');
    }
    return this.storeImage(Buffer.from(await fileRes.arrayBuffer()));
  }

  /** First http(s) link in a message, without trailing punctuation. */
  extractUrl(text: string): string | null {
    const m = /https?:\/\/[^\s<>"']+/i.exec(text || '');
    return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : null;
  }

  /** Share links of common file hosts rewritten to their direct-download form. */
  directDownloadUrl(raw: string): string {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host === 'drive.google.com') {
        const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] || u.searchParams.get('id');
        if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
      }
      if (host === 'www.dropbox.com' || host === 'dropbox.com') {
        u.searchParams.delete('dl');
        u.searchParams.set('dl', '1');
        return u.toString();
      }
    } catch {
      /* fall through: safeFetch validates the URL */
    }
    return raw;
  }

  /** Downloads a direct image link (SSRF-safe, size-capped) and converts it when needed. */
  async downloadImageFromUrl(rawUrl: string): Promise<ReceivedImage> {
    let body: Buffer;
    try {
      const res = await safeFetch(this.directDownloadUrl(rawUrl), {
        timeoutMs: 45_000,
        maxBytes: MAX_CONVERT_INPUT_BYTES,
        userAgent: getConfig().discovery.userAgent
      });
      body = res.body;
    } catch (err: any) {
      if (err instanceof SafeFetchError) {
        throw new Error(
          err.code === 'TOO_LARGE'
            ? `The linked file is larger than ${MAX_CONVERT_INPUT_BYTES / 1048576} MB.`
            : `I could not download that link (${err.code.toLowerCase().replace(/_/g, ' ')}). Send the file itself or a direct image link.`
        );
      }
      throw err;
    }
    const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw new Error('That link opens a web page, not an image file. Send the picture itself (as a Document) or a direct link to the image file.');
    }
    return this.storeImage(body);
  }

  /**
   * Process all incoming webhook events from Meta
   */
  async processIncomingWebhook(body: any): Promise<void> {
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body?.entry)) {
      return;
    }
    this.lastWebhookAt = new Date();

    const work: Promise<void>[] = [];
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change?.field === 'messages') {
          const value = change.value;
          const messages = value?.messages || [];
          for (const msg of messages) {
            // Meta retries deliveries; process each message id once.
            if (msg?.id) {
              if (this.seenMessageIds.has(msg.id)) continue;
              this.seenMessageIds.add(msg.id);
              if (this.seenMessageIds.size > 1000) {
                this.seenMessageIds.delete(this.seenMessageIds.values().next().value as string);
              }
            }
            // Each person has one line: their messages are handled in the order they arrived, never at the same time
            work.push(this.dispatch(msg.from, msg));
          }
          // Meta also reports what became of each message we sent (delivered, read, failed)
          for (const st of value?.statuses || []) work.push(this.handleStatus(st));
        }
      }
    }
    await Promise.all(work);
  }

  // ---------------------------------------------------------------------------------------------
  // One line per person, and one run per meme
  //
  // Meta delivers messages in separate requests that can overlap. Handled at the same time, several photos sent together
  // were saved in the order they finished downloading (not the order they were sent), and two replies could overwrite each
  // other's changes to the session. So a person's messages go through a line, one at a time. A meme takes minutes to make,
  // so the line is released as soon as the work starts: "status" and "reset" still answer meanwhile.
  // ---------------------------------------------------------------------------------------------

  private async inLane(phone: string, work: () => Promise<void>): Promise<void> {
    const before = this.lanes.get(phone) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const tail = before.then(() => gate);
    this.lanes.set(phone, tail);
    await before;
    try {
      await this.laneStore.run({ release }, work);
    } finally {
      release(); // safe to call again if the work already let go early
      if (this.lanes.get(phone) === tail) this.lanes.delete(phone);
    }
  }

  /** Lets the next message through while this one carries on (called when a long run starts). A no-op outside the line. */
  private yieldLane(): void {
    this.laneStore.getStore()?.release();
  }

  private async dispatch(from: string, msg: any): Promise<void> {
    await this.inLane(String(from), async () => {
      try {
        await this.handleUserMessage(String(from), msg);
      } catch (err: any) {
        this.logger.error(`WhatsApp message from ${from} failed: ${err?.stack || err?.message || err}`);
        await this.sendTextMessage(String(from), '⚠️ Something went wrong on my side. Please try again, or send *Reset* to start over.').catch(() => undefined);
      }
    });
  }

  private beginRun(phone: string, kind: 'viral' | 'manual'): Run {
    const run: Run = { id: ++this.runSeq, kind, startedAt: Date.now(), cancelled: false, stage: 'starting', lastSaid: Date.now() };
    this.runs.set(phone, run);
    return run;
  }

  private endRun(phone: string, run: Run): void {
    if (this.runs.get(phone) === run) this.runs.delete(phone);
  }

  /** Reset (or a new start) while a meme is being made: its result will be dropped, not delivered over the new chat. */
  private cancelRun(phone: string): void {
    const run = this.runs.get(phone);
    if (run) {
      run.cancelled = true;
      this.runs.delete(phone);
    }
  }

  /**
   * While a run is going: after a quiet stretch say it is still working, and keep the "typing…" indicator alive.
   * Returns the function that stops it. Never throws.
   */
  private watchRun(phone: string, run: Run): () => void {
    const timer = setInterval(() => {
      if (run.cancelled) return;
      const idle = Date.now() - run.lastSaid;
      if (idle >= QUIET_MS) {
        run.lastSaid = Date.now();
        const s = Math.round((Date.now() - run.startedAt) / 1000);
        void this.sendTextMessage(phone, `⏳ Still working… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} so far, ${run.stage}.`).catch(() => undefined);
      } else {
        void this.markReadTyping(this.lastIncoming.get(phone));
      }
    }, TYPING_REFRESH_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Blue ticks and the "typing…" indicator for the message just received (best effort: a refusal changes nothing). */
  private async markReadTyping(messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    try {
      const cfg = await this.currentCredentials();
      if (!cfg.accessToken || !cfg.phoneNumberId) return;
      await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } })
      });
    } catch {
      /* a courtesy: never worth a failure */
    }
  }

  private readonly reportedFailures = new Set<string>();

  /**
   * A message we sent could not be delivered. WhatsApp accepts a request and fails later (for example when it cannot
   * download a picture from the address it was given), so this is the only place that shows it. It is logged with Meta's
   * reason; when it is a picture that could not be loaded the user is told once, instead of simply getting nothing.
   */
  private async handleStatus(st: any): Promise<void> {
    if (st?.status !== 'failed') return;
    const err = Array.isArray(st.errors) ? st.errors[0] : null;
    const detail = [err?.code ? `(${err.code})` : '', err?.title, err?.error_data?.details || err?.message].filter(Boolean).join(' ');
    this.logger.error(`WhatsApp could not deliver message ${st.id} to ${st.recipient_id}: ${detail || 'no reason given'}`);
    this.lastDeliveryFailure = { at: new Date(), code: Number(err?.code) || null, title: String(err?.title || err?.message || 'no reason given').slice(0, 200), recipientTail: String(st.recipient_id || '').slice(-4) };
    if (!st.id || this.reportedFailures.has(st.id)) return;
    this.reportedFailures.add(st.id);
    if (this.reportedFailures.size > 500) this.reportedFailures.delete(this.reportedFailures.values().next().value as string);
    // 131053 / 131052 / 131051: the picture could not be uploaded, downloaded or is not supported. Never answer a failed text with a text.
    if (![131053, 131052, 131051].includes(Number(err?.code))) return;
    const cfg = await this.currentCredentials();
    if (!st.recipient_id || !isAllowedPhone(cfg.allowedPhone, String(st.recipient_id))) return;
    await this.sendTextMessage(
      String(st.recipient_id),
      '⚠️ WhatsApp could not load the picture I just tried to send. Your meme is saved: open the studio and look in *My Memes* to see it and publish it.\n' +
        'If this keeps happening, the server\'s public address (PUBLIC_BASE_URL) is probably not set to its real address.'
    );
  }

  /**
   * The studio's sign-in page shows a code; an allowed number sends it here. Returns true when the message was about
   * signing in (and has been answered), false when the chat should handle it as usual. A code from a number that is not
   * allowed is never approved: it falls through to the usual "authorized users only" answer.
   */
  private async answerSignIn(from: string, message: any, allowed: boolean): Promise<boolean> {
    if (!this.login) return false;
    let reply: BotReply | null = null;
    try {
      if (message?.type === 'text') reply = await this.login.onWhatsAppText(from, message.text?.body, allowed);
      else if (message?.type === 'interactive') {
        const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        if (id) reply = await this.login.onWhatsAppButton(from, String(id), allowed);
      } else if (message?.type === 'button' && message.button?.payload) {
        // a quick-reply button under a template message (the sign-in alert template) arrives as type "button"
        reply = await this.login.onWhatsAppButton(from, String(message.button.payload), allowed);
      }
    } catch (err: any) {
      this.logger.error(`WhatsApp sign-in message from ${from} failed: ${err?.stack || err?.message || err}`);
      if (!allowed) return false;
      reply = { text: '⚠️ I could not finish that sign-in on my side. Send the code again in a moment, or use the password on the sign-in page.' };
    }
    if (!reply) return false;
    if (message?.id) void this.markReadTyping(String(message.id));
    const sent = reply.buttons?.length ? await this.sendButtonsMessage(from, reply.text, reply.buttons) : false;
    if (!sent) await this.sendTextMessage(from, reply.buttons?.length ? reply.fallback || reply.text : reply.text);
    return true;
  }

  /**
   * Conversational state machine for handling messages from a user
   */
  private async handleUserMessage(from: string, message: any): Promise<void> {
    const cfg = await this.currentCredentials();
    const allowed = isAllowedPhone(cfg.allowedPhone, from);
    // A studio sign-in code (or "Sign out everywhere") is answered before anything else and never touches the meme chat
    if (await this.answerSignIn(from, message, allowed)) return;
    // Security check: restrict to configured phone number if specified
    // Fail closed: with no allowed number configured nobody is authorised. Several numbers may be allowed.
    if (!allowed) {
      this.logger.warn(`Rejected message from unauthorized phone: ${from}`);
      if (cfg.allowedPhone) {
        await this.sendTextMessage(from, '⛔ This Meme Engine WhatsApp bot is configured for authorized users only.');
      }
      return;
    }

    let session = await this.sessionModel.findOne({ phoneNumber: from });
    if (!session) {
      session = await this.sessionModel.create({
        phoneNumber: from,
        state: 'IDLE'
      });
    }

    const type = message.type;

    // Blue ticks and "typing…" straight away, so the person sees the bot has their message
    if (message.id) {
      this.lastIncoming.set(from, String(message.id));
      void this.markReadTyping(String(message.id));
    }

    // The server restarted (or the run was lost) while a meme was being made: say so instead of staying silent for good
    if (session.state === 'GENERATING' && !this.runs.has(from)) {
      const offeredRetry = await this.recoverLostRun(session, from);
      if (offeredRetry) {
        // the message that arrived is not an answer to a question nobody has asked yet: only a command carries on
        const word = type === 'text' ? String(message.text?.body || '').trim().toLowerCase() : '';
        if (!['retry', 'try again', 'reset', 'cancel', 'clear', 'new', 'discard', 'status', 'help', 'menu'].includes(word)) return;
      }
    }

    // A tap on a list row or a button: the frame question, or an action under a finished meme
    if (type === 'interactive') {
      const reply = message.interactive?.list_reply || message.interactive?.button_reply;
      const id = reply?.id ? String(reply.id) : '';
      if (/^(pub|pl|no):/.test(id)) await this.answerReviewButton(session, from, id);
      else if (session.state === 'AWAITING_FRAMING' && id) await this.answerFraming(session, from, id);
      return;
    }

    // Handle Text Commands
    if (type === 'text') {
      const text = (message.text?.body || '').trim();
      const lower = text.toLowerCase();

      // The new punchline for a finished meme (after "Change punchline"): whatever is typed next is the punchline, even a word
      // the bot also uses ("hello"). Only the ways out (reset, status, cancel) keep their meaning.
      if (session.state === 'AWAITING_NEW_PUNCHLINE' && !['reset', 'clear', 'new', 'discard', 'status', 'cancel'].includes(lower)) {
        await this.applyNewPunchline(session, from, text);
        return;
      }

      // Command: HELP / MENU
      if (['hi', 'hello', 'help', 'menu', 'start'].includes(lower)) {
        await this.sendTextMessage(
          from,
          `🎭 *Meme Engine WhatsApp Bot*\n\n` +
          `To create and publish a meme:\n` +
          `1️⃣ Send the *Reference Meme* screenshot\n` +
          `2️⃣ Send the *Reaction Image* — or send *Library* to pick one of your saved reactions (folders like Shocking, Sad, Praise)\n` +
          `3️⃣ If the reaction picture has stacked frames I will ask which frame to use\n` +
          `4️⃣ Send the *Punchline Text*\n\n` +
          `Or send *Manual* to build a meme from your own images and text.\n\n` +
          `📎 *Best quality:* send pictures as a *Document* (📎 → Document): JPG, PNG, WebP, HEIC or PDF. ` +
          `You can also paste a direct image link.\n\n` +
          `📐 *Layouts:* send *Layouts* to see your saved meme layouts, or *New layout* to teach me one from an example meme.\n\n` +
          `Under a finished meme: tap *Publish*, *Change punchline* or *Discard*.\n\n` +
          `Commands:\n` +
          `• *Approve* — Publish pending meme to Instagram (@kanyaraasi_memes)\n` +
          `• *Caption: your text* — Use your own Instagram caption\n` +
          `• *Retry* — Run the last meme again if it failed\n` +
          `• *Reset* — Clear current draft and start fresh\n` +
          `• *Status* — Check current state

` +
          `🔐 *Studio sign-in:* send the code shown on the studio's sign-in page. *Sign out everywhere* ends every studio sign-in at once.`
        );
        return;
      }

      // "Cancel" while typing a new punchline only goes back to the meme; it does not throw the meme away
      if (session.state === 'AWAITING_NEW_PUNCHLINE' && lower === 'cancel') {
        session.state = 'AWAITING_APPROVAL';
        await session.save();
        await this.sendTextMessage(from, '👍 Kept the punchline as it was.');
        await this.sendReviewActions(session, from);
        return;
      }

      // Command: RESET / CANCEL / DISCARD (a meme still being made is dropped, not delivered into the fresh chat)
      if (['reset', 'cancel', 'clear', 'new', 'discard'].includes(lower)) {
        const wasMaking = this.runs.has(from);
        this.cancelRun(from);
        await this.resetSession(session);
        await this.sendTextMessage(
          from,
          wasMaking
            ? '🧹 Stopped. The meme being made is dropped. Send a *reference meme screenshot* to start fresh.'
            : '🧹 Session cleared! Send a *reference meme screenshot* to start fresh.'
        );
        return;
      }

      // Command: STATUS
      if (lower === 'status') {
        const run = this.runs.get(from);
        const secs = run ? Math.round((Date.now() - run.startedAt) / 1000) : 0;
        await this.sendTextMessage(
          from,
          `📊 *${STATE_WORDS[session.state] || 'Working'}*${run ? ` (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} so far, ${run.stage})` : ''}\n` +
          `Reference Image: ${session.referenceImagePath ? '✅ Ready' : '❌ Not set'}\n` +
          `Reaction Image: ${session.reactionImagePath ? `✅ Ready${session.reactionLibraryId ? ' (from your library)' : ''}` : '❌ Not set'}\n` +
          (session.reactionFraming ? `Framing: ${describeFraming(session.reactionFraming as ReactionFraming)}\n` : '') +
          `Punchline: ${session.punchline ? `"${session.punchline}"` : '❌ Not set'}`
        );
        return;
      }


      // Reaction library and the "which frame?" question
      if (await this.handleReactionFlowText(session, from, text, lower)) return;

      // Layout library: list / add / name / delete saved layouts (and the naming step after learning one)
      if (await this.handleLayoutCommand(session, from, text, lower)) return;

      // After a failure or a restart: "Retry" runs it again; any other text is taken as a new punchline
      if (session.state === 'AWAITING_RETRY' && text) {
        if (lower === 'retry' || lower === 'try again') {
          await this.runAgain(session, from);
          return;
        }
        session.punchline = text;
        await this.runAgain(session, from);
        return;
      }

      // Command: APPROVE / PUBLISH. Only these words publish: a casual "ok" or "yes" must never post publicly.
      if (!this.isManualState(session) && ['approve', 'approved', 'publish'].includes(lower)) {
        if (session.state === 'AWAITING_APPROVAL' && session.lastGeneratedMemeId) {
          await this.publishCurrent(session, from);
        } else {
          await this.sendTextMessage(from, '⚠️ No meme is currently waiting for approval. Send a *reference meme screenshot* to create one!');
        }
        return;
      }

      // A casual "ok"/"yes"/"👍" under a finished meme: remind how to publish instead of publishing
      if (session.state === 'AWAITING_APPROVAL' && ['ok', 'okay', 'yes', 'y', 'yep', 'sure', '👍'].includes(lower)) {
        await this.sendTextMessage(from, '👍 To post it to Instagram, tap *Publish* (or send *Approve*). I will not post anything unless you do.');
        await this.sendReviewActions(session, from);
        return;
      }

      // Your own Instagram caption for the meme waiting for approval: "Caption: text"
      if (session.state === 'AWAITING_APPROVAL' && /^caption\s*[:\-]/i.test(text)) {
        const own = text.replace(/^caption\s*[:\-]\s*/i, '').trim();
        if (!own) {
          await this.sendTextMessage(from, 'Send it like this: *Caption: your text*');
          return;
        }
        session.lastGeneratedCaption = own.slice(0, 2200);
        await session.save();
        await this.sendTextMessage(from, '✅ Caption saved. It will be used when you publish.');
        await this.sendReviewActions(session, from);
        return;
      }

      // Command: FIT / FILL toggle in review mode for manual memes
      if (session.state === 'AWAITING_APPROVAL' && session.mode === 'manual' && session.manualSubjects?.length) {
        if (['fit', 'contain', 'nocrop', 'no crop'].includes(lower)) {
          session.manualSubjectFit = 'contain';
          await session.save();
          await this.sendTextMessage(from, '🔄 Re-rendering with *Fit Whole Image (No Crop)*...');
          await this.generateManualMeme(session, from);
          return;
        }
        if (['fill', 'cover', 'crop'].includes(lower)) {
          session.manualSubjectFit = 'cover';
          await session.save();
          await this.sendTextMessage(from, '🔄 Re-rendering with *Fill & Crop*...');
          await this.generateManualMeme(session, from);
          return;
        }
      }

      // Command: REPLACE / SWAP guidance in review mode
      if (session.state === 'AWAITING_APPROVAL' && ['replace', 'swap', 'change image', 'replace image', 'replace reaction'].includes(lower)) {
        await this.sendTextMessage(
          from,
          `🔄 *How to replace an image:*\n\n` +
          `• Send a new photo (or link) to replace the subject image (Slot 1)\n` +
          `• For multi-image memes, send photo with caption *replace 2* or *replace 3*\n` +
          `• To replace the reaction photo, send photo with caption *replace reaction*\n` +
          (session.mode === 'manual' ? `• Or reply *Fit* / *Fill* to toggle image cropping without replacing\n` : '') +
          `\nSend your photo now, or reply *Approve* to publish!`
        );
        return;
      }

      // A pasted link counts as a picture whenever the bot is waiting for one; extra words become the caption/label
      const link = this.extractUrl(text);
      if (link) {
        const wantsReplace = session.state === 'AWAITING_APPROVAL' && (lower.includes('replace') || lower.includes('swap') || /\.(jpe?g|png|webp)($|\?)/i.test(link));
        if (this.expectsImage(session) || wantsReplace) {
          await this.receiveImage(session, from, { url: link }, text.replace(link, '').trim(), false);
          return;
        }
      }

      if (session.state === 'AWAITING_SLOT_IMAGE') {
        await this.askForSlotImage(session, from, true);
        return;
      }

      // Manual (own edit) flow: start, then route every text message while it is in progress
      if (['manual', 'custom', 'own'].includes(lower)) {
        if (session.state === 'AWAITING_APPROVAL' || session.state === 'GENERATING') {
          await this.sendTextMessage(from, '\u26a0\ufe0f Finish or *Reset* the current meme first.');
          return;
        }
        await this.resetSession(session);
        session.mode = 'manual';
        session.state = 'MANUAL_TYPE';
        await session.save();
        await this.sendTextMessage(from, this.manualTypePrompt(await this.formats.list()));
        return;
      }
      if (this.isManualState(session)) {
        await this.handleManualText(session, from, text);
        return;
      }

      // When waiting for punchline text
      if (session.state === 'AWAITING_PUNCHLINE') {
        session.punchline = text;
        session.state = 'GENERATING';
        await session.save();

        await this.sendTextMessage(from, GENERATING_VIRAL_TEXT);
        await this.generateAndSendMeme(session, from);
        return;
      }

      // If text sent in IDLE or AWAITING_REACTION without an image
      if (session.state === 'IDLE') {
        await this.sendTextMessage(from, '📸 Please send a *reference meme screenshot* first to start generating!');
        return;
      }

      if (session.state === 'AWAITING_REACTION') {
        await this.sendTextMessage(from, '🎭 Please send the *reaction image* (e.g. Brahmanandam, Pawan Kalyan, etc.) to continue.' + (await this.libraryHint()));
        return;
      }

      // Anything else is a state this text has no meaning in (a meme being made, one waiting for approval...): never silence
      await this.nudge(session, from);
      return;
    }

    // Pictures: compressed photos ("image"), original-quality files ("document": JPG/PNG/WebP/HEIC/PDF)
    if (type === 'image' || type === 'document') {
      const media = message[type] || {};
      await this.receiveImage(session, from, { mediaId: media.id }, String(media.caption || '').trim(), type === 'image');
      return;
    }

    // Voice notes, videos, locations, contacts: say what the bot can use. (Emoji reactions to a message are ignored on purpose.)
    if (['audio', 'voice', 'video', 'sticker', 'location', 'contacts'].includes(type)) {
      await this.sendTextMessage(from, '🙂 I can only work with *pictures* and *text*. Send a picture (best as a Document 📎), or *Help* to see what I can do.');
    }
  }

  /**
   * An answer for a message that has no meaning in the state the chat is in. Says where things stand and what to do
   * next, so the chat never goes quiet.
   */
  private async nudge(session: WhatsAppSessionDocument, from: string): Promise<void> {
    switch (session.state) {
      case 'GENERATING': {
        const run = this.runs.get(from);
        const secs = run ? Math.round((Date.now() - run.startedAt) / 1000) : 0;
        await this.sendTextMessage(
          from,
          `⏳ Still making your meme${run ? ` (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} so far, ${run.stage})` : ''}. I will send it here the moment it is ready.\n_Send *Reset* to stop it._`
        );
        return;
      }
      case 'AWAITING_APPROVAL':
        await this.sendTextMessage(from, '👇 Your meme is waiting. Tap a button below, or send a photo to replace an image.');
        await this.sendReviewActions(session, from);
        return;
      case 'AWAITING_RETRY':
        await this.sendTextMessage(from, 'Send *Retry* to make it again, a new *punchline* to try it with that, or *Reset* to start over.');
        return;
      default:
        await this.sendTextMessage(from, `🤔 I did not understand that. ${STATE_WORDS[session.state] || 'Send *Help* to see what I can do'} — send *Help* for the steps, or *Reset* to start over.`);
    }
  }

  /** The server restarted (or the run was lost) while a meme was being made: the inputs are safe, so offer to run it again. */
  private async recoverLostRun(session: WhatsAppSessionDocument, from: string): Promise<boolean> {
    const manual = session.mode === 'manual';
    const complete = manual
      ? Boolean(session.manualSubjects?.length && session.reactionImagePath && session.punchline)
      : Boolean(session.referenceImagePath && session.reactionImagePath && session.punchline);
    this.logger.warn(`WhatsApp session ${from} was GENERATING with no run in memory (restart?): ${complete ? 'offering a retry' : 'clearing it'}`);
    if (complete) {
      session.state = 'AWAITING_RETRY';
      await session.save();
      await this.sendTextMessage(from, '⚠️ I lost track of the meme I was making (the server restarted). Your pictures and punchline are still here.\nSend *Retry* to make it again, or *Reset* to start over.');
      return true;
    }
    await this.resetSession(session);
    await this.sendTextMessage(from, '⚠️ I lost track of what we were doing (the server restarted). Send a *reference meme screenshot* to start again.');
    return false;
  }

  /** "Retry" (or a new punchline) after a failure or a restart: the same inputs, run again. */
  private async runAgain(session: WhatsAppSessionDocument, from: string): Promise<void> {
    if (this.runs.has(from)) {
      await this.nudge(session, from);
      return;
    }
    if (session.mode === 'manual') {
      if (!session.manualSubjects?.length || !session.reactionImagePath || !session.punchline) {
        await this.sendTextMessage(from, 'Some of your pictures are missing, so I cannot retry. Send *Manual* to start again.');
        return;
      }
      await this.generateManualMeme(session, from);
      return;
    }
    if (!session.referenceImagePath || !session.reactionImagePath || !session.punchline) {
      await this.sendTextMessage(from, 'Some of your inputs are missing, so I cannot retry. Send a *reference meme screenshot* to start again.');
      return;
    }
    session.state = 'GENERATING';
    await session.save();
    await this.sendTextMessage(from, GENERATING_VIRAL_TEXT);
    await this.generateAndSendMeme(session, from);
  }

  private static readonly IMAGE_STATES = ['IDLE', 'AWAITING_REACTION', 'MANUAL_SUBJECTS', 'MANUAL_REACTION', 'AWAITING_SLOT_IMAGE', 'LAYOUT_EXAMPLE', 'AWAITING_FRAMING', 'LIBRARY_FOLDERS', 'LIBRARY_PICK'];
  private readonly qualityTipShown = new Set<string>();

  /** True when the bot is waiting for a picture, so a pasted link is treated as one. */
  private expectsImage(session: WhatsAppSessionDocument): boolean {
    return WhatsAppService.IMAGE_STATES.includes(session.state);
  }

  /**
   * One entry point for every picture, whether it arrives as a WhatsApp photo, a document
   * (JPG/PNG/WebP/HEIC/PDF) or a link: downloads, verifies and converts it, then routes it by state.
   */
  private async receiveImage(
    session: WhatsAppSessionDocument,
    from: string,
    source: { mediaId?: string; url?: string },
    caption: string,
    compressedPhoto: boolean
  ): Promise<void> {
    try {
      // Busy: say so (a picture that is silently ignored looks like a lost message) and do not download it
      if (session.state === 'GENERATING') {
        await this.sendTextMessage(from, '⏳ I am making your meme right now, so I did not use that picture. Send it again once the meme arrives, or *Reset* to stop.');
        return;
      }
      if (session.state === 'LAYOUT_ANALYZING') {
        await this.sendTextMessage(from, '📐 I am still learning the last layout, so I did not use that picture. Send it again in a moment.');
        return;
      }

      const downloaded = source.url ? await this.downloadImageFromUrl(source.url) : await this.downloadMedia(String(source.mediaId));

      if (downloaded.convertedFrom === 'pdf') {
        await this.sendTextMessage(from, `📄 Using page 1 of your PDF (${downloaded.width}x${downloaded.height}px).`);
      }

      if (session.state === 'AWAITING_APPROVAL') {
        await this.handleReplacementImage(session, from, downloaded, caption);
        return;
      }
      // WhatsApp shrinks normal photos to about 1600 px; the same file sent as a Document keeps full quality.
      if (compressedPhoto && session.state !== 'IDLE' && Math.max(downloaded.width, downloaded.height) <= 1700 && !this.qualityTipShown.has(from)) {
        this.qualityTipShown.add(from);
        await this.sendTextMessage(
          from,
          `💡 *Tip:* WhatsApp compressed that photo to ${downloaded.width}x${downloaded.height}px. ` +
          `For full quality send pictures as a *Document* (📎 → Document) or paste a direct image link.`
        );
      }

      // A picture sent while the library or the frame question is open is a new reaction picture: carry on from there
      if (session.state === 'AWAITING_FRAMING') session.state = session.framingNext === 'manual' ? 'MANUAL_REACTION' : 'AWAITING_REACTION';
      else if (session.state === 'LIBRARY_FOLDERS' || session.state === 'LIBRARY_PICK') session.state = (session.libraryBack as any) || 'AWAITING_REACTION';

      if (session.state === 'LAYOUT_EXAMPLE') {
        await this.handleLayoutExample(session, from, downloaded, caption);
        return;
      }

      if (this.isManualState(session)) {
        await this.handleManualImage(session, from, downloaded, caption);
        return;
      }

      if (session.state === 'AWAITING_SLOT_IMAGE') {
        await this.handleSlotImage(session, from, downloaded);
        return;
      }

      if (session.state === 'IDLE') {
        session.viralDraftId = null;
        session.viralSlots = [];
        session.viralOverrides = [];
        session.viralMissing = [];
        session.referenceImagePath = downloaded.filePath;
        session.referenceMimeType = downloaded.mimeType;

        // If user also attached a punchline caption to the image
        if (caption) {
          session.punchline = caption;
          session.state = 'AWAITING_REACTION';
          await session.save();

          await this.sendTextMessage(
            from,
            `📸 *Reference meme received!* (Caption: "${caption}")\n\n` +
            `Now please send the *Reaction Image* (e.g. reacting actor/character photo).` + (await this.libraryHint())
          );
        } else {
          session.state = 'AWAITING_REACTION';
          await session.save();

          await this.sendTextMessage(
            from,
            `📸 *Reference meme received!*\n\n` +
            `Now please send the *Reaction Image* (e.g. Brahmanandam, Pawan Kalyan photo).` + (await this.libraryHint())
          );
        }
        return;
      }

      if (session.state === 'AWAITING_REACTION' || session.state === 'AWAITING_PUNCHLINE') {
        const replacing = session.state === 'AWAITING_PUNCHLINE';
        session.reactionImagePath = downloaded.filePath;
        session.reactionMimeType = downloaded.mimeType;
        session.reactionLibraryId = null; // a picture sent by hand, not one from the library
        session.reactionFraming = null; // not decided yet: a stacked picture asks

        // If punchline was attached to the reaction image or previously set
        if (caption) session.punchline = caption;

        // A stacked picture asks which frame first; then generation (when the punchline is known) or the punchline question
        await this.afterReaction(session, from, 'viral', { updated: replacing });
        return;
      }

      // A state a picture has no place in (waiting for a retry, for a new punchline, a layout name...): say what is expected
      await this.nudge(session, from);
    } catch (err: any) {
      this.logger.error(`Failed to handle WhatsApp image: ${err?.message || err}`);
      await this.sendTextMessage(from, `❌ I could not use that picture: ${err?.message || 'download error'}\nPlease send it again (as a Document for full quality).`);
    }
  }

  /**
   * Replaces an image (subject or reaction) for a meme awaiting approval in WhatsApp.
   * Supports both manual memes and viral adaptation memes.
   */
  private async handleReplacementImage(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: ReceivedImage,
    caption: string
  ): Promise<void> {
    const lowerCap = (caption || '').toLowerCase().trim();
    const isReaction = lowerCap.includes('reaction') || lowerCap.includes('react');

    // Slot number for subject images: e.g. "replace 2", "slot 2", "2", default 1
    const slotMatch = lowerCap.match(/(?:slot|image|replace|\b)([1-9]\d?)\b/);
    const requestedSlot = slotMatch ? parseInt(slotMatch[1], 10) : 1;

    // A) MANUAL MEME FLOW
    if (session.mode === 'manual') {
      if (isReaction) {
        session.reactionImagePath = downloaded.filePath;
        session.reactionMimeType = downloaded.mimeType;
        session.reactionLibraryId = null;
        session.reactionFraming = null;
        await session.save();
        await this.sendTextMessage(from, '🔄 Replacing reaction image and re-rendering meme...');
        await this.generateManualMeme(session, from);
        return;
      }

      // Subject image replacement
      if (!session.manualSubjects) session.manualSubjects = [];
      const count = session.manualSubjects.length;
      const targetIdx = count > 0 ? Math.min(requestedSlot - 1, count - 1) : 0;
      const prevLabel = session.manualSubjects[targetIdx]?.label;
      const newLabel = caption && !lowerCap.includes('replace') ? caption : prevLabel;

      session.manualSubjects[targetIdx] = {
        path: downloaded.filePath,
        mimeType: downloaded.mimeType,
        label: newLabel
      };

      // Check aspect ratio if not explicitly chosen (>0.82 fits inside tall side-by-side slot)
      const aspect = (downloaded.width || 1) / (downloaded.height || 1);
      if (downloaded.width && downloaded.height && aspect > 0.82 && !session.manualSubjectFit) {
        session.manualSubjectFit = 'contain';
      }

      if (typeof (session as any).markModified === 'function') {
        (session as any).markModified('manualSubjects');
      }
      await session.save();
      await this.sendTextMessage(from, `🔄 Replacing subject image ${targetIdx + 1} and re-rendering meme...`);
      await this.generateManualMeme(session, from);
      return;
    }

    // B) VIRAL ADAPTATION FLOW
    if (isReaction) {
      session.reactionImagePath = downloaded.filePath;
      session.reactionMimeType = downloaded.mimeType;
      session.reactionLibraryId = null;
      session.reactionFraming = null;
      session.state = 'GENERATING';
      await session.save();
      await this.sendTextMessage(from, '🔄 Replacing reaction image and re-adapting meme...');
      await this.generateAndSendMeme(session, from);
      return;
    }

    // Viral subject replacement via memeEngine.applyImageReplacement
    if (session.lastGeneratedMemeId) {
      try {
        await this.sendTextMessage(from, `🔄 Replacing subject image ${requestedSlot}...`);
        const staged = await this.selection.stageUpload(downloaded.filePath, path.basename(downloaded.filePath));
        const updatedMeme = await this.memeEngine.applyImageReplacement(
          session.lastGeneratedMemeId,
          [{ slot: requestedSlot, token: staged.token }]
        );
        await this.deliverMeme(
          session,
          from,
          updatedMeme,
          updatedMeme.content?.punchline || session.punchline || '',
          { keepCaption: true } // swapping a picture does not change the caption the owner may have written
        );
        return;
      } catch (err: any) {
        this.logger.error(`Error replacing image in WhatsApp viral meme: ${err?.message || err}`);
        await this.sendTextMessage(
          from,
          `⚠️ Could not replace image: ${err?.message || err}\n\n` +
          `Reply *Approve* to keep the current meme, or *Reset* to start fresh.`
        );
        return;
      }
    }

    await this.sendTextMessage(
      from,
      '⚠️ No active meme session found to replace an image on. Send a new reference meme or type *Manual*.'
    );
  }

  /**
   * Executes the Viral Adaptation pipeline and sends the rendered meme back to the user
   */
  /**
   * Viral flow. The reference is analysed once and the analysis is kept (draft); if internet discovery
   * cannot find a verified picture for a slot, the user is asked to send one and the run continues with
   * that picture instead of failing.
   */
  private async generateAndSendMeme(session: WhatsAppSessionDocument, to: string): Promise<void> {
    // From here the meme takes minutes: let the person's next message through (status, reset) while it is made
    const run = this.beginRun(to, 'viral');
    this.yieldLane();
    const stopWatching = this.watchRun(to, run);
    const voice = this.runVoice(to, run);
    try {
      if (!session.referenceImagePath || !session.reactionImagePath || !session.punchline) {
        throw new Error('Missing reference image, reaction image, or punchline');
      }
      this.logger.log(`Starting viral adaptation for WhatsApp user ${to}...`);

      let meme: any;
      let adaptation: any;
      for (let attempt = 0; ; attempt++) {
        if (!session.viralDraftId) {
          run.stage = STAGE_WORDS.analysis;
          voice.say('📖 Reading your reference screenshot…');
          await this.analyzeReference(session);
        }
        try {
          adaptation = await this.viralAdaptation.adapt({
            draftId: session.viralDraftId as string,
            overrides: await this.stageOverrides(session),
            reaction: this.uploadOf(session.reactionImagePath, session.reactionMimeType),
            punchline: session.punchline,
            reactionContext: session.reactionContext || undefined,
            reactionFraming: (session.reactionFraming as ReactionFraming | null) || undefined,
            onProgress: voice.sink
          });
          meme = adaptation.meme;
          break;
        } catch (err: any) {
          // The saved analysis expires after 30 minutes: analyse again once and retry
          if (err instanceof GoneException && attempt === 0) {
            session.viralDraftId = null;
            continue;
          }
          throw err;
        }
      }

      // Reset was sent while it was being made: the meme is saved in the studio, but nothing is delivered into the fresh chat
      await voice.drain();
      if (run.cancelled) {
        this.logger.log(`WhatsApp run for ${to} was cancelled; the finished meme is saved in the studio but not delivered.`);
        return;
      }

      session.viralDraftId = null;
      session.viralOverrides = [];
      session.viralMissing = [];
      this.noteLibraryUse(session);
      await this.deliverMeme(session, to, meme, session.punchline);
      if (adaptation?.adaptationMetadata?.layoutFormat?.newlyLearned) {
        await this.sendTextMessage(to, '📐 I learned a new layout from that reference. Send *Layouts* to see it and give it a name.');
      }
    } catch (err: any) {
      await voice.drain();
      if (run.cancelled) return;
      const missing = this.missingSlotsFromError(err, new Set((session.viralOverrides || []).map(o => o.slot)), session);
      if (missing.length) {
        this.logger.warn(`Discovery needs a picture from the user for slot(s) ${missing.join(', ')}: ${err?.message || err}`);
        session.viralMissing = missing;
        session.state = 'AWAITING_SLOT_IMAGE';
        await session.save();
        await this.askForSlotImage(session, to);
        return;
      }
      this.logger.error(`Error in WhatsApp meme generation: ${err?.message || err}`);
      // every input is kept: "Retry" runs it again, a new punchline text runs it with that punchline
      session.viralDraftId = null;
      session.viralOverrides = [];
      session.viralMissing = [];
      session.state = 'AWAITING_RETRY';
      await session.save();
      await this.sendTextMessage(
        to,
        `❌ *I could not make that meme:*\n${err?.message || 'Internal processing error'}\n\n` +
        `Your pictures and punchline are saved. Send *Retry* to try again, a new *punchline* to try it with that, or *Reset* to start over.`
      );
    } finally {
      stopWatching();
      this.endRun(to, run);
    }
  }

  /**
   * What the bot says while a viral meme is made: a few short messages from the pipeline's real stages (who was
   * identified, each picture as it is found), in order and never after the meme itself. Nothing is estimated.
   */
  private runVoice(to: string, run: Run): { say: (text: string) => void; sink: ProgressSink; drain: () => Promise<unknown> } {
    let chain: Promise<unknown> = Promise.resolve();
    const say = (text: string) => {
      chain = chain
        .then(async () => {
          if (run.cancelled) return;
          run.lastSaid = Date.now();
          await this.sendTextMessage(to, text);
        })
        .catch(() => undefined);
    };
    const subjects = new Map<string, string>();
    let found = 0;
    let told = false;
    const sink: ProgressSink = e => {
      if (e.type === 'stage') {
        if (e.state === 'active') run.stage = STAGE_WORDS[e.stage] || run.stage;
        if (e.stage === 'identity' && e.state === 'done' && e.note && e.note !== 'Pictures chosen by you') {
          say(`🔎 I know who is who: ${e.note}.\nNow finding verified pictures…`);
        }
        if (e.stage === 'discovery' && e.state === 'done' && !told) {
          told = true;
          say('🎨 All pictures found. Setting your punchline…');
        }
      } else if (e.type === 'slots') {
        e.slots.forEach(s => subjects.set(s.slotId, s.subject));
      } else if (e.type === 'slot' && e.state === 'found') {
        found++;
        const total = subjects.size;
        // the last one is followed by the "all found" line, so it is not announced twice
        if (!total || found < total) say(`🖼️ Picture ${found}${total ? ` of ${total}` : ''} found: ${subjects.get(e.slotId) || 'verified'} ✅`);
      }
    };
    return { say, sink, drain: () => chain };
  }

  private uploadOf(filePath: string, mimeType: string | null | undefined) {
    const filename = path.basename(filePath);
    return { path: filePath, filename, originalName: filename, mimeType: mimeType || 'image/jpeg' };
  }

  /** Analyses the reference once and remembers its image slots (for the "send me a picture" questions). */
  private async analyzeReference(session: WhatsAppSessionDocument): Promise<void> {
    const draft = await this.viralAdaptation.analyzeDraft(this.uploadOf(session.referenceImagePath as string, session.referenceMimeType));
    const previous = session.viralSlots?.length || 0;
    session.viralDraftId = draft.draftId;
    session.viralSlots = (draft.slots || []).map((s: any) => ({ slot: s.slot, label: s.label || undefined, subject: s.subject || undefined }));
    // A re-analysis that finds a different number of image slots makes earlier slot numbers meaningless
    if (previous && previous !== session.viralSlots.length) session.viralOverrides = [];
    await session.save();
  }

  /** The user's pictures for slots, staged again for this run (staging expires after 15 minutes). */
  private async stageOverrides(session: WhatsAppSessionDocument): Promise<{ slot: number; token: string }[]> {
    const out: { slot: number; token: string }[] = [];
    for (const o of session.viralOverrides || []) {
      const st = await this.selection.stageUpload(o.path, path.basename(o.path));
      out.push({ slot: o.slot, token: st.token });
    }
    return out;
  }

  /** Slots the user must supply a picture for, taken from a discovery or identity failure (empty for any other error). */
  private missingSlotsFromError(err: any, alreadyGiven: Set<number>, session?: WhatsAppSessionDocument): number[] {
    const response = typeof err?.getResponse === 'function' ? err.getResponse() : err?.response;
    const details = response?.details || err?.details;

    // 1. Check structured discovery details
    if (details?.stage === 'discovery') {
      const rawSlot = String(details.failedSlot ?? '');
      const m = /(?:s|slot[ _]?)?(\d+)/i.exec(rawSlot);
      if (m) {
        const slotNum = Number(m[1]);
        if (!alreadyGiven.has(slotNum)) return [slotNum];
      }
    }

    // 2. Check unresolved identity slots
    if (details?.stage === 'identity' && Array.isArray(details.slots)) {
      const unres = details.slots
        .filter((s: any) => s.status !== 'resolved' && !alreadyGiven.has(Number(s.slot)))
        .map((s: any) => Number(s.slot));
      if (unres.length) return unres;
    }

    // 3. Fallback: Parse error message text (e.g. "Could not find a verified portrait of 'Dulquer Salmaan'... for slot 1")
    const msg = String(err?.message || response?.message || '');
    if (/Could not find a verified|unverified image|no image found|failed to find/i.test(msg)) {
      const slotMatch = /(?:for|in)\s+slot\s+(\d+)/i.exec(msg) || /slot\s+(\d+)/i.exec(msg) || /image\s+(\d+)/i.exec(msg);
      if (slotMatch) {
        const slotNum = Number(slotMatch[1]);
        if (!alreadyGiven.has(slotNum)) {
          // Extract subject name from quotes (e.g. "Dulquer Salmaan") to display in prompt
          const subMatch = /of\s+"([^"]+)"/i.exec(msg);
          if (subMatch && subMatch[1] && session) {
            const existing = (session.viralSlots || []).find(s => s.slot === slotNum);
            if (existing) {
              existing.subject = subMatch[1];
            } else {
              session.viralSlots = [...(session.viralSlots || []), { slot: slotNum, subject: subMatch[1] }];
            }
          }
          return [slotNum];
        }
      }
    }

    return [];
  }

  private async askForSlotImage(session: WhatsAppSessionDocument, to: string, reminder = false): Promise<void> {
    const slot = session.viralMissing?.[0];
    const info = (session.viralSlots || []).find(s => s.slot === slot);
    const subjectName = info?.subject || (info?.label && info.label !== info?.subject ? info.label : undefined);
    const targetDesc = subjectName ? `"${subjectName}" (Image ${slot})` : `Image ${slot}`;

    await this.sendTextMessage(
      to,
      (reminder ? '' : `🔍 *Could not find a verified photo online for ${targetDesc}.*\n\n`) +
      `📸 *Please send a photo of ${subjectName ? `"${subjectName}"` : `Image ${slot}`}* right here in this chat, and I will use it to complete your meme!\n\n` +
      ((session.viralMissing?.length || 0) > 1 ? `_(${session.viralMissing.length} pictures needed in total)_\n\n` : '') +
      `Reply *Reset* to start fresh anytime.`
    );
  }

  private async handleSlotImage(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: { filePath: string }
  ): Promise<void> {
    const slot = session.viralMissing?.[0];
    if (!slot) {
      session.state = 'IDLE';
      await session.save();
      return;
    }
    try {
      // Same checks as a picture chosen in the web app (real image, size limits, decodes)
      const staged = await this.selection.stageUpload(downloaded.filePath, path.basename(downloaded.filePath));
      this.selection.discard(staged.token);
    } catch (err: any) {
      await this.sendTextMessage(from, `⚠️ That picture cannot be used: ${err?.message || 'invalid image'}\nPlease send another one for image ${slot}.`);
      return;
    }
    session.viralOverrides = [...(session.viralOverrides || []).filter(o => o.slot !== slot), { slot, path: downloaded.filePath }];
    session.viralMissing = (session.viralMissing || []).slice(1);
    if (session.viralMissing.length) {
      await session.save();
      await this.sendTextMessage(from, `✅ Picture for image ${slot} saved.`);
      await this.askForSlotImage(session, from);
      return;
    }
    session.state = 'GENERATING';
    await session.save();
    await this.sendTextMessage(from, `✅ Got it. Continuing with your picture... this takes about 30 seconds.`);
    await this.generateAndSendMeme(session, from);
  }

  /** Sends the rendered meme to the user for review and moves the session to AWAITING_APPROVAL. */
  private async deliverMeme(session: WhatsAppSessionDocument, to: string, meme: any, punchlineText: string, opts: { keepCaption?: boolean } = {}): Promise<void> {
    // Construct public HTTPS image URL for Meta WhatsApp
    const relativeImageUrl = meme.outputUrls?.jpeg || meme.outputUrls?.png;
    const publicBase = getConfig().instagram.publicBaseUrl;
    const publicImageUrl = relativeImageUrl
      ? `${publicBase}${relativeImageUrl}`
      : `${publicBase}/output/${meme.memeId}.jpeg`;

    this.logger.log(`Generated meme public URL for WhatsApp: ${publicImageUrl}`);

    const headline = meme.content?.headline || '';
    const punchline = punchlineText;
    const memeId: string | null = meme.memeId || (meme._id ? meme._id.toString() : null);

    // The Instagram caption is the studio's: punchline, headline, topic, follow line, hashtags (an own caption survives image swaps)
    const caption = opts.keepCaption && session.lastGeneratedCaption ? session.lastGeneratedCaption : buildCaption(meme.content || { punchline });

    const fitHint = session.mode === 'manual'
      ? `👉 *${session.manualSubjectFit === 'contain' ? 'Fill' : 'Fit'}* — Switch to ${session.manualSubjectFit === 'contain' ? 'Fill & Crop' : 'Fit Whole Image (No Crop)'}\n`
      : '';

    // The same words when the buttons cannot be shown
    const previewCaption =
      `🎭 *Meme Ready for Review!*\n\n` +
      (headline ? `📌 *Headline*: ${headline}\n` : '') +
      `💬 *Punchline*: ${punchline}\n\n` +
      `Reply:\n` +
      fitHint +
      `👉 *Approve* — Publish to Instagram (@kanyaraasi_memes)\n` +
      `👉 Send a new photo to *replace* image (or caption "replace reaction")\n` +
      `👉 *Reset* — Discard this meme`;

    // The message under the picture: the meme's words, the caption it will go out with, and three buttons
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const buttonBody =
      `🎭 *Your meme is ready*\n\n` +
      (headline ? `📌 ${clip(headline, 120)}\n` : '') +
      `💬 ${clip(punchline, 260)}\n\n` +
      `📝 Caption ready for Instagram. Send *Caption: your text* to change it.\n` +
      (session.mode === 'manual' ? `Send *${session.manualSubjectFit === 'contain' ? 'Fill' : 'Fit'}* to change the cropping. ` : '') +
      `Send a photo to replace an image.`;

    // Send image preview to user: uploaded to WhatsApp itself, so it arrives even when the server's public address is not reachable
    const localFile: string | undefined = meme.outputPaths?.jpeg || meme.outputPaths?.png;
    const pic = { filePath: localFile, mimeType: localFile && /\.png$/i.test(localFile) ? 'image/png' : 'image/jpeg', url: publicImageUrl };
    let sent = memeId ? await this.sendImageWithButtons(to, pic, buttonBody, this.reviewButtons(memeId)) : false;
    if (!sent) sent = await this.sendPicture(to, pic, previewCaption);
    if (!sent) {
      // Fallback to text with link if image send fails
      await this.sendTextMessage(to, `🎭 *Meme Ready!*\nView image: ${publicImageUrl}\n\n${previewCaption}`);
    }

    session.state = 'AWAITING_APPROVAL';
    session.lastGeneratedMemeId = memeId;
    session.lastGeneratedImageUrl = publicImageUrl;
    session.lastGeneratedCaption = caption;
    await session.save();

    this.logger.log(`Generated meme ${session.lastGeneratedMemeId} sent to WhatsApp user ${to}`);
  }

  // ---------------------------------------------------------------------------------------------
  // The finished meme: Publish / Change punchline / Discard (taps, or the same words typed)
  // ---------------------------------------------------------------------------------------------

  /** The three buttons. The id carries the meme, so a tap on an older meme's buttons never acts on a newer one. */
  private reviewButtons(memeId: string): { id: string; title: string }[] {
    return [
      { id: `pub:${memeId}`, title: '✅ Publish' },
      { id: `pl:${memeId}`, title: 'Change punchline' },
      { id: `no:${memeId}`, title: '🗑️ Discard' }
    ];
  }

  /** The buttons again, without the picture (after a question or a change), or plain words when buttons cannot be sent. */
  private async sendReviewActions(session: WhatsAppSessionDocument, to: string): Promise<void> {
    if (!session.lastGeneratedMemeId) return;
    const sent = await this.sendButtonsMessage(to, 'What next for this meme?', this.reviewButtons(session.lastGeneratedMemeId));
    if (!sent) await this.sendTextMessage(to, 'What next? *Approve* publishes it to Instagram, *Reset* discards it, or send a photo to replace an image.');
  }

  /** Posts the meme waiting for approval to Instagram with its caption. Only ever reached by "Approve"/"Publish" or the Publish button. */
  private async publishCurrent(session: WhatsAppSessionDocument, from: string): Promise<void> {
    if (!session.lastGeneratedMemeId) return;
    await this.sendTextMessage(from, '🚀 *Publishing to Instagram (@kanyaraasi_memes)...* Please wait 10-20 seconds.');
    try {
      const pubResult = await this.instagramPublisher.publishMeme(
        session.lastGeneratedMemeId,
        undefined,
        session.lastGeneratedCaption || buildCaption({ punchline: session.punchline || '' }) || 'Meme by @kanyaraasi_memes'
      );

      await this.sendTextMessage(
        from,
        `🎉 *Successfully Published to Instagram!*\n\n` +
        `📱 Account: *@${pubResult.username || 'kanyaraasi_memes'}*\n` +
        `🔗 View Post: ${pubResult.permalink || 'https://www.instagram.com/kanyaraasi_memes'}\n\n` +
        `Send a new reference meme anytime to create your next post! 🚀`
      );

      await this.resetSession(session);
    } catch (err: any) {
      this.logger.error(`Instagram publish error via WhatsApp: ${err?.message || err}`);
      await this.sendTextMessage(from, `❌ *Publishing to Instagram Failed:*\n${err?.message || err}\n\nTap *Publish* (or send *Approve*) to retry, or *Reset* to discard.`);
      if (session.state === 'AWAITING_APPROVAL') await this.sendReviewActions(session, from);
    }
  }

  /** A tap on Publish / Change punchline / Discard under a finished meme (`pub:<memeId>` | `pl:<memeId>` | `no:<memeId>`). */
  private async answerReviewButton(session: WhatsAppSessionDocument, from: string, id: string): Promise<void> {
    const cut = id.indexOf(':');
    const action = id.slice(0, cut);
    const memeId = id.slice(cut + 1);
    const waiting = session.state === 'AWAITING_APPROVAL' || session.state === 'AWAITING_NEW_PUNCHLINE';
    if (!waiting || !session.lastGeneratedMemeId || session.lastGeneratedMemeId !== memeId) {
      await this.sendTextMessage(from, 'ℹ️ That button belongs to an older meme, so I ignored it. Send *Status* to see where we are.');
      if (session.state === 'AWAITING_APPROVAL') await this.sendReviewActions(session, from);
      return;
    }
    if (action === 'pub') {
      await this.publishCurrent(session, from);
    } else if (action === 'pl') {
      session.state = 'AWAITING_NEW_PUNCHLINE';
      await session.save();
      await this.sendTextMessage(from, '✏️ Send the *new punchline*, exactly as you want it on the meme. (It is used as typed. *Cancel* keeps the old one.)');
    } else if (action === 'no') {
      this.cancelRun(from);
      await this.resetSession(session);
      await this.sendTextMessage(from, '🗑️ Discarded. It stays in *My Memes* in the studio if you want it later. Send a *reference meme screenshot* to start a new one.');
    }
  }

  /** The new punchline typed after "Change punchline": same pictures and style, re-rendered as the meme's next version. */
  private async applyNewPunchline(session: WhatsAppSessionDocument, from: string, text: string): Promise<void> {
    if (!session.lastGeneratedMemeId) {
      await this.resetSession(session);
      await this.sendTextMessage(from, 'I no longer have that meme. Send a *reference meme screenshot* to start again.');
      return;
    }
    await this.sendTextMessage(from, '✏️ Changing the punchline…');
    try {
      const updated: any = await this.memeEngine.changePunchline(session.lastGeneratedMemeId, text);
      const words = String(updated?.content?.punchline ?? text.trim());
      session.punchline = words;
      await this.deliverMeme(session, from, updated, words);
    } catch (err: any) {
      session.state = 'AWAITING_APPROVAL';
      await session.save();
      await this.sendTextMessage(from, `⚠️ I could not change the punchline: ${err?.response?.message || err?.message || err}\nThe meme is as it was.`);
      await this.sendReviewActions(session, from);
    }
  }

  /**
   * An interactive message with up to three reply buttons (titles up to 20 characters), optionally under a picture.
   * Returns false when it could not be sent, so the caller can fall back to plain words.
   */
  async sendButtonsMessage(
    to: string,
    body: string,
    buttons: { id: string; title: string }[],
    header?: { type: 'image'; image: { id?: string; link?: string } }
  ): Promise<boolean> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) return false;
    try {
      const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(header ? { header } : {}),
            body: { text: body.slice(0, 1024) },
            action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) }
          }
        })
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.warn(`Could not send WhatsApp buttons (using plain words instead): ${JSON.stringify(errJson)}`);
        this.credentials?.noteSendResult(errJson);
        return false;
      }
      this.credentials?.noteSendResult(null);
      return true;
    } catch (err: any) {
      this.logger.warn(`Error sending WhatsApp buttons: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * An approved template message: delivered even outside the 24-hour window that free-form messages need. `body` fills
   * the template's {{1}}, {{2}}... in order; `buttonPayloads` give its quick-reply buttons their payloads, in order.
   */
  async sendTemplateMessage(to: string, name: string, language: string, body: string[], buttonPayloads: string[] = []): Promise<boolean> {
    const cfg = await this.currentCredentials();
    if (!cfg.accessToken || !cfg.phoneNumberId) return false;
    try {
      const components: any[] = [];
      if (body.length) components.push({ type: 'body', parameters: body.map(text => ({ type: 'text', text: String(text).slice(0, 300) })) });
      buttonPayloads.forEach((payload, index) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: payload.slice(0, 256) }] }));
      const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name, language: { code: language }, components } })
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.warn(`Could not send WhatsApp template "${name}": ${JSON.stringify(errJson)}`);
        this.credentials?.noteSendResult(errJson);
        return false;
      }
      this.credentials?.noteSendResult(null);
      return true;
    } catch (err: any) {
      this.logger.warn(`Error sending WhatsApp template "${name}": ${err?.message || err}`);
      return false;
    }
  }

  /** A picture with buttons under it: uploaded to WhatsApp first (no public address needed), its link only if that fails. */
  async sendImageWithButtons(
    to: string,
    pic: { buffer?: Buffer; filePath?: string; mimeType?: string; url: string },
    body: string,
    buttons: { id: string; title: string }[]
  ): Promise<boolean> {
    let image: { id?: string; link?: string } = { link: pic.url };
    try {
      const buffer = pic.buffer ?? (pic.filePath ? await fs.promises.readFile(pic.filePath) : null);
      if (buffer && buffer.length > 0 && buffer.length <= 5 * 1024 * 1024) {
        const mime = pic.mimeType || 'image/jpeg';
        const id = await this.uploadMedia(buffer, mime, mime === 'image/png' ? 'picture.png' : 'picture.jpg');
        if (id) image = { id };
      }
    } catch (err: any) {
      this.logger.warn(`Could not upload the picture for the buttons message (${err?.message || err}); using its link.`);
    }
    return this.sendButtonsMessage(to, body, buttons, { type: 'image', image });
  }

  // ---------------------------------------------------------------------------------------------
  // Manual (own edit) flow: layout -> headline -> statement -> subject images (+labels) -> reaction -> punchline
  // ---------------------------------------------------------------------------------------------

  private static readonly MANUAL_TYPES = ['trending_news', 'facts_collage', 'comparison', 'movie_update', 'custom'] as const;
  private static readonly MAX_MANUAL_SUBJECTS = 10;

  private isManualState(session: WhatsAppSessionDocument): boolean {
    return session.mode === 'manual' && typeof session.state === 'string' && session.state.startsWith('MANUAL_');
  }

  private manualTypePrompt(layouts: FormatSummary[] = []): string {
    return (
      `✏️ *Manual meme*\n\n` +
      `Pick a layout (send the number):\n` +
      `1️⃣ News / update (default)\n` +
      `2️⃣ Facts collage\n` +
      `3️⃣ Comparison\n` +
      `4️⃣ Movie update\n` +
      `5️⃣ Custom\n` +
      (layouts.length
        ? `\n📐 *Your saved layouts:*\n` + layouts.map((l, i) => `${WhatsAppService.MANUAL_TYPES.length + i + 1}. ${l.name ? `*${l.name}*` : `_${l.displayName}_`} — ${l.description}`).join('\n') + `\n`
        : '') +
      `\nSend *skip* for the default. *Reset* cancels anytime.`
    );
  }

  private isSkip(text: string): boolean {
    return ['skip', 'none', 'no', '-'].includes(text.trim().toLowerCase());
  }

  private async handleManualText(session: WhatsAppSessionDocument, from: string, text: string): Promise<void> {
    switch (session.state) {
      case 'MANUAL_TYPE': {
        const builtIn = WhatsAppService.MANUAL_TYPES;
        const n = Number(text.trim());
        const saved = Number.isInteger(n) && n > builtIn.length ? await this.formats.getByPosition(n - builtIn.length) : null;
        if (this.isSkip(text)) {
          session.manualMemeType = builtIn[0];
        } else if (Number.isInteger(n) && n >= 1 && n <= builtIn.length) {
          session.manualMemeType = builtIn[n - 1];
        } else if (saved) {
          session.manualMemeType = saved.memeType;
          session.manualFormatId = saved.formatId;
          session.manualSlotCount = saved.slotCount;
        } else {
          const total = builtIn.length + (await this.formats.list()).length;
          await this.sendTextMessage(from, `Please send a number from 1 to ${total}, or *skip*.`);
          return;
        }
        await this.manualNextStep(session, from, 'type');
        return;
      }
      case 'MANUAL_HEADLINE':
        session.manualHeadline = this.isSkip(text) ? null : text;
        await this.manualNextStep(session, from, 'headline');
        return;
      case 'MANUAL_STATEMENT':
        session.manualStatement = this.isSkip(text) ? null : text;
        await this.manualNextStep(session, from, 'statement');
        return;
      case 'MANUAL_SUBJECTS': {
        const lower = text.trim().toLowerCase();
        if (['fit', 'contain', 'nocrop', 'no crop'].includes(lower)) {
          session.manualSubjectFit = 'contain';
          await session.save();
          await this.sendTextMessage(from, '✅ Set to *Fit Whole Image (No Crop)*. Send more images, or *done*.');
          return;
        }
        if (['fill', 'cover', 'crop'].includes(lower)) {
          session.manualSubjectFit = 'cover';
          await session.save();
          await this.sendTextMessage(from, '✅ Set to *Fill & Crop*. Send more images, or *done*.');
          return;
        }
        if (await this.subjectOrderCommand(session, from, text)) return;
        if (['done', 'next', 'finish'].includes(lower)) {
          if (!session.manualSubjects?.length) {
            await this.sendTextMessage(from, 'Please send at least one subject image first.');
            return;
          }
          if (session.manualSlotCount && session.manualSubjects.length < session.manualSlotCount) {
            await this.sendTextMessage(from, `This layout needs *${session.manualSlotCount}* images and I have ${session.manualSubjects.length}. Please send ${session.manualSlotCount - session.manualSubjects.length} more.`);
            return;
          }
          session.state = 'MANUAL_REACTION';
          await session.save();
          const framingNote = session.manualSubjectFit === 'contain' ? ' (Framing: *Fit Whole Image*)' : '';
          await this.sendSubjectSheet(session, from);
          await this.sendTextMessage(from, `🎭 ${session.manualSubjects.length} subject image(s) saved${framingNote}. Now send the *reaction image* (a caption becomes the punchline).` + (await this.libraryHint()));
          return;
        }
        await this.sendTextMessage(from, 'Send a subject image, or *done* when you have sent them all.');
        return;
      }
      case 'MANUAL_REACTION':
        // the order and the captions can still be fixed after the last picture
        if (await this.subjectOrderCommand(session, from, text)) return;
        await this.sendTextMessage(from, 'Please send the *reaction image*. (To change the subject pictures: *order 2 1 3 4*, *labels A | B | C*, or *show*.)' + (await this.libraryHint()));
        return;
      case 'MANUAL_PUNCHLINE':
        session.punchline = text;
        await this.generateManualMeme(session, from);
        return;
    }
  }

  private async handleManualImage(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: { filePath: string; mimeType: string },
    caption: string
  ): Promise<void> {
    if (session.state === 'MANUAL_SUBJECTS') {
      const cap = session.manualSlotCount || WhatsAppService.MAX_MANUAL_SUBJECTS;
      if ((session.manualSubjects?.length || 0) >= cap) {
        await this.sendTextMessage(from, `Maximum of ${cap} subject images reached. ${session.manualSlotCount ? 'Now send the *reaction image*.' : 'Send *done*.'}`);
        return;
      }

      // Auto-detect wide screenshot, tweet, or square image (aspect > 0.82) vs narrow side-by-side slot (~0.62)
      let isWide = false;
      const lowerCaption = (caption || '').trim().toLowerCase();
      if (['fit', 'contain', 'nocrop', 'no crop'].includes(lowerCaption)) {
        session.manualSubjectFit = 'contain';
        await session.save();
      } else {
        try {
          const img = await loadImage(downloaded.filePath);
          if (img?.width && img?.height && (img.width / img.height) > 0.82) {
            isWide = true;
            session.manualSubjectFit = 'contain';
            await session.save();
          }
        } catch {}
      }

      // Atomic push: several images can arrive in parallel webhooks.
      const updated = await this.sessionModel.findOneAndUpdate(
        { phoneNumber: from },
        { $push: { manualSubjects: { path: downloaded.filePath, mimeType: downloaded.mimeType, label: caption || undefined } } },
        { new: true }
      );
      const n = updated?.manualSubjects?.length || 0;
      const fitNote = (isWide || session.manualSubjectFit === 'contain')
        ? '\n📐 *Wide image detected:* Set to *Fit Whole Image (No Crop)* so edge text is not cut off. (Send *crop* if you want it filled).'
        : '';
      const added = `✅ Subject ${n} added${caption ? ` (label: "${caption}")` : ''}.${fitNote}`;
      if (session.manualSlotCount && n >= session.manualSlotCount) {
        // A saved layout has an exact number of images: continue by itself
        session.state = 'MANUAL_REACTION';
        await session.save();
        await this.sendSubjectSheet(updated || session, from);
        await this.sendTextMessage(from, `${added} That is all ${n} images.\n🎭 Now send the *reaction image* (a caption becomes the punchline).` + (await this.libraryHint()));
        return;
      }
      await this.sendTextMessage(from, `${added} ${session.manualSlotCount ? `${session.manualSlotCount - n} more to go.` : 'Send more, or *done*.'}`);
      return;
    }

    if (session.state === 'MANUAL_REACTION' || session.state === 'MANUAL_PUNCHLINE') {
      session.reactionImagePath = downloaded.filePath;
      session.reactionMimeType = downloaded.mimeType;
      session.reactionLibraryId = null;
      session.reactionFraming = null;
      if (caption) session.punchline = caption;
      await this.afterReaction(session, from, 'manual', {});
      return;
    }

    await this.sendTextMessage(from, 'I was expecting text here. Send the requested text, or *Reset* to cancel.');
  }

  private async generateManualMeme(session: WhatsAppSessionDocument, to: string): Promise<void> {
    const run = this.beginRun(to, 'manual');
    run.stage = STAGE_WORDS.render;
    session.state = 'GENERATING';
    await session.save();
    this.yieldLane();
    await this.sendTextMessage(to, '⏳ *Making your meme…* this takes a few seconds.');
    try {
      const subjects = session.manualSubjects || [];
      if (!subjects.length || !session.reactionImagePath || !session.punchline) {
        throw new Error('Missing subject images, reaction image or punchline');
      }
      // Same validation/limits as the web form's upload-and-generate endpoint.
      const memeType = session.manualMemeType || 'trending_news';
      const labels = subjects.map(s => (s.label || '').trim());
      const { content, design, layout } = validateUploadPayload(
        JSON.stringify({
          content: {
            topic: session.manualHeadline || session.manualStatement || 'WhatsApp meme',
            headline: session.manualHeadline || undefined,
            statement: session.manualStatement || undefined,
            punchline: session.punchline,
            itemLabels: labels
          },
          layout: { memeType, arrangement: 'auto' },
          subjectLabels: labels
        })
      );

      const subjectImages: UploadedAsset[] = subjects.map((s, idx) => ({
        id: randomUUID(),
        originalName: path.basename(s.path),
        filename: path.basename(s.path),
        path: s.path,
        mimeType: s.mimeType || 'image/jpeg',
        role: idx === 0 ? 'subject_primary' : idx === 1 ? 'subject_secondary' : 'subject_item',
        orderIndex: idx,
        label: labels[idx] || undefined
      }));
      const reactionImage: UploadedAsset = {
        id: randomUUID(),
        originalName: path.basename(session.reactionImagePath),
        filename: path.basename(session.reactionImagePath),
        path: session.reactionImagePath,
        mimeType: session.reactionMimeType || 'image/jpeg',
        role: 'reaction_punchline',
        orderIndex: 99
      };

      // A saved layout brings its grid and proportions; style (fonts, colours) still comes from Settings
      let finalLayout = layout;
      if (session.manualFormatId) {
        const saved = await this.formats.get(session.manualFormatId);
        if (saved) {
          finalLayout = { ...layout, ...FormatLibraryService.layoutFor(saved, Boolean(session.manualHeadline)) };
          this.formats.markUsed(saved.formatId).catch(() => undefined);
        }
      }

      const withFraming = session.reactionFraming ? { ...(design || {}), reactionFraming: session.reactionFraming as ReactionFraming } : design;
      const withFit = session.manualSubjectFit ? { ...(withFraming || {}), subjectFit: session.manualSubjectFit } : withFraming;
      const meme = await this.memeEngine.generateMeme({ content, assets: { subjectImages, reactionImage }, design: withFit as any, layout: finalLayout });
      if (run.cancelled) return; // Reset was sent meanwhile: the meme is saved in the studio, nothing is delivered
      this.noteLibraryUse(session);
      await this.deliverMeme(session, to, meme, session.punchline);
    } catch (err: any) {
      if (run.cancelled) return;
      this.logger.error(`Error in WhatsApp manual meme generation: ${err?.message || err}`);
      // the pictures and words are kept: "Retry" runs it again, a new punchline runs it with that
      session.state = 'AWAITING_RETRY';
      await session.save();
      await this.sendTextMessage(
        to,
        `❌ *I could not make that meme:*\n${err?.message || 'Internal processing error'}\n\n` +
        `Your pictures and words are saved. Send *Retry* to try again, a new *punchline* to try it with that, or *Reset* to start over.`
      );
    } finally {
      this.endRun(to, run);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reaction library and the "which frame?" question: the same flow as the studio, in a chat
  // ---------------------------------------------------------------------------------------------

  private static readonly LIBRARY_STATES = ['LIBRARY_FOLDERS', 'LIBRARY_PICK'];
  private static readonly REACTION_STATES = ['AWAITING_REACTION', 'AWAITING_PUNCHLINE', 'MANUAL_REACTION', 'MANUAL_PUNCHLINE'];

  /** One line offering the library when it holds something (empty text when it does not or is not available). */
  private async libraryHint(): Promise<string> {
    if (!this.reactions) return '';
    try {
      const { total } = await this.reactions.categories();
      return total ? `\n🗂️ Or send *Library* to pick one of your ${total} saved reactions.` : '';
    } catch {
      return '';
    }
  }

  /** The public address of a picture written to the output folder (WhatsApp fetches pictures from a public link). */
  private async writeSheet(buf: Buffer): Promise<string> {
    await fs.promises.mkdir(this.sheetDir, { recursive: true });
    // sheets are only needed for the chat in progress: forget the old ones
    try {
      for (const f of await fs.promises.readdir(this.sheetDir)) {
        if (!f.startsWith('wa_sheet_')) continue;
        const p = path.join(this.sheetDir, f);
        if (Date.now() - (await fs.promises.stat(p)).mtimeMs > 6 * 3600 * 1000) await fs.promises.unlink(p).catch(() => undefined);
      }
    } catch {
      /* nothing to tidy */
    }
    const name = `wa_sheet_${randomUUID()}.jpg`;
    await fs.promises.writeFile(path.join(this.sheetDir, name), buf);
    return `${getConfig().instagram.publicBaseUrl}/output/${name}`;
  }

  /** The reaction picture of this session, decoded and looked at (null when it cannot be read: then nothing is asked). */
  private async reactionLook(session: WhatsAppSessionDocument): Promise<{ img: any; a: ReactionAnalysis } | null> {
    if (!session.reactionImagePath) return null;
    try {
      const img = await loadImage(session.reactionImagePath);
      return { img, a: analyzeReactionImage(img) };
    } catch {
      return null;
    }
  }

  /** Counts the library picture as used once a meme was made with it (the studio's quick-pick row sorts by this). */
  private noteLibraryUse(session: WhatsAppSessionDocument): void {
    if (session.reactionLibraryId) this.reactions?.markUsed(session.reactionLibraryId).catch(() => undefined);
  }

  /**
   * Handles what is said while the library or the frame question is open, and opens the library on request.
   * Returns true when the message was handled.
   */
  private async handleReactionFlowText(session: WhatsAppSessionDocument, from: string, text: string, lower: string): Promise<boolean> {
    if (session.state === 'AWAITING_FRAMING') {
      await this.answerFraming(session, from, text);
      return true;
    }
    if (session.state === 'LIBRARY_FOLDERS') {
      await this.libraryFolderReply(session, from, text, lower);
      return true;
    }
    if (session.state === 'LIBRARY_PICK') {
      await this.libraryPickReply(session, from, text, lower);
      return true;
    }
    const m = /^(?:library|reactions?|reaction library|lib|my reactions?)(?:\s+(.+))?$/i.exec(text.trim());
    if (!m || !this.reactions) return false;
    if (session.state === 'IDLE') {
      await this.sendTextMessage(from, '🗂️ Send the *reference meme* screenshot first. After that, send *Library* to pick one of your saved reaction pictures.');
      return true;
    }
    if (!WhatsAppService.REACTION_STATES.includes(session.state)) return false;
    await this.openLibrary(session, from, m[1]);
    return true;
  }

  /** The folder list (or, with words, straight to a search). */
  private async openLibrary(session: WhatsAppSessionDocument, from: string, search?: string): Promise<void> {
    const library = this.reactions as ReactionLibraryService;
    if (!WhatsAppService.LIBRARY_STATES.includes(session.state)) session.libraryBack = session.state;
    const { categories, total } = await library.categories();
    if (!total) {
      await this.sendTextMessage(from, '🗂️ Your reaction library is empty. Add pictures in the studio (the *Reactions* page), then send *Library* again.');
      return;
    }
    if (search?.trim()) {
      await this.showLibrarySheet(session, from, { search: search.trim(), page: 0 });
      return;
    }
    const recent = (await library.list({ sort: 'recent', limit: 1, skip: 0 })).total;
    session.libraryFolders = categories.map(c => c.category);
    session.libraryRecent = recent > 0;
    session.state = 'LIBRARY_FOLDERS';
    await session.save();
    await this.sendTextMessage(from, folderListText(categories, total, recent));
  }

  /** Leaves the library and tells the user what is expected next. */
  private async closeLibrary(session: WhatsAppSessionDocument, from: string): Promise<void> {
    session.state = (session.libraryBack as any) || 'AWAITING_REACTION';
    session.libraryBack = null;
    await session.save();
    await this.sendTextMessage(from, '👍 Back to your meme. Send the *reaction image*' + (session.state.endsWith('PUNCHLINE') ? ' again, or the *punchline* text.' : '.') + (await this.libraryHint()));
  }

  private async libraryFolderReply(session: WhatsAppSessionDocument, from: string, text: string, lower: string): Promise<void> {
    if (['back', 'cancel', 'close', 'exit'].includes(lower)) {
      await this.closeLibrary(session, from);
      return;
    }
    const { categories } = await (this.reactions as ReactionLibraryService).categories();
    const r = parseFolderReply(text, categories, session.libraryRecent);
    if (r.kind === 'recent') await this.showLibrarySheet(session, from, { recent: true, page: 0 });
    else if (r.kind === 'folder') await this.showLibrarySheet(session, from, { folder: r.category, page: 0 });
    else await this.showLibrarySheet(session, from, { search: r.words, page: 0 });
  }

  private async libraryPickReply(session: WhatsAppSessionDocument, from: string, text: string, lower: string): Promise<void> {
    if (['back', 'folders', 'folder'].includes(lower)) {
      await this.openLibrary(session, from);
      return;
    }
    if (['close', 'exit'].includes(lower)) {
      await this.closeLibrary(session, from);
      return;
    }
    const where = { folder: session.libraryFolder || undefined, search: session.librarySearch || undefined, recent: session.libraryRecent };
    if (['more', 'next', 'n'].includes(lower)) {
      await this.showLibrarySheet(session, from, { ...where, page: (session.libraryPage || 0) + 1 });
      return;
    }
    if (['previous', 'prev', 'p'].includes(lower) && (session.libraryPage || 0) > 0) {
      await this.showLibrarySheet(session, from, { ...where, page: session.libraryPage - 1 });
      return;
    }
    const n = /^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : 0;
    if (n >= 1 && n <= (session.libraryIds?.length || 0)) {
      await this.pickFromLibrary(session, from, n);
      return;
    }
    await this.sendTextMessage(from, `Reply with a number from 1 to ${session.libraryIds?.length || 0}, *More* for the next page, *Back* for the folders, or *Close* to return to your meme.`);
  }

  /** One page of a folder, a search or the recently used, as a numbered picture sheet. */
  private async showLibrarySheet(
    session: WhatsAppSessionDocument,
    from: string,
    q: { folder?: string; search?: string; recent?: boolean; page: number }
  ): Promise<void> {
    const library = this.reactions as ReactionLibraryService;
    const { items, total } = await library.list({ category: q.folder, search: q.search, sort: q.recent ? 'recent' : 'newest', limit: SHEET_PAGE, skip: q.page * SHEET_PAGE });
    if (!items.length) {
      if (q.page > 0) {
        await this.sendTextMessage(from, 'That was the last page. Reply with a number, *Previous*, or *Back*.');
      } else {
        // stay at the folder list so the next reply is read as a folder or a new search
        if (!WhatsAppService.LIBRARY_STATES.includes(session.state)) session.libraryBack = session.state;
        session.state = 'LIBRARY_FOLDERS';
        await session.save();
        await this.sendTextMessage(from, `🔎 Nothing found${q.search ? ` for “${q.search}”` : ''}. Try another word or a folder, or reply *Back* to return to your meme.`);
      }
      return;
    }
    const thumbs = await library.thumbs(items.map(i => i.imageId));
    const pages = Math.max(1, Math.ceil(total / SHEET_PAGE));
    const title = q.recent ? 'Recently used' : q.folder ? q.folder : `Search: ${q.search}`;
    const sheet = await renderSheet(items.map(i => ({ image: thumbs.get(i.imageId)?.data ?? Buffer.alloc(0), label: i.name || undefined })), {
      title,
      subtitle: `${total} picture${total === 1 ? '' : 's'}${pages > 1 ? ` · page ${q.page + 1} of ${pages}` : ''}`
    });
    const url = await this.writeSheet(sheet);

    if (!WhatsAppService.LIBRARY_STATES.includes(session.state)) session.libraryBack = session.state;
    session.state = 'LIBRARY_PICK';
    session.libraryIds = items.map(i => i.imageId);
    session.libraryFolder = q.folder || null;
    session.librarySearch = q.search || null;
    session.libraryRecent = Boolean(q.recent);
    session.libraryPage = q.page;
    await session.save();

    const caption =
      `Reply with the *number* of the picture to use (1–${items.length}).` +
      (q.page + 1 < pages ? '\n*More* — next page' : '') +
      (q.page > 0 ? '\n*Previous* — previous page' : '') +
      '\n*Back* — folders · *Close* — return to your meme';
    const sent = await this.sendPicture(from, { buffer: sheet, mimeType: 'image/jpeg', url }, caption);
    if (!sent) await this.sendTextMessage(from, '⚠️ I could not send the picture sheet. Open the studio to pick from your library, or send the reaction picture here.');
  }

  /** The user chose picture `n` of the current sheet: it becomes the reaction image, exactly as if it had been sent. */
  private async pickFromLibrary(session: WhatsAppSessionDocument, from: string, n: number): Promise<void> {
    const id = session.libraryIds[n - 1];
    let file: { filePath: string; mimeType: string; category: string };
    try {
      file = await (this.reactions as ReactionLibraryService).materialize(id, this.mediaDir);
    } catch {
      await this.sendTextMessage(from, '⚠️ That picture is no longer in the library. Pick another one, or reply *Back*.');
      return;
    }
    const back = (session.libraryBack as any) || 'AWAITING_REACTION';
    session.reactionImagePath = file.filePath;
    session.reactionMimeType = file.mimeType;
    session.reactionLibraryId = id;
    session.reactionFraming = null;
    session.state = back;
    session.libraryBack = null;
    session.libraryIds = [];
    await session.save();
    await this.sendTextMessage(from, `✅ Using your *${file.category || 'library'}* picture.`);
    await this.afterReaction(session, from, this.isManualState(session) ? 'manual' : 'viral', { updated: back.endsWith('PUNCHLINE') });
  }

  /**
   * A reaction picture is in hand (sent, or chosen from the library). A stack of frames is never decided silently:
   * the user is asked which frame to use. Anything else goes straight on.
   */
  private async afterReaction(session: WhatsAppSessionDocument, from: string, kind: 'viral' | 'manual', opts: { updated?: boolean }): Promise<void> {
    const look = await this.reactionLook(session);
    if (look?.a.stacked && !session.reactionFraming) {
      await this.askFraming(session, from, kind, look);
      return;
    }
    await this.continueAfterReaction(session, from, kind, look?.a || null, opts);
  }

  private async askFraming(session: WhatsAppSessionDocument, from: string, kind: 'viral' | 'manual', look: { img: any; a: ReactionAnalysis }): Promise<void> {
    const options = framingOptions(look.a);
    session.state = 'AWAITING_FRAMING';
    session.framingNext = kind;
    await session.save();

    // a picture of every choice, then the question as a tap-list (plain text when a list cannot be sent)
    try {
      const sheet = await renderFramingSheet(look.img, look.a, options);
      const url = await this.writeSheet(sheet);
      await this.sendPicture(from, { buffer: sheet, mimeType: 'image/jpeg', url }, `🎞️ This picture has ${look.a.frames.length} frames. Here is each choice:`);
    } catch (err: any) {
      this.logger.warn(`Could not draw the frame choices: ${err?.message || err}`);
    }
    const question = framingQuestionText(look.a, options);
    const sent = await this.sendListMessage(
      from,
      question,
      'Choose',
      options.map(o => ({ id: `fr:${o.id}`, title: `${o.n}. ${o.title}`, description: o.hint }))
    );
    if (!sent) await this.sendTextMessage(from, question);
  }

  /** The answer to the frame question: a number, a word, or a tapped list row (`fr:<id>`). */
  private async answerFraming(session: WhatsAppSessionDocument, from: string, answer: string): Promise<void> {
    const kind: 'viral' | 'manual' = session.framingNext === 'manual' ? 'manual' : 'viral';
    const look = await this.reactionLook(session);
    if (!look || !look.a.stacked) {
      // the picture is gone or is not a stack any more: nothing to ask
      await this.continueAfterReaction(session, from, kind, look?.a || null, {});
      return;
    }
    const options = framingOptions(look.a);
    const choice = framingFromRow(answer, options) || parseFramingAnswer(answer, options);
    if (!choice) {
      await this.sendTextMessage(from, `I did not get that. Reply with a number from 1 to ${options.length}.\n\n${framingQuestionText(look.a, options)}`);
      return;
    }
    session.reactionFraming = choice.framing as any;
    session.framingNext = null;
    await this.sendTextMessage(from, `✅ Using *${describeFraming(choice.framing)}*.`);
    await this.continueAfterReaction(session, from, kind, look.a, {});
  }

  /** After the reaction picture (and its framing) is settled: warn about a small picture, then punchline or generation. */
  private async continueAfterReaction(
    session: WhatsAppSessionDocument,
    from: string,
    kind: 'viral' | 'manual',
    a: ReactionAnalysis | null,
    opts: { updated?: boolean }
  ): Promise<void> {
    const warning = a ? softWarning(a, (session.reactionFraming as ReactionFraming | null) || undefined) : null;
    if (warning) await this.sendTextMessage(from, warning);

    if (kind === 'manual') {
      if (session.punchline) {
        await this.generateManualMeme(session, from);
        return;
      }
      session.state = 'MANUAL_PUNCHLINE';
      await session.save();
      await this.sendTextMessage(from, `🎭 Reaction image received! Now send the *punchline* text.`);
      return;
    }

    if (session.punchline) {
      session.state = 'GENERATING';
      await session.save();
      await this.sendTextMessage(from, '⏳ *Generating your meme...* Running AI vision analysis & discovering clean subject images. This takes ~30-60s.');
      await this.generateAndSendMeme(session, from);
      return;
    }
    session.state = 'AWAITING_PUNCHLINE';
    await session.save();
    await this.sendTextMessage(
      from,
      opts.updated
        ? `🎭 *Reaction image updated!*\n\nNow send the *Reacting Text / Punchline* to start generating.`
        : `🎭 *Reaction image received!*\n\nNow send the *Reacting Text / Punchline* (in Telugu or English) to place on the reaction image.`
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Layout library: saved meme layouts (structure only; fonts and colours come from Settings)
  // ---------------------------------------------------------------------------------------------

  private layoutListText(layouts: FormatSummary[]): string {
    if (!layouts.length) {
      return (
        `📐 *No saved layouts yet.*\n\n` +
        `Layouts are learned automatically each time you adapt a viral meme. You can also send *New layout* and then an example meme.`
      );
    }
    return (
      `📐 *Your saved layouts*\n\n` +
      layouts.map((l, i) => `${i + 1}. ${l.name ? `*${l.name}*` : `_${l.displayName}_`} — ${l.description}`).join('\n') +
      `\n\n• *Layout 2* — see its example\n• *Name 2 My layout* — name it\n• *Delete layout 2*\n• *New layout* — teach me a new one\n` +
      `Use them with *Manual*.`
    );
  }

  /** Layout commands and the naming step. Returns true when the message was handled. */
  private async handleLayoutCommand(session: WhatsAppSessionDocument, from: string, text: string, lower: string): Promise<boolean> {
    // The name for a layout that was just learned
    if (session.state === 'LAYOUT_NAME') {
      const id = session.pendingFormatId;
      if (id && !this.isSkip(text)) {
        try {
          const f = await this.formats.rename(id, text);
          await this.sendTextMessage(from, `✅ Saved as *${f.name}* — ${f.description}.\nUse it with *Manual*.`);
        } catch (err: any) {
          await this.sendTextMessage(from, `⚠️ ${err?.message || 'Could not save that name'} Send another name, or *skip*.`);
          return true;
        }
      } else {
        await this.sendTextMessage(from, '👍 Kept as an unnamed layout. Send *Layouts* anytime to name it.');
      }
      session.pendingFormatId = null;
      session.state = 'IDLE';
      await session.save();
      return true;
    }
    if (session.state === 'LAYOUT_ANALYZING') {
      await this.sendTextMessage(from, '⏳ Still analysing your example meme...');
      return true;
    }
    // Other commands only when nothing else is in progress, so ordinary text is never mistaken for one
    if (session.state !== 'IDLE' && session.state !== 'LAYOUT_EXAMPLE') return false;

    if (/^(layouts|formats|my layouts|layout list)$/.test(lower)) {
      await this.sendTextMessage(from, this.layoutListText(await this.formats.list()));
      return true;
    }

    if (/^(new|add|save) layout$/.test(lower)) {
      session.state = 'LAYOUT_EXAMPLE';
      await session.save();
      await this.sendTextMessage(
        from,
        `📐 Send an *example meme* of the layout you want to save (photo, document or link).\n` +
        `Add a *caption* to name it right away. Only the structure is saved (image positions, header, reaction panel) — fonts and colours stay as in Settings.\n` +
        `Send *Reset* to cancel.`
      );
      return true;
    }

    const view = /^layout\s+(\d{1,3})$/.exec(lower);
    if (view) {
      const doc = await this.formats.getByPosition(Number(view[1]));
      if (!doc) {
        await this.sendTextMessage(from, `I do not have layout ${view[1]}. Send *Layouts* to see the list.`);
        return true;
      }
      const description = FormatLibraryService.describe(doc);
      const caption = `📐 *${doc.name || `Unnamed layout ${view[1]}`}*\n${description}\nUsed ${doc.usageCount || 0} time(s).`;
      const sent = doc.thumbnailFile
        ? await this.sendPicture(from, { filePath: path.join(OUTPUT_ROOT, path.basename(doc.thumbnailFile)), url: `${getConfig().instagram.publicBaseUrl}/output/${doc.thumbnailFile}` }, caption)
        : false;
      if (!sent) await this.sendTextMessage(from, caption);
      return true;
    }

    const rename = /^(?:name|rename)\s+(\d{1,3})\s+(.+)$/i.exec(text);
    if (rename) {
      const doc = await this.formats.getByPosition(Number(rename[1]));
      if (!doc) {
        await this.sendTextMessage(from, `I do not have layout ${rename[1]}. Send *Layouts* to see the list.`);
        return true;
      }
      try {
        const f = await this.formats.rename(doc.formatId, rename[2]);
        await this.sendTextMessage(from, `✅ Layout ${rename[1]} is now *${f.name}*.`);
      } catch (err: any) {
        await this.sendTextMessage(from, `⚠️ ${err?.message || 'Could not rename it.'}`);
      }
      return true;
    }

    const del = /^delete layout\s+(\d{1,3})$/.exec(lower);
    if (del) {
      const doc = await this.formats.getByPosition(Number(del[1]));
      if (!doc) {
        await this.sendTextMessage(from, `I do not have layout ${del[1]}. Send *Layouts* to see the list.`);
        return true;
      }
      await this.formats.remove(doc.formatId);
      await this.sendTextMessage(from, `🗑️ Deleted layout ${del[1]} (${doc.name || 'unnamed'}). Numbers after it moved up by one.`);
      return true;
    }
    return false;
  }

  /** The example meme for a new layout: analyse the structure, save it, ask for a name. */
  private async handleLayoutExample(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: { filePath: string; mimeType: string },
    caption: string
  ): Promise<void> {
    session.state = 'LAYOUT_ANALYZING';
    await session.save();
    await this.sendTextMessage(from, '🔎 *Analysing the layout of your example...* about 30-60 seconds.');
    try {
      const analysis = await this.viralAdaptation.analyzeForFormat(this.uploadOf(downloaded.filePath, downloaded.mimeType));
      const { format, created } = await this.formats.saveFromAnalysis(analysis, {
        name: caption,
        source: 'whatsapp',
        referencePath: downloaded.filePath
      });
      const description = FormatLibraryService.describe(format);
      if (!created) {
        await this.sendTextMessage(
          from,
          `ℹ️ That structure is already saved as *${format.name || 'an unnamed layout'}* — ${description}.\nSend *Layouts* to see all of them.`
        );
        session.state = 'IDLE';
      } else if (format.name) {
        await this.sendTextMessage(from, `✅ Saved layout *${format.name}* — ${description}.\nUse it with *Manual*.`);
        session.state = 'IDLE';
      } else {
        session.pendingFormatId = format.formatId;
        session.state = 'LAYOUT_NAME';
        await this.sendTextMessage(from, `✅ Learned a new layout: ${description}.\n\nWhat should I call it? (or *skip*)`);
      }
    } catch (err: any) {
      this.logger.error(`Layout analysis failed: ${err?.message || err}`);
      await this.sendTextMessage(from, `❌ I could not learn a layout from that picture: ${err?.message || 'analysis failed'}\nSend another example, or *Reset*.`);
      session.state = 'LAYOUT_EXAMPLE';
    } finally {
      await session.save();
      // The preview (if any) was copied; the downloaded example is not needed any more
      fs.promises.rm(downloaded.filePath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Photos sent together reach the bot as separate messages, in no guaranteed order, so the subject pictures are shown
   * back numbered (the order they will have in the meme) and can be corrected in one message:
   *   order 2 1 3 4                     the new order, by the numbers on the sheet
   *   labels 7 HILLS | 3550 STEPS | …   a caption for each picture, in order ("-" leaves one without)
   *   label 3 HOURS OF WAITING          one picture's caption
   *   show                              the sheet again
   * Returns false when the text is none of these.
   */
  private async subjectOrderCommand(session: WhatsAppSessionDocument, from: string, text: string): Promise<boolean> {
    const t = text.trim();
    const subjects = session.manualSubjects || [];
    const n = subjects.length;
    if (/^(show|preview|pictures|order)$/i.test(t)) {
      if (!n) return false;
      await this.sendSubjectSheet(session, from);
      return true;
    }
    const order = t.match(/^order[:\s]+([\d,\s]+)$/i);
    if (order) {
      const nums = order[1].split(/[\s,]+/).filter(Boolean).map(Number);
      const valid = nums.length === n && nums.every(x => Number.isInteger(x) && x >= 1 && x <= n) && new Set(nums).size === n;
      if (!valid) {
        await this.sendTextMessage(from, `Send every number once, in the new order. For your ${n} pictures, for example: *order ${Array.from({ length: n }, (_, i) => n - i).join(' ')}*`);
        return true;
      }
      session.manualSubjects = nums.map(x => subjects[x - 1]) as any;
      session.markModified('manualSubjects');
      await session.save();
      await this.sendSubjectSheet(session, from, '✅ New order.');
      return true;
    }
    const one = t.match(/^label\s+(\d+)[:\s]+(.+)$/is);
    if (one) {
      const i = Number(one[1]) - 1;
      if (i < 0 || i >= n) {
        await this.sendTextMessage(from, `There is no picture ${one[1]}. Pick 1 to ${n}.`);
        return true;
      }
      const v = one[2].trim();
      subjects[i].label = v === '-' ? undefined : v;
      session.markModified('manualSubjects');
      await session.save();
      await this.sendSubjectSheet(session, from, `✅ Label for picture ${i + 1} set.`);
      return true;
    }
    const all = t.match(/^labels?[:\s]+(.+)$/is);
    if (all && n) {
      const parts = all[1].split(/\s*\|\s*|\n+/).map(x => x.trim());
      parts.slice(0, n).forEach((v, i) => (subjects[i].label = !v || v === '-' ? undefined : v));
      session.markModified('manualSubjects');
      await session.save();
      await this.sendSubjectSheet(session, from, parts.length > n ? `✅ Labels set (you sent ${parts.length}, there are ${n} pictures: the extra ones were left out).` : '✅ Labels set.');
      return true;
    }
    return false;
  }

  /** The subject pictures as one numbered sheet, in meme order, with their labels. */
  private async sendSubjectSheet(session: WhatsAppSessionDocument, from: string, heading?: string): Promise<void> {
    const subjects = session.manualSubjects || [];
    if (!subjects.length) return;
    try {
      const tiles = await Promise.all(subjects.map(async s => ({ image: await fs.promises.readFile(s.path), label: s.label || undefined })));
      const sheet = await renderSheet(tiles, {
        title: 'Your pictures, in meme order',
        subtitle: 'left to right, top to bottom',
        columns: subjects.length === 4 ? 2 : Math.min(subjects.length, 3)
      });
      const url = await this.writeSheet(sheet);
      const caption =
        (heading ? `${heading}\n` : '') +
        `This is the order they go in the meme.\n` +
        `Wrong order? Reply *order ${subjects.map((_, i) => subjects.length - i).join(' ')}* (the numbers in the new order).\n` +
        `Labels: *labels ${subjects.map((s, i) => s.label || `TEXT ${i + 1}`).join(' | ')}*`;
      const sent = await this.sendPicture(from, { buffer: sheet, mimeType: 'image/jpeg', url }, caption);
      if (!sent) await this.sendTextMessage(from, caption);
    } catch (e: any) {
      this.logger.warn(`Could not show the subject pictures: ${e.message}`);
    }
  }

  /** Moves the manual flow on, skipping the headline/statement questions a saved layout does not have. */
  private async manualNextStep(session: WhatsAppSessionDocument, from: string, after: 'type' | 'headline' | 'statement'): Promise<void> {
    const f = session.manualFormatId ? await this.formats.get(session.manualFormatId) : null;
    if (f && after === 'type') {
      await this.sendTextMessage(from, `📐 Layout *${f.name || 'Unnamed layout'}*: ${FormatLibraryService.describe(f)}.`);
    }
    let next: 'MANUAL_HEADLINE' | 'MANUAL_STATEMENT' | 'MANUAL_SUBJECTS';
    if (after === 'type') next = !f || f.hasHeader ? 'MANUAL_HEADLINE' : f.hasStatement ? 'MANUAL_STATEMENT' : 'MANUAL_SUBJECTS';
    else if (after === 'headline') next = !f || f.hasStatement ? 'MANUAL_STATEMENT' : 'MANUAL_SUBJECTS';
    else next = 'MANUAL_SUBJECTS';
    session.state = next;
    await session.save();
    if (next === 'MANUAL_HEADLINE') {
      await this.sendTextMessage(from, `📌 Send the *headline* for the top banner (or *skip*).`);
    } else if (next === 'MANUAL_STATEMENT') {
      await this.sendTextMessage(from, `📝 Send the *statement / news text* (or *skip*).`);
    } else {
      await this.sendTextMessage(
        from,
        session.manualSlotCount
          ? `🖼️ Send the *${session.manualSlotCount} subject image${session.manualSlotCount === 1 ? '' : 's'}* in layout order (left to right, top to bottom).\n` +
            `Add a *caption* to an image to use it as its label. I continue by myself after image ${session.manualSlotCount}.`
          : `🖼️ Now send the *subject images* (up to ${WhatsAppService.MAX_MANUAL_SUBJECTS}), in meme order: left to right, top to bottom.\n` +
            `Add a *caption* to an image to use it as its label.\n` +
            `Send *done* when all subject images are in. I then show them numbered, so the order and labels can be fixed.`
      );
    }
  }

  private async resetSession(session: WhatsAppSessionDocument): Promise<void> {
    this.cancelRun(session.phoneNumber); // a meme still being made for this chat is dropped, not delivered into the fresh start
    session.state = 'IDLE';
    session.referenceImagePath = null;
    session.referenceMimeType = null;
    session.reactionImagePath = null;
    session.reactionMimeType = null;
    session.reactionFraming = null;
    session.reactionLibraryId = null;
    session.libraryBack = null;
    session.libraryFolder = null;
    session.librarySearch = null;
    session.libraryRecent = false;
    session.libraryPage = 0;
    session.libraryIds = [];
    session.libraryFolders = [];
    session.framingNext = null;
    session.punchline = null;
    session.reactionContext = null;
    session.mode = 'viral';
    session.viralDraftId = null;
    session.viralSlots = [];
    session.viralOverrides = [];
    session.viralMissing = [];
    session.manualMemeType = null;
    session.manualFormatId = null;
    session.manualSlotCount = null;
    session.pendingFormatId = null;
    session.manualHeadline = null;
    session.manualStatement = null;
    session.manualSubjects = [];
    session.manualSubjectFit = null;
    session.lastGeneratedMemeId = null;
    session.lastGeneratedImageUrl = null;
    session.lastGeneratedCaption = null;
    await session.save();
  }
}
