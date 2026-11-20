import { Injectable, Logger, Optional } from '@nestjs/common';
import { getConfig } from '../config/app-config';
import { WhatsAppCredentialsService } from '../services/whatsapp-credentials.service';
import { AuthService, ClientInfo } from './auth.service';
import { describeDevice } from './device';
import { Challenge, formatCode, parseLoginCode, phoneTail, WhatsAppChallenges } from './whatsapp-challenges';

/** The bot's own number, as the sign-in page shows it. */
export interface BotNumber {
  /** Digits with country code, for the wa.me link. */
  digits: string;
  /** As people read it: "+91 93477 08120". */
  display: string;
  /** The WhatsApp Business display name, when Meta tells us. */
  name?: string;
}

export interface Availability {
  available: boolean;
  /** Why not, in words for the sign-in page. */
  reason?: string;
  bot?: BotNumber;
}

/** What the bot answers on WhatsApp. `buttons` are reply buttons; `fallback` replaces the text when buttons fail. */
export interface BotReply {
  text: string;
  buttons?: { id: string; title: string }[];
  fallback?: string;
}

export type PollOutcome =
  | { status: 'pending'; expiresAt: number; rejectedFrom?: string }
  | { status: 'approved'; token: string; username: string; maxAgeSeconds: number; phoneTail: string }
  | { status: 'used' | 'expired' }
  | { status: 'cancelled'; by?: Challenge['cancelledBy'] };

/** A sign-in page holds one request open this long; it simply asks again when nothing happened. */
export const POLL_HOLD_MS = 25_000;
const BOT_CACHE_OK_MS = 6 * 3600_000;
const BOT_CACHE_FAIL_MS = 60_000;
export const DENY_PREFIX = 'auth:deny:';
const SIGN_OUT_EVERYWHERE = new Set(['sign out everywhere', 'signout everywhere', 'log out everywhere', 'logout everywhere', 'sign out all', 'logout all', 'log out all']);

/** "+91 93477 08120" from whatever Meta or the .env gave ("919347708120", "+1 555-012-3456"). */
export function botNumberFrom(raw: string | undefined | null, name?: string): BotNumber | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  const given = String(raw).trim();
  const display = /[\s-]/.test(given) ? (given.startsWith('+') ? given : `+${given}`) : `+${digits}`;
  return { digits, display, ...(name ? { name } : {}) };
}

/**
 * "Send this code from your WhatsApp" sign-in. The page shows a code; an allowed number sends it to the bot; the page
 * that is waiting is signed in. The proof is the sender: only numbers on the bot's allowed list can approve, and Meta
 * signs every message it delivers (see WhatsAppController). Codes work once, for five minutes.
 */
