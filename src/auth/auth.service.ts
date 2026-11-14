import { HttpException, Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request } from 'express';
import { getConfig } from '../config/app-config';
import { AttemptTracker } from './attempt-tracker';
import { AuthSession, AuthSessionDocument, AuthUser, AuthUserDocument } from './auth.schemas';
import { readCookie, sessionCookieName } from './cookies';
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from './password';
import { hashToken, isWellFormedToken, newSessionToken } from './session-token';

export interface AuthContext {
  userId: string;
  username: string;
  tokenHash: string;
}

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

export class TooManyAttemptsException extends HttpException {
  constructor(public readonly retryAfterSec: number) {
    super(
      {
        statusCode: 429,
        code: 'too_many_attempts',
        message: `Too many wrong attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute${Math.ceil(retryAfterSec / 60) === 1 ? '' : 's'}.`,
        retryAfterSeconds: retryAfterSec
      },
      429
    );
  }
}

const DAY_MS = 86_400_000;
const SLIDE_AFTER_MS = 5 * 60_000; // refresh the idle expiry at most every 5 minutes: one write, not one per request

/** Usernames are lower-case 3-100 characters: letters, digits and . _ @ + - (so an e-mail address works). */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return /^[a-z0-9._@+-]{3,100}$/.test(u) ? u : null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private ownerKnown = false;

  // Three nets, so an attacker cannot lock the owner out from their own address:
  //  - per username AND address: the strict one (a few wrong tries, then a lock)
  //  - per address: slows down someone trying many usernames
  //  - per username from anywhere: a high ceiling against guessing spread over many addresses
  private readonly byUserAndIp: AttemptTracker;
  private readonly byIp: AttemptTracker;
  private readonly byUser: AttemptTracker;

  constructor(
    @InjectModel(AuthUser.name) private readonly users: Model<AuthUserDocument>,
    @InjectModel(AuthSession.name) private readonly sessions: Model<AuthSessionDocument>
  ) {
    const c = getConfig().auth;
    const base = { windowMs: c.lockMinutes * 60_000, lockMs: c.lockMinutes * 60_000 };
    this.byUserAndIp = new AttemptTracker({ ...base, maxFailures: c.maxFailures });
    this.byIp = new AttemptTracker({ ...base, maxFailures: c.maxFailures * 4 });
    this.byUser = new AttemptTracker({ ...base, maxFailures: c.maxFailures * 10 });
  }

  // ---- owner -------------------------------------------------------------------------------------

  async ownerExists(): Promise<boolean> {
    if (this.ownerKnown) return true;
    this.ownerKnown = (await this.users.estimatedDocumentCount()) > 0;
    return this.ownerKnown;
  }

  // ---- sign in / out -----------------------------------------------------------------------------

  async login(rawUsername: unknown, password: unknown, client: ClientInfo): Promise<{ token: string; username: string; maxAgeSeconds: number }> {
    const username = normalizeUsername(rawUsername);
    const pw = typeof password === 'string' ? password : '';
    const keys = { pair: `${username}|${client.ip}`, ip: client.ip, user: String(username) };

    for (const [tracker, key] of [[this.byUserAndIp, keys.pair], [this.byIp, keys.ip], [this.byUser, keys.user]] as const) {
      const c = tracker.check(key);
      if (c.blocked) throw new TooManyAttemptsException(c.retryAfterSec);
    }

    // Always do one full password check, even for an unknown username, so timing does not reveal accounts.
    const user = username ? await this.users.findOne({ username }) : null;
    const result = user ? await verifyPassword(pw, user.passwordHash) : (await verifyPassword(pw, await dummyHash()), { ok: false, needsRehash: false });

    if (!user || !result.ok) {
      const locked = this.byUserAndIp.fail(keys.pair);
      this.byIp.fail(keys.ip);
      this.byUser.fail(keys.user);
      this.logger.warn(`Failed sign-in for "${String(username || '(invalid)').slice(0, 40)}" from ${client.ip}${locked ? ' (now locked)' : ''}`);
      if (locked) throw new TooManyAttemptsException(getConfig().auth.lockMinutes * 60);
      throw new UnauthorizedException({ statusCode: 401, code: 'invalid_credentials', message: 'Wrong username or password.' });
    }

    this.byUserAndIp.success(keys.pair);
    this.byUser.success(keys.user);
    const update: Record<string, unknown> = { lastLoginAt: new Date() };
    if (result.needsRehash) update.passwordHash = await hashPassword(pw);
    await this.users.updateOne({ _id: user._id }, { $set: update });

    const created = await this.createSession(String(user._id), client);
    this.logger.log(`Signed in "${user.username}" from ${client.ip}`);
    return { ...created, username: user.username };
  }

  private async createSession(userId: string, client: ClientInfo): Promise<{ token: string; maxAgeSeconds: number }> {
    const c = getConfig().auth;
    const now = Date.now();
    const absolute = now + c.sessionMaxDays * DAY_MS;
    const idle = Math.min(now + c.sessionIdleDays * DAY_MS, absolute);
    const token = newSessionToken();
    await this.sessions.create({
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(idle),
      absoluteExpiresAt: new Date(absolute),
      lastSeenAt: new Date(now),
      userAgent: String(client.userAgent || '').slice(0, 300),
      ip: String(client.ip || '').slice(0, 64)
    });
    return { token, maxAgeSeconds: Math.floor((idle - now) / 1000) };
  }

  /** Who is making this request? null when there is no valid, unexpired session cookie. */
  async sessionFromRequest(req: Request): Promise<AuthContext | null> {
    const token = readCookie(req.headers.cookie, sessionCookieName(getConfig().auth.cookieSecure));
    return this.validateSession(token);
  }

  async validateSession(token: unknown): Promise<AuthContext | null> {
    if (!isWellFormedToken(token)) return null;
    const tokenHash = hashToken(token);
    const s = await this.sessions.findOne({ tokenHash });
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt.getTime() <= now || s.absoluteExpiresAt.getTime() <= now) {
      await this.sessions.deleteOne({ _id: s._id });
      return null;
    }
    const user = await this.users.findById(s.userId);
    if (!user) {
      await this.sessions.deleteOne({ _id: s._id });
      return null;
    }
    if (now - s.lastSeenAt.getTime() > SLIDE_AFTER_MS) {
      const idle = Math.min(now + getConfig().auth.sessionIdleDays * DAY_MS, s.absoluteExpiresAt.getTime());
      await this.sessions.updateOne({ _id: s._id }, { $set: { lastSeenAt: new Date(now), expiresAt: new Date(idle) } });
    }
    return { userId: String(user._id), username: user.username, tokenHash };
  }

  async logout(token: unknown): Promise<void> {
    if (isWellFormedToken(token)) await this.sessions.deleteOne({ tokenHash: hashToken(token) });
  }

  /** Ends every session of the user (optionally keeping the current one). Returns how many were ended. */
  async logoutOthers(userId: string, keepTokenHash?: string): Promise<number> {
    const filter: Record<string, unknown> = { userId };
    if (keepTokenHash) filter.tokenHash = { $ne: keepTokenHash };
    const r = await this.sessions.deleteMany(filter);
    return r.deletedCount || 0;
  }

  async listSessions(userId: string, currentHash: string) {
    const rows = await this.sessions.find({ userId, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean();
    return rows.map(r => ({
      current: r.tokenHash === currentHash,
      signedInAt: (r as any).createdAt as Date,
      lastSeenAt: r.lastSeenAt,
      userAgent: r.userAgent,
      ip: r.ip
    }));
  }

  // ---- password ----------------------------------------------------------------------------------

  async changePassword(ctx: AuthContext, current: unknown, next: unknown, client: ClientInfo): Promise<{ otherSessionsEnded: number }> {
    const key = `pw|${ctx.userId}|${client.ip}`;
    const c = this.byUserAndIp.check(key);
    if (c.blocked) throw new TooManyAttemptsException(c.retryAfterSec);

    const user = await this.users.findById(ctx.userId);
    const ok = user && typeof current === 'string' ? (await verifyPassword(current, user.passwordHash)).ok : false;
    if (!ok) {
      const locked = this.byUserAndIp.fail(key);
      if (locked) throw new TooManyAttemptsException(getConfig().auth.lockMinutes * 60);
      throw new BadRequestException({ statusCode: 400, code: 'wrong_current_password', message: 'The current password is not right.' });
    }
    this.byUserAndIp.success(key);

    const problems = passwordProblems(next, ctx.username);
    if (problems.length) throw new BadRequestException({ statusCode: 400, code: 'weak_password', message: problems[0], problems });
    if (next === current) throw new BadRequestException({ statusCode: 400, code: 'same_password', message: 'Choose a password you have not used just now.' });

    await this.users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(next as string), passwordChangedAt: new Date() } });
    const ended = await this.logoutOthers(ctx.userId, ctx.tokenHash);
    this.logger.log(`Password changed for "${ctx.username}"; ${ended} other session(s) ended`);
    return { otherSessionsEnded: ended };
  }
}
