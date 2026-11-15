import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { getConfig } from '../config/app-config';
import { MAX_ALLOWED_PHONES, parsePhoneList } from '../config/phone-list';
import { WhatsAppCredentials, WhatsAppCredentialsDocument } from '../schemas/whatsapp-credentials.schema';
import { InstagramTokenService } from './instagram-token.service';

/** The three values that are secrets (stored encrypted). */
export type SecretField = 'accessToken' | 'verifyToken' | 'appSecret';
/** Every WhatsApp setting that can be saved in the app. */
export type CredentialField = SecretField | 'phoneNumberId' | 'allowedPhone';
export type FieldSource = 'app' | 'server' | 'none';

export const CREDENTIAL_FIELDS: CredentialField[] = ['accessToken', 'phoneNumberId', 'verifyToken', 'appSecret', 'allowedPhone'];

/** Database columns that hold each encrypted secret. */
const COLS: Record<SecretField, { enc: string; iv: string; tag: string; last4: string }> = {
  accessToken: { enc: 'encryptedAccessToken', iv: 'iv', tag: 'tag', last4: 'tokenLast4' },
  verifyToken: { enc: 'encryptedVerifyToken', iv: 'verifyTokenIv', tag: 'verifyTokenTag', last4: 'verifyTokenLast4' },
  appSecret: { enc: 'encryptedAppSecret', iv: 'appSecretIv', tag: 'appSecretTag', last4: 'appSecretLast4' }
};

export interface EffectiveWhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  /** Digits with country code; several numbers are comma-separated. Empty = nobody is allowed (the bot refuses everyone). */
  allowedPhone: string;
  sources: Record<CredentialField, FieldSource>;
  /** Secrets that are saved but cannot be decrypted (the encryption key changed). */
  unreadable: SecretField[];
  // convenience views used by the sender and older callers
  tokenSource: FieldSource;
  phoneSource: 'app' | 'server';
  savedTokenUnreadable: boolean;
}

export interface WhatsAppCheck {
  ok: boolean;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  errorCode?: number;
  message?: string;
  /** Meta could not be reached (not a verdict on the token). */
  unreachable?: boolean;
}

export interface FieldStatus {
  source: FieldSource;
  /** "••••1234" for secrets, only to recognise which one is saved. */
  hint: string | null;
  /** The value itself, for the two fields that are not secret (phone number ID, allowed phone). */
  value?: string;
}

export interface WhatsAppStatus {
  configured: boolean;
  fields: Record<CredentialField, FieldStatus>;
  tokenSource: FieldSource;
  tokenHint: string | null;
  phoneNumberId: string;
  phoneSource: 'app' | 'server';
  savedAt: Date | null;
  expiresAt: Date | null;
  /** true: Meta says it is expired/invalid; false: valid; null: not checked. */
  expired: boolean | null;
  /** Meta says this token never expires (only known after a live check). */
  neverExpires: boolean | null;
  /** Saved secrets that cannot be read any more. */
  unreadable: SecretField[];
  savedTokenUnreadable: boolean;
  /** The last time WhatsApp rejected our token while sending, until a send works or a token is saved. */
  lastFailure: { message: string; at: Date } | null;
  /** Present only after a live check against Meta. */
  live: WhatsAppCheck | null;
  allowedPhone: string;
  verifyTokenConfigured: boolean;
  appSecretConfigured: boolean;
  encryptionKeyConfigured: boolean;
  /** Required settings that are still empty (token, phone number ID, verify token, app secret, allowed phone). */
  missing: CredentialField[];
  apiVersion: string;
  webhookUrl: string;
}

const TOKEN_RE = /^[A-Za-z0-9_\-.]{20,1000}$/;
const PHONE_ID_RE = /^\d{5,20}$/;
const VERIFY_RE = /^[A-Za-z0-9_\-.~]{8,100}$/;
const SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
const CACHE_MS = 10_000;

