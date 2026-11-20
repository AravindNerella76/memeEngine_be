import * as crypto from 'crypto';
import { AttemptTracker } from './attempt-tracker';
import { hashToken, isWellFormedToken, newSessionToken } from './session-token';

/**
 * Sign-in codes for "send this code from your WhatsApp".
 *
 * The sign-in page asks for a challenge and gets two things: a 6-digit CODE that the person sends from WhatsApp, and a
 * secret TOKEN the browser keeps to itself. The code is only a label that links a WhatsApp message to a waiting browser;
 * what proves who you are is that the message came from an allowed number (Meta signs every webhook). The browser waits
 * with its token, never with the code, so seeing someone's code on a screen gets you nothing.
 *
 * In memory on purpose: a code lives five minutes, and a restart only means "get a new code".
 */

export type ChallengeState = 'pending' | 'approved' | 'consumed' | 'cancelled' | 'expired';

export interface ChallengeClient {
  ip: string;
  userAgent: string;
}

export interface Challenge {
  id: string;
  code: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  state: ChallengeState;
  client: ChallengeClient;
  /** The allowed number that approved it (digits). */
  approvedBy?: string;
  approvedAt?: number;
  /** The code arrived from a number that is NOT allowed: the last digits, so the page can say so. */
  rejectedFrom?: string;
  /** Why it was cancelled: from the browser itself, from WhatsApp ("That wasn't me"), or by "Sign out everywhere". */
  cancelledBy?: 'browser' | 'whatsapp' | 'everywhere';
}

export type ApproveResult =
  | { result: 'approved'; challenge: Challenge }
  | { result: 'expired' | 'used' | 'cancelled' | 'unknown'; challenge?: Challenge };

export interface ChallengeOptions {
  /** How long a code can be sent (default 5 minutes). */
  ttlMs?: number;
  /** After approval the browser has this long to collect its session (it is normally waiting already). */
  collectMs?: number;
  /** Finished codes are remembered this long, so a late message gets "expired" instead of "never heard of it". */
  tombstoneMs?: number;
  /** At most this many codes waiting at once, from everyone together. */
  maxActive?: number;
  /** New codes per address in `perIpWindowMs`. */
  perIpMax?: number;
  perIpWindowMs?: number;
}

export class TooManyChallengesError extends Error {
  constructor(public readonly retryAfterSec: number, public readonly scope: 'ip' | 'global') {
    super(scope === 'ip' ? 'Too many sign-in codes from this device.' : 'Too many sign-in codes are waiting right now.');
  }
}

const CODE_DIGITS = 6;

/** "482915" -> "482 915": easier to read off a screen and to type. */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * Is this WhatsApp text a sign-in code? Accepts "482915", "482 915", "482-915", "Login 482915", "login: 482 915",
 * "sign in 482915", "code 482915". `explicit` is true when it says so in words: then it is surely meant as a sign-in,
 * even when no such code exists. Bare digits are only a sign-in when they match a code we handed out.
 */