@Injectable()
export class WhatsAppLoginService {
  private readonly logger = new Logger(WhatsAppLoginService.name);
  readonly challenges: WhatsAppChallenges;
  private botCache: { at: number; ok: boolean; value: BotNumber | null; reason?: string } | null = null;

  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly credentials?: WhatsAppCredentialsService,
    @Optional() challenges?: WhatsAppChallenges
  ) {
    this.challenges = challenges || new WhatsAppChallenges();
  }

  // ---- is it offered? ------------------------------------------------------------------------

  private async creds() {
    const env = getConfig().whatsapp;
    if (!this.credentials) return env;
    try {
      const c = await this.credentials.getEffective();
      return { ...env, accessToken: c.accessToken, phoneNumberId: c.phoneNumberId, appSecret: c.appSecret, allowedPhone: c.allowedPhone };
    } catch {
      return env;
    }
  }

  /** Is everything in place for the bot to receive a code? Quick: no call to Meta (the sign-in page asks this first). */
  async configured(): Promise<{ ok: boolean; reason?: string }> {
    const a = getConfig().auth;
    if (!a.enabled) return { ok: false, reason: 'Login is switched off on this server.' };
    if (!a.whatsappLogin) return { ok: false, reason: 'WhatsApp sign-in is switched off on this server (AUTH_WHATSAPP_LOGIN=false).' };
    const c = await this.creds();
    if (!c.accessToken || !c.phoneNumberId) return { ok: false, reason: 'The WhatsApp bot is not connected yet (no access token or phone number ID).' };
    if (!c.appSecret) return { ok: false, reason: 'The WhatsApp bot has no app secret, so it cannot trust incoming messages.' };
    if (!c.allowedPhone) return { ok: false, reason: 'No WhatsApp number is allowed to use the bot yet.' };
    return { ok: true };
  }

  /** Everything the sign-in page needs, including the bot's number (from the .env, else asked from Meta and remembered). */
  async availability(): Promise<Availability> {
    const conf = await this.configured();
    if (!conf.ok) return { available: false, reason: conf.reason };
    const bot = await this.botNumber();
    if (!bot.value) return { available: false, reason: bot.reason || 'Could not find the WhatsApp bot’s phone number.' };
    return { available: true, bot: bot.value };
  }

  private async botNumber(): Promise<{ value: BotNumber | null; reason?: string }> {
    const fixed = getConfig().whatsapp.displayPhone;
    if (fixed) {
      const value = botNumberFrom(fixed);
      return value ? { value } : { value: null, reason: 'WHATSAPP_DISPLAY_PHONE is not a phone number (8-15 digits with the country code).' };
    }
    const hit = this.botCache;
    if (hit && Date.now() - hit.at < (hit.ok ? BOT_CACHE_OK_MS : BOT_CACHE_FAIL_MS)) return { value: hit.value, reason: hit.reason };
    const c = await this.creds();
    let value: BotNumber | null = null;
    let reason: string | undefined;
    if (this.credentials && c.accessToken && c.phoneNumberId) {
      const check = await this.credentials.check(c.accessToken, c.phoneNumberId);
      value = check.ok ? botNumberFrom(check.displayPhoneNumber, check.verifiedName) : null;
      if (!value) reason = check.ok ? 'Meta did not return the bot’s phone number. Set WHATSAPP_DISPLAY_PHONE in the server settings.' : `Meta did not answer about the WhatsApp bot (${check.message || 'unknown error'}).`;
    } else reason = 'Set WHATSAPP_DISPLAY_PHONE in the server settings.';
    this.botCache = { at: Date.now(), ok: Boolean(value), value, reason };
    return { value, reason };
  }

  /** Settings changed (a new token or phone number): look the number up again next time. */
  forgetBotNumber(): void {
    this.botCache = null;
  }

  // ---- the sign-in page ------------------------------------------------------------------------

  start(client: ClientInfo, replaces?: unknown) {
    const { challenge, token } = this.challenges.create(client, replaces);
    return { challenge, token };
  }

  /** The waiting page: holds the request until something happens (at most POLL_HOLD_MS), then reports it. */
  async poll(token: unknown, client: ClientInfo, signal?: AbortSignal, holdMs = POLL_HOLD_MS): Promise<PollOutcome> {
    const c = this.challenges.lookup(token);
    if (!c) return { status: 'expired' }; // unknown: it ran out long ago, or the server restarted
    if (c.state === 'pending') {
      await this.challenges.waitForChange(c, holdMs, signal);
      this.challenges.lookup(token); // applies the expiry
      if (c.state === 'pending') return { status: 'pending', expiresAt: c.expiresAt, ...(c.rejectedFrom ? { rejectedFrom: c.rejectedFrom } : {}) };
    }
    if (c.state === 'approved') {
      if (signal?.aborted) return { status: 'pending', expiresAt: c.expiresAt }; // nobody is listening: leave it for the next ask
      const mine = this.challenges.consume(token);
      if (!mine || !mine.approvedBy) return { status: 'used' };
      const s = await this.auth.signInWithWhatsApp(mine.approvedBy, client, mine.id);
      // "That wasn't me" may have been tapped while the session was being written: honour it
      if (this.challenges.get(mine.id)?.state === 'cancelled') {
        await this.auth.endSessionsOfChallenge(mine.id);
        return { status: 'cancelled', by: 'whatsapp' };
      }
      return { status: 'approved', token: s.token, username: s.username, maxAgeSeconds: s.maxAgeSeconds, phoneTail: phoneTail(mine.approvedBy) };
    }
    if (c.state === 'consumed') return { status: 'used' };
    if (c.state === 'cancelled') return { status: 'cancelled', by: c.cancelledBy };
    return { status: 'expired' };
  }

  /** The page moved on (password tab, closed dialog): its code stops working. */
  cancelFromBrowser(token: unknown): boolean {
    const c = this.challenges.lookup(token);
    if (!c || c.state !== 'pending') return false;
    this.challenges.cancel(c, 'browser');
    return true;
  }

  // ---- WhatsApp side ---------------------------------------------------------------------------

  /**
   * A text arrived on WhatsApp. Returns the bot's answer when it was a sign-in (or "sign out everywhere"), or null when
   * it was something else and the chat should carry on as usual. `allowed`: the sender is on the allowed list.
   */
  async onWhatsAppText(phone: string, text: unknown, allowed: boolean): Promise<BotReply | null> {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (allowed && SIGN_OUT_EVERYWHERE.has(raw.toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' '))) return this.signOutEverywhere(phone);

    const parsed = parseLoginCode(raw);
    if (!parsed) return null;
    // bare digits are only a sign-in when they are one of our codes: "482915" could be a reply to something else
    if (!parsed.explicit && !this.challenges.knows(parsed.code)) return null;
    const pretty = formatCode(parsed.code);

    if (!allowed) {
      // never approve; the waiting page is told a wrong number sent it, and the chat answers as it does for strangers
      if (this.challenges.reject(parsed.code, phone)) this.logger.warn(`Sign-in code ${pretty} was sent from a number that is not allowed (ending ${phoneTail(phone)}). Not approved.`);
      return null;
    }
    if (!getConfig().auth.enabled || !getConfig().auth.whatsappLogin) {
      return { text: '🔐 Signing in to the studio with WhatsApp is switched off on the server. Use the password on the sign-in page.' };
    }

    const r = this.challenges.approve(parsed.code, phone);
    if (r.result === 'approved') {
      const c = r.challenge;
      const device = describeDevice(c.client.userAgent);
      this.logger.log(`Sign-in code ${pretty} approved from WhatsApp (number ending ${phoneTail(phone)}) for ${device} at ${c.client.ip}`);
      const body =
        `✅ *Signed in to the studio*\n\n` +
        `💻 ${device}\n` +
        `🌐 ${c.client.ip || 'unknown address'}\n\n` +
        `The sign-in page opens the studio by itself.`;
      return {
        text: `${body}\n\nNot you? Tap *That wasn't me* and this sign-in ends at once.`,
        buttons: [{ id: `${DENY_PREFIX}${c.id}`, title: "That wasn't me" }],
        fallback: `${body}\n\nNot you? Send *Sign out everywhere* and every sign-in ends at once.`
      };
    }
    if (r.result === 'used') return { text: `☑️ Code ${pretty} was already used, so that sign-in is done. Nothing else to do.` };
    if (r.result === 'cancelled') {
      return { text: `🚫 Code ${pretty} was cancelled${r.challenge?.cancelledBy === 'everywhere' ? ' when you signed out everywhere' : ''}. Open the sign-in page for a new code.` };
    }
    if (r.result === 'expired') return { text: `⌛ Code ${pretty} has expired (codes last ${Math.round(this.challenges.ttlMs / 60_000)} minutes). The sign-in page shows a fresh one: send that.` };
    return { text: `🤔 No sign-in is waiting for code ${pretty}. Check the code on the sign-in page and send it again.` };
  }

  /** A reply button was tapped. Returns the answer when it was ours ("That wasn't me"), null otherwise. */
  async onWhatsAppButton(phone: string, id: string, allowed: boolean): Promise<BotReply | null> {
    if (!id.startsWith(DENY_PREFIX)) return null;
    if (!allowed) return null;
    const c = this.challenges.get(id.slice(DENY_PREFIX.length));
    const ended = c ? await this.auth.endSessionsOfChallenge(c.id) : 0;
    const before = c ? this.challenges.cancel(c, 'whatsapp') : 'expired';
    // the session may have been written between the two lines above: end it again, it costs nothing
    const late = c && before !== 'pending' ? await this.auth.endSessionsOfChallenge(c.id) : 0;
    const device = c ? describeDevice(c.client.userAgent) : 'that device';
    if (ended + late > 0 || before === 'approved' || before === 'consumed') {
      this.logger.warn(`WhatsApp sign-in on ${device} was ended from WhatsApp ("That wasn't me", number ending ${phoneTail(phone)})`);
      return {
        text:
          `🔒 *Signed out.* The sign-in on ${device} has ended and its code no longer works.\n\n` +
          `If you did not ask for that code, someone has the studio's address open. Your other sign-ins are untouched: send *Sign out everywhere* to end them too.`
      };
    }
    return { text: '🔒 That sign-in had already ended. Nothing else changed.' };
  }

  private async signOutEverywhere(phone: string): Promise<BotReply> {
    const sessions = await this.auth.endAllSessions();
    const codes = this.challenges.cancelAll();
    this.logger.warn(`Signed out everywhere from WhatsApp (number ending ${phoneTail(phone)}): ${sessions} session(s), ${codes} waiting code(s)`);
    const what = sessions === 0 ? 'No device was signed in' : `${sessions} sign-in${sessions === 1 ? '' : 's'} ended`;
    return { text: `🔒 *Signed out everywhere.* ${what}${codes ? `, and ${codes} waiting code${codes === 1 ? '' : 's'} stopped working` : ''}.\n\nTo use the studio again, open the sign-in page and send the new code.` };
  }
}