/** Pulls a bare token out of what people paste ("Bearer EAA...", quotes, line breaks). */
export function cleanAccessToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/^\s*(authorization:\s*)?bearer\s+/i, '').replace(/["'\s]/g, '');
  return t || null;
}

const last4 = (v: string | null | undefined) => (v && v.length >= 4 ? `••••${v.slice(-4)}` : null);
/** A field the user did not touch: absent or an empty box. */
const untouched = (v: unknown) => v === undefined || v === null || v === '';

@Injectable()
export class WhatsAppCredentialsService {
  private readonly logger = new Logger(WhatsAppCredentialsService.name);
  private cache: { at: number; value: EffectiveWhatsAppCredentials } | null = null;
  private failure: { message: string; at: Date } | null = null;

  constructor(
    @InjectModel(WhatsAppCredentials.name) private readonly model: Model<WhatsAppCredentialsDocument>,
    private readonly tokens: InstagramTokenService
  ) {}

  private readSecret(doc: any, f: SecretField): { value: string | null; unreadable: boolean } {
    const c = COLS[f];
    if (!doc || !doc[c.enc] || !doc[c.iv] || !doc[c.tag]) return { value: null, unreadable: false };
    try {
      return { value: this.tokens.decrypt({ cipherText: doc[c.enc], iv: doc[c.iv], tag: doc[c.tag] }), unreadable: false };
    } catch {
      return { value: null, unreadable: true };
    }
  }

  private async readDoc(): Promise<any | null> {
    return this.model.findOne({ key: 'default' }).lean().exec();
  }

  private envValues() {
    const e = getConfig().whatsapp;
    return { accessToken: e.accessToken || '', phoneNumberId: e.phoneNumberId || '', verifyToken: e.verifyToken || '', appSecret: e.appSecret || '', allowedPhone: e.allowedPhone || '' };
  }

  private build(doc: any | null): EffectiveWhatsAppCredentials {
    const env = this.envValues();
    const sources = {} as Record<CredentialField, FieldSource>;
    const unreadable: SecretField[] = [];
    const out: Record<CredentialField, string> = { accessToken: '', phoneNumberId: '', verifyToken: '', appSecret: '', allowedPhone: '' };

    for (const f of ['accessToken', 'verifyToken', 'appSecret'] as SecretField[]) {
      const r = this.readSecret(doc, f);
      if (r.unreadable) unreadable.push(f);
      out[f] = r.value || env[f];
      sources[f] = r.value ? 'app' : env[f] ? 'server' : 'none';
    }
    for (const f of ['phoneNumberId', 'allowedPhone'] as const) {
      const saved: string | null = doc?.[f] || null;
      out[f] = saved || env[f];
      sources[f] = saved ? 'app' : env[f] ? 'server' : 'none';
    }
    return {
      ...out,
      sources,
      unreadable,
      tokenSource: sources.accessToken,
      phoneSource: sources.phoneNumberId === 'app' ? 'app' : 'server',
      savedTokenUnreadable: unreadable.includes('accessToken')
    };
  }

  /** The values to use right now: anything saved in the app wins over the server (.env) setting. */
  async getEffective(): Promise<EffectiveWhatsAppCredentials> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    let value: EffectiveWhatsAppCredentials;
    try {
      value = this.build(await this.readDoc());
    } catch (err: any) {
      // the database is unreachable: keep the bot working on the server settings
      this.logger.warn(`Could not read saved WhatsApp settings (${err?.message || err}); using server settings.`);
      return this.build(null);
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Called by the sender with Meta's error body when a send is refused, or null when it worked. */
  noteSendResult(errorBody: any | null): void {
    if (!errorBody) {
      this.failure = null;
      return;
    }
    const e = errorBody?.error || errorBody;
    if (Number(e?.code) === 190 || e?.type === 'OAuthException') {
      this.failure = { message: String(e?.message || 'WhatsApp rejected the access token').slice(0, 300), at: new Date() };
    }
  }

  /** Asks Meta whether this token works for this phone number (no secrets are logged). */
  async check(token: string, phoneNumberId: string): Promise<WhatsAppCheck> {
    const cfg = getConfig().whatsapp;
    try {
      const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000)
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body?.id) {
        return { ok: true, displayPhoneNumber: body.display_phone_number, verifiedName: body.verified_name, qualityRating: body.quality_rating };
      }
      return { ok: false, errorCode: Number(body?.error?.code) || undefined, message: String(body?.error?.message || `Meta answered HTTP ${res.status}`).slice(0, 300) };
    } catch (err: any) {
      return { ok: false, unreachable: true, message: `Could not reach Meta (${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}).` };
    }
  }

  /** When the token stops working, from Meta's token inspector. Best effort: null when unknown. */
  async expiryOf(token: string): Promise<{ expiresAt: Date | null; neverExpires: boolean; valid: boolean | null }> {
    const ig = getConfig().instagram;
    if (!ig.metaAppId || !ig.metaAppSecret) return { expiresAt: null, neverExpires: false, valid: null };
    try {
      const url = `https://graph.facebook.com/${getConfig().whatsapp.apiVersion}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${ig.metaAppId}|${ig.metaAppSecret}`)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const body: any = await res.json().catch(() => ({}));
      const d = body?.data;
      if (!res.ok || !d) return { expiresAt: null, neverExpires: false, valid: null };
      const at = Number(d.expires_at);
      return { expiresAt: at > 0 ? new Date(at * 1000) : null, neverExpires: at === 0, valid: typeof d.is_valid === 'boolean' ? d.is_valid : null };
    } catch {
      return { expiresAt: null, neverExpires: false, valid: null };
    }
  }

  /**
   * Status for the Settings page. With `live`, Meta is asked whether the token works right now and when
   * it expires; without it nothing leaves the server (used for the always-on indicator).
   */
  async status(live = false): Promise<WhatsAppStatus> {
    const cfg = getConfig();
    const eff = await this.getEffective();
    const doc = await this.readDoc().catch(() => null);
    let check: WhatsAppCheck | null = null;
    let expiresAt: Date | null = eff.sources.accessToken === 'app' && doc?.tokenExpiresAt ? new Date(doc.tokenExpiresAt) : null;
    let expired: boolean | null = expiresAt ? expiresAt.getTime() <= Date.now() : null;
    let neverExpires: boolean | null = null;

    if (live && eff.accessToken && eff.phoneNumberId) {
      check = await this.check(eff.accessToken, eff.phoneNumberId);
      const exp = await this.expiryOf(eff.accessToken);
      if (exp.expiresAt) expiresAt = exp.expiresAt;
      else if (exp.neverExpires) expiresAt = null;
      neverExpires = exp.expiresAt || exp.neverExpires || exp.valid !== null ? exp.neverExpires : null;
      if (!check.unreachable && !check.ok && (check.errorCode === 190 || exp.valid === false)) expired = true;
      else if (check.ok) expired = false;
      if (check.ok) this.failure = null;
      else if (check.errorCode === 190) this.noteSendResult({ error: { code: 190, message: check.message } });
    }

    const env = this.envValues();
    const hintOf = (f: SecretField): string | null => {
      const src = eff.sources[f];
      if (src === 'none') return null;
      return src === 'app' ? (doc?.[COLS[f].last4] ? `••••${doc[COLS[f].last4]}` : null) : last4(env[f]);
    };
    const fields: Record<CredentialField, FieldStatus> = {
      accessToken: { source: eff.sources.accessToken, hint: hintOf('accessToken') },
      phoneNumberId: { source: eff.sources.phoneNumberId, hint: null, value: eff.phoneNumberId },
      verifyToken: { source: eff.sources.verifyToken, hint: hintOf('verifyToken') },
      appSecret: { source: eff.sources.appSecret, hint: hintOf('appSecret') },
      allowedPhone: { source: eff.sources.allowedPhone, hint: null, value: eff.allowedPhone }
    };
    const missing = CREDENTIAL_FIELDS.filter(f => !eff[f]);

    return {
      configured: Boolean(eff.accessToken && eff.phoneNumberId),
      fields,
      tokenSource: eff.sources.accessToken,
      tokenHint: fields.accessToken.hint,
      phoneNumberId: eff.phoneNumberId,
      phoneSource: eff.phoneSource,
      savedAt: eff.sources.accessToken === 'app' && doc?.tokenSavedAt ? new Date(doc.tokenSavedAt) : null,
      expiresAt,
      expired,
      neverExpires,
      unreadable: eff.unreadable,
      savedTokenUnreadable: eff.savedTokenUnreadable,
      lastFailure: this.failure,
      live: check,
      allowedPhone: eff.allowedPhone,
      verifyTokenConfigured: Boolean(eff.verifyToken),
      appSecretConfigured: Boolean(eff.appSecret),
      encryptionKeyConfigured: Boolean(cfg.instagram.tokenEncryptionKey),
      missing,
      apiVersion: cfg.whatsapp.apiVersion,
      webhookUrl: `${cfg.instagram.publicBaseUrl}/api/whatsapp/webhook`
    };
  }

  /**
   * Saves any of the five settings. A box left empty is not touched. When the access token or the phone
   * number ID changes, Meta is asked first: a combination Meta rejects is NOT saved, so a working setup
   * is never replaced by a bad paste. The other fields are checked for format only.
   */
  async saveAndVerify(input: Partial<Record<CredentialField, unknown>>): Promise<WhatsAppStatus> {
    const set: Record<string, unknown> = {};
    const secrets: Partial<Record<SecretField, string>> = {};

    if (!untouched(input.accessToken)) {
      const t = cleanAccessToken(input.accessToken);
      if (!t || !TOKEN_RE.test(t)) throw new BadRequestException('That does not look like an access token. Copy the whole token from Meta (it starts with "EAA" and has no spaces).');
      secrets.accessToken = t;
    }
    if (!untouched(input.verifyToken)) {
      const v = String(input.verifyToken).trim();
      if (!VERIFY_RE.test(v)) throw new BadRequestException('The verify token must be 8-100 characters: letters, numbers and - _ . ~ (no spaces).');
      secrets.verifyToken = v;
    }
    if (!untouched(input.appSecret)) {
      const a = String(input.appSecret).trim();
      if (!SECRET_RE.test(a)) throw new BadRequestException('That does not look like an app secret. Copy it from Meta: App settings > Basic > App secret (32 letters and numbers).');
      secrets.appSecret = a;
    }

    let newPhoneId: string | null | undefined;
    if (input.phoneNumberId !== undefined) {
      const p = typeof input.phoneNumberId === 'string' ? input.phoneNumberId.trim() : '';
      if (p && !PHONE_ID_RE.test(p)) throw new BadRequestException('The phone number ID is a number of 5-20 digits (WhatsApp > API Setup in the Meta dashboard).');
      newPhoneId = p || null;
    }
    if (input.allowedPhone !== undefined) {
      // One or several numbers, separated by commas or new lines. Saved as a normalised comma-separated list.
      const raw = typeof input.allowedPhone === 'string' ? input.allowedPhone : '';
      const { phones, invalid, tooMany } = parsePhoneList(raw);
      if (raw.trim() !== '') {
        if (invalid.length) {
          throw new BadRequestException(
            `The allowed phone numbers are 8-15 digits each with the country code, for example 919876543210. Check: ${invalid.join(', ')}. Separate several numbers with commas.`
          );
        }
        if (tooMany) throw new BadRequestException(`At most ${MAX_ALLOWED_PHONES} allowed phone numbers.`);
        if (!phones.length) throw new BadRequestException('Enter the allowed phone numbers as digits with the country code, for example 919876543210.');
      }
      set.allowedPhone = phones.join(',') || null;
    }
    if (!Object.keys(secrets).length && newPhoneId === undefined && set.allowedPhone === undefined) {
      throw new BadRequestException('Fill in at least one value to save.');
    }

    // Meta decides whether the token and phone number ID work together, before anything is saved
    const metaRelevant = Boolean(secrets.accessToken) || newPhoneId !== undefined;
    if (metaRelevant) {
      const eff = await this.getEffective();
      const tokenToTest = secrets.accessToken || eff.accessToken;
      const phoneToTest = newPhoneId === undefined ? eff.phoneNumberId : newPhoneId || getConfig().whatsapp.phoneNumberId;
      if (!tokenToTest) throw new BadRequestException('There is no access token yet. Paste one.');
      const check = await this.check(tokenToTest, phoneToTest);
      if (check.unreachable) throw new BadGatewayException(`${check.message} Nothing was saved. Try again in a moment.`);
      if (!check.ok) {
        throw new BadRequestException(
          check.errorCode === 190
            ? 'Meta rejected this token: it is invalid or has expired. Generate a fresh one (WhatsApp > API Setup) and paste the whole token. Nothing was saved.'
            : `Meta did not accept these details: ${check.message} Nothing was saved.`
        );
      }
    }

    for (const f of Object.keys(secrets) as SecretField[]) {
      const enc = this.tokens.encrypt(secrets[f] as string);
      const c = COLS[f];
      Object.assign(set, { [c.enc]: enc.cipherText, [c.iv]: enc.iv, [c.tag]: enc.tag, [c.last4]: (secrets[f] as string).slice(-4) });
    }
    if (secrets.accessToken) {
      const exp = await this.expiryOf(secrets.accessToken);
      Object.assign(set, { tokenSavedAt: new Date(), tokenExpiresAt: exp.expiresAt });
    }
    if (newPhoneId !== undefined) set.phoneNumberId = newPhoneId;

    await this.model.findOneAndUpdate({ key: 'default' }, { $set: set, $setOnInsert: { key: 'default' } }, { upsert: true, new: true }).exec();
    this.cache = null;
    if (secrets.accessToken) this.failure = null;
    const saved = [...Object.keys(secrets), ...(newPhoneId !== undefined ? ['phoneNumberId'] : []), ...(set.allowedPhone !== undefined ? ['allowedPhone'] : [])];
    this.logger.log(`WhatsApp settings updated from the app: ${saved.join(', ')}.`);
    return this.status(secrets.accessToken !== undefined || newPhoneId !== undefined);
  }

  /** Removes one saved value (or all of them); the server (.env) setting is used again. */
  async clearSaved(field?: CredentialField | 'all'): Promise<WhatsAppStatus> {
    const unset: Record<string, null> = {};
    const targets: CredentialField[] = !field || field === 'all' ? CREDENTIAL_FIELDS : [field];
    for (const f of targets) {
      if (f === 'phoneNumberId' || f === 'allowedPhone') unset[f] = null;
      else {
        const c = COLS[f];
        Object.assign(unset, { [c.enc]: null, [c.iv]: null, [c.tag]: null, [c.last4]: null });
        if (f === 'accessToken') Object.assign(unset, { tokenSavedAt: null, tokenExpiresAt: null });
      }
    }
    await this.model.updateOne({ key: 'default' }, { $set: unset }).exec();
    this.cache = null;
    if (targets.includes('accessToken')) this.failure = null;
    return this.status(false);
  }

  /** Kept for callers that only know about the token. */
  clearSavedToken(): Promise<WhatsAppStatus> {
    return this.clearSaved('accessToken');
  }

  /** Cheap indicator for the app-wide status (no call to Meta). */
  async indicator(): Promise<{ configured: boolean; problem: 'expired' | 'rejected' | 'unreadable' | 'missing' | 'incomplete' | null; expiresAt: Date | null; missing: CredentialField[] }> {
    const s = await this.status(false);
    let problem: 'expired' | 'rejected' | 'unreadable' | 'missing' | 'incomplete' | null = null;
    if (!s.configured) problem = s.unreadable.length ? 'unreadable' : 'missing';
    else if (s.lastFailure) problem = 'rejected';
    else if (s.expired) problem = 'expired';
    else if (s.unreadable.length) problem = 'unreadable';
    else if (s.missing.length) problem = 'incomplete';
    return { configured: s.configured, problem, expiresAt: s.expiresAt, missing: s.missing };
  }
}