export function parseLoginCode(text: unknown): { code: string; explicit: boolean } | null {
  if (typeof text !== 'string' || text.length > 40) return null;
  const m = text.trim().match(/^(?:(log\s*-?\s*in|sign\s*-?\s*in|code|otp)\s*[:#-]?\s*)?(\d{3})[\s.-]?(\d{3})[.!]?$/i);
  if (!m) return null;
  return { code: m[2] + m[3], explicit: Boolean(m[1]) };
}

/** The last 4 digits, for showing a number without spelling it out: "•••• 8120". */
export const phoneTail = (digits: string): string => String(digits || '').replace(/\D/g, '').slice(-4);

export class WhatsAppChallenges {
  private readonly byId = new Map<string, Challenge>();
  private readonly byToken = new Map<string, Challenge>();
  private readonly byCode = new Map<string, Challenge>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly perIp: AttemptTracker;
  private readonly o: Required<ChallengeOptions>;

  constructor(opts: ChallengeOptions = {}, private readonly now: () => number = Date.now) {
    this.o = {
      ttlMs: opts.ttlMs ?? 5 * 60_000,
      collectMs: opts.collectMs ?? 2 * 60_000,
      tombstoneMs: opts.tombstoneMs ?? 30 * 60_000,
      maxActive: opts.maxActive ?? 100,
      perIpMax: opts.perIpMax ?? 12,
      perIpWindowMs: opts.perIpWindowMs ?? 10 * 60_000
    };
    // A "failure" here is simply one new code: the tracker counts them and pauses the address at the limit.
    this.perIp = new AttemptTracker({ maxFailures: this.o.perIpMax, windowMs: this.o.perIpWindowMs, lockMs: this.o.perIpWindowMs }, now);
  }

  get ttlMs(): number {
    return this.o.ttlMs;
  }

  /**
   * A new code for this browser. `replacesToken` is the browser's previous code (a "new code" press or a code that ran
   * out): it is cancelled first and does not count against the address, so renewing never locks anyone out.
   */
  create(client: ChallengeClient, replacesToken?: unknown): { challenge: Challenge; token: string } {
    this.prune();
    const replaced = this.lookup(replacesToken);
    const renewing = Boolean(replaced && (replaced.state === 'pending' || replaced.state === 'expired'));
    if (replaced && replaced.state === 'pending') this.finish(replaced, 'cancelled', 'browser');

    const ipKey = client.ip || 'unknown';
    const gate = this.perIp.check(ipKey);
    if (gate.blocked) throw new TooManyChallengesError(gate.retryAfterSec, 'ip');
    if (this.activeCount() >= this.o.maxActive) throw new TooManyChallengesError(60, 'global');
    if (!renewing) this.perIp.fail(ipKey);

    const token = newSessionToken();
    const t = this.now();
    const challenge: Challenge = {
      id: crypto.randomBytes(9).toString('base64url'),
      code: this.freshCode(),
      tokenHash: hashToken(token),
      createdAt: t,
      expiresAt: t + this.o.ttlMs,
      state: 'pending',
      client: { ip: String(client.ip || '').slice(0, 64), userAgent: String(client.userAgent || '').slice(0, 300) }
    };
    this.byId.set(challenge.id, challenge);
    this.byToken.set(challenge.tokenHash, challenge);
    this.byCode.set(challenge.code, challenge);
    return { challenge, token };
  }

  /** The browser's challenge, with its expiry applied. null for an unknown or malformed token. */
  lookup(token: unknown): Challenge | null {
    if (!isWellFormedToken(token)) return null;
    const c = this.byToken.get(hashToken(token));
    return c ? this.refresh(c) : null;
  }

  get(id: string): Challenge | null {
    const c = this.byId.get(String(id));
    return c ? this.refresh(c) : null;
  }

  /** Is this one of our codes (waiting, or finished recently)? Decides whether bare digits on WhatsApp are a sign-in. */
  knows(code: string): boolean {
    return this.byCode.has(code);
  }

  /** An allowed number sent this code. */
  approve(code: string, phone: string): ApproveResult {
    const c = this.byCode.get(code);
    if (!c) return { result: 'unknown' };
    this.refresh(c);
    if (c.state === 'pending') {
      c.state = 'approved';
      c.approvedBy = String(phone).replace(/\D/g, '');
      c.approvedAt = this.now();
      // the browser is normally waiting right now; if it is asleep (a phone switching apps) it gets a little longer
      c.expiresAt = Math.max(c.expiresAt, this.now() + this.o.collectMs);
      this.notify(c);
      return { result: 'approved', challenge: c };
    }
    if (c.state === 'approved' || c.state === 'consumed') return { result: 'used', challenge: c };
    if (c.state === 'cancelled') return { result: 'cancelled', challenge: c };
    return { result: 'expired', challenge: c };
  }

  /** The code arrived from a number that is not allowed. Nothing is approved; the waiting page is told. */
  reject(code: string, phone: string): boolean {
    const c = this.byCode.get(code);
    if (!c || this.refresh(c).state !== 'pending') return false;
    c.rejectedFrom = phoneTail(phone);
    this.notify(c);
    return true;
  }

  /** The browser collects its approval: works exactly once. */
  consume(token: unknown): Challenge | null {
    const c = this.lookup(token);
    if (!c || c.state !== 'approved') return null;
    c.state = 'consumed';
    return c;
  }

  /**
   * Ends a challenge. Returns its state just before, so the caller knows whether a session may already exist. A collected
   * code is marked too: the browser may be creating its session at this very moment and checks this mark afterwards.
   */
  cancel(c: Challenge, by: NonNullable<Challenge['cancelledBy']>): ChallengeState {
    const before = this.refresh(c).state;
    if (before === 'pending' || before === 'approved' || before === 'consumed') this.finish(c, 'cancelled', by);
    return before;
  }

  /** "Sign out everywhere": every waiting or approved code stops working. */
  cancelAll(): number {
    let n = 0;
    for (const c of this.byId.values()) {
      const s = this.refresh(c).state;
      if (s === 'pending' || s === 'approved') {
        this.finish(c, 'cancelled', 'everywhere');
        n++;
      }
    }
    return n;
  }

  /**
   * Waits until this challenge changes (approved, rejected, cancelled) or expires, at most `ms`. The sign-in page holds
   * one such request open, so an approval reaches it the moment the WhatsApp message arrives.
   */
  waitForChange(c: Challenge, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const set = this.waiters.get(c.id) || new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.waiters.delete(c.id);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const until = Math.max(0, Math.min(ms, c.expiresAt - this.now() + 25));
      const timer = setTimeout(done, until); // at most 25 s: a waiting page keeps it, nothing lingers after
      set.add(done);
      this.waiters.set(c.id, set);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  activeCount(): number {
    let n = 0;
    for (const c of this.byId.values()) if (this.refresh(c).state === 'pending') n++;
    return n;
  }

  // ---- internals ------------------------------------------------------------------------------

  private freshCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
      // never hand out a code that is waiting or finished recently: a late message must not approve someone else
      if (!this.byCode.has(code) && !/^(\d)\1+$/.test(code)) return code;
    }
    throw new TooManyChallengesError(60, 'global');
  }

  private refresh(c: Challenge): Challenge {
    if ((c.state === 'pending' || c.state === 'approved') && c.expiresAt <= this.now()) this.finish(c, 'expired');
    return c;
  }

  private finish(c: Challenge, state: ChallengeState, by?: Challenge['cancelledBy']): void {
    c.state = state;
    if (by) c.cancelledBy = by;
    this.notify(c);
  }

  private notify(c: Challenge): void {
    const set = this.waiters.get(c.id);
    if (set) for (const w of [...set]) w();
  }

  private prune(): void {
    const t = this.now();
    for (const c of this.byId.values()) {
      this.refresh(c);
      const ended = c.state === 'pending' || c.state === 'approved' ? Infinity : Math.max(c.expiresAt, c.approvedAt || 0, c.createdAt);
      if (t - ended > this.o.tombstoneMs || (c.state !== 'pending' && c.state !== 'approved' && this.byId.size > 2000)) {
        this.byId.delete(c.id);
        this.byToken.delete(c.tokenHash);
        if (this.byCode.get(c.code) === c) this.byCode.delete(c.code);
      }
    }
  }
}
