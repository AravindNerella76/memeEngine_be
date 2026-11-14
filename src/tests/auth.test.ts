/**
 * Sign-in building blocks: hashing, tokens, cookies, lockout, configuration, the HTTP guards and the
 * global AuthGuard. No database needed (see auth.integration.test.ts for the full flow).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AttemptTracker } from '../auth/attempt-tracker';
import { AuthGuard } from '../auth/auth.guard';
import { normalizeUsername } from '../auth/auth.service';
import { clearedSessionCookie, readCookie, sessionCookie, sessionCookieName } from '../auth/cookies';
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from '../auth/password';
import { Public } from '../auth/public.decorator';
import { hashToken, isWellFormedToken, newSessionToken } from '../auth/session-token';
import { describeConfig, loadConfig, parseHostList, setConfigForTests } from '../config/app-config';
import { defaultGuardOptions, hostAndOriginGuard, tunnelPathGuard } from '../security/http-guards';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.match(h, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.equal((await verifyPassword('correct horse battery staple', h)).ok, true);
    assert.equal((await verifyPassword('correct horse battery stapl3', h)).ok, false);
    assert.equal((await verifyPassword('', h)).ok, false);
  });

  it('salts every hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    assert.notEqual(a, b);
  });

  it('treats the same visible text the same way (Unicode normalisation)', async () => {
    const h = await hashPassword('café au lait 12345'); // é as one character
    assert.equal((await verifyPassword('café au lait 12345', h)).ok, true); // e + combining accent
  });

  it('flags a hash made with weaker parameters for an upgrade, and still verifies it', async () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('old password value', salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const old = ['scrypt', 2 ** 14, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
    const r = await verifyPassword('old password value', old);
    assert.deepEqual(r, { ok: true, needsRehash: true });
    assert.deepEqual(await verifyPassword('wrong', old), { ok: false, needsRehash: false });
  });

  it('rejects malformed or absurd hashes quickly instead of hanging or throwing', async () => {
    for (const bad of ['', 'plain', 'scrypt$1$2$3', 'bcrypt$x$y$z$a$b', 'scrypt$1073741824$8$1$AAAA$AAAA', 'scrypt$32768$8$1$$']) {
      assert.deepEqual(await verifyPassword('x', bad), { ok: false, needsRehash: false }, bad);
    }
    assert.equal((await verifyPassword('x'.repeat(5000), await dummyHash())).ok, false, 'oversized input refused');
  });

  it('dummyHash is a real hash (so unknown users cost the same time)', async () => {
    assert.match(await dummyHash(), /^scrypt\$/);
  });
});

describe('password policy', () => {
  it('accepts a long passphrase', () => assert.deepEqual(passwordProblems('purple-mango-telescope-river'), []));
  it('requires 12 characters', () => assert.ok(passwordProblems('short1!').length));
  it('refuses very common passwords, repeats and the username', () => {
    assert.ok(passwordProblems('password123').length);
    assert.ok(passwordProblems('aaaaaaaaaaaaaaaa').length);
    assert.ok(passwordProblems('my-kanyaraasi-secret-1', 'kanyaraasi').length);
  });
  it('rejects non-strings', () => {
    assert.ok(passwordProblems(undefined).length);
    assert.ok(passwordProblems({ $ne: '' }).length);
  });
});

describe('usernames', () => {
  it('trims and lower-cases; accepts an e-mail address', () => {
    assert.equal(normalizeUsername('  Owner@Example.com '), 'owner@example.com');
  });
  it('rejects anything that is not plain text of a sane shape', () => {
    for (const bad of [undefined, null, 42, { $ne: '' }, ['a'], 'ab', 'has space', 'x'.repeat(101), '<script>', 'a/b']) assert.equal(normalizeUsername(bad), null, String(bad));
  });
});

describe('session tokens and cookies', () => {
  it('makes unguessable 43-character tokens and stores only their hash', () => {
    const t = newSessionToken();
    assert.ok(isWellFormedToken(t));
    assert.notEqual(newSessionToken(), t);
    assert.equal(hashToken(t), hashToken(t));
    assert.notEqual(hashToken(t), t);
    assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  });
  it('rejects malformed tokens before any database lookup', () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(44), `${'a'.repeat(42)}!`, { a: 1 }]) assert.equal(isWellFormedToken(bad), false);
  });
  it('uses the __Host- prefix only on HTTPS', () => {
    assert.equal(sessionCookieName(true), '__Host-me_session');
    assert.equal(sessionCookieName(false), 'me_session');
  });
  it('builds a safe cookie', () => {
    const c = sessionCookie('abc', { secure: true, maxAgeSeconds: 100.9 });
    for (const part of ['__Host-me_session=abc', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=100', 'Secure']) assert.ok(c.includes(part), part);
    assert.ok(!c.includes('Domain'), '__Host- cookies must not set Domain');
    assert.ok(!sessionCookie('abc', { secure: false, maxAgeSeconds: 1 }).includes('Secure'));
    assert.ok(clearedSessionCookie(true).includes('Max-Age=0'));
  });
  it('reads one cookie out of many and survives bad encoding', () => {
    assert.equal(readCookie('a=1; me_session=tok; b=2', 'me_session'), 'tok');
    assert.equal(readCookie('a=1', 'me_session'), undefined);
    assert.equal(readCookie(undefined, 'x'), undefined);
    assert.equal(readCookie('me_session=%E0%A4%A', 'me_session'), undefined);
  });
});

describe('AttemptTracker (lockout)', () => {
  let now = 1_000_000;
  const clock = () => now;
  const make = (max = 3) => new AttemptTracker({ maxFailures: max, windowMs: 60_000, lockMs: 120_000, maxKeys: 5 }, clock);
  afterEach(() => {
    now = 1_000_000;
  });

  it('locks after the limit and reports when to retry', () => {
    const t = make();
    assert.equal(t.fail('k'), false);
    assert.equal(t.fail('k'), false);
    assert.equal(t.check('k').blocked, false);
    assert.equal(t.fail('k'), true);
    const c = t.check('k');
    assert.equal(c.blocked, true);
    assert.equal(c.retryAfterSec, 120);
    now += 30_000;
    assert.equal(t.check('k').retryAfterSec, 90);
  });
  it('unlocks by itself', () => {
    const t = make();
    for (let i = 0; i < 3; i++) t.fail('k');
    now += 121_000;
    assert.equal(t.check('k').blocked, false);
  });
  it('forgets old failures (sliding window)', () => {
    const t = make();
    t.fail('k');
    t.fail('k');
    now += 61_000;
    assert.equal(t.fail('k'), false, 'the earlier two are outside the window');
  });
  it('a correct password clears the count', () => {
    const t = make();
    t.fail('k');
    t.fail('k');
    t.success('k');
    assert.equal(t.fail('k'), false);
  });
  it('keys are independent', () => {
    const t = make();
    for (let i = 0; i < 3; i++) t.fail('a');
    assert.equal(t.check('a').blocked, true);
    assert.equal(t.check('b').blocked, false);
  });
  it('keeps memory bounded under a flood of different keys', () => {
    const t = make();
    for (let i = 0; i < 100; i++) t.fail(`k${i}`);
    assert.ok(t.size <= 5, `size ${t.size}`);
  });
});

describe('auth configuration', () => {
  it('is secure by default for local use', () => {
    const a = loadConfig({}).auth;
    assert.equal(a.enabled, true);
    assert.equal(a.cookieSecure, false); // http://localhost
    assert.equal(a.appPublicUrl, 'http://localhost:5173');
    assert.deepEqual(a.appHosts, []);
    assert.equal(a.trustProxy, 0);
    assert.equal(a.maxFailures, 5);
  });
  it('turns on Secure cookies for an https public URL', () => {
    const a = loadConfig({ APP_PUBLIC_URL: 'https://studio.example.com/', APP_HOSTS: 'Studio.Example.com', TRUST_PROXY: '1' }).auth;
    assert.equal(a.cookieSecure, true);
    assert.equal(a.appPublicUrl, 'https://studio.example.com');
    assert.deepEqual(a.appHosts, ['studio.example.com']);
    assert.equal(a.trustProxy, 1);
  });
  it('clamps numbers into safe ranges', () => {
    const a = loadConfig({ AUTH_MAX_FAILURES: '1', AUTH_LOCK_MINUTES: '999999', AUTH_SESSION_IDLE_DAYS: '0', TRUST_PROXY: '99' }).auth;
    assert.equal(a.maxFailures, 3);
    assert.equal(a.lockMinutes, 1440);
    assert.equal(a.sessionIdleDays, 1);
    assert.equal(a.trustProxy, 5);
  });
  it('parses host lists', () => {
    assert.deepEqual(parseHostList('https://A.example.com:443/x, b.example.com:8080 ,,'), ['a.example.com', 'b.example.com']);
    assert.deepEqual(parseHostList(undefined), []);
  });
});

// ---- HTTP guards -----------------------------------------------------------------------------------

function run(mw: (req: any, res: any, next: () => void) => void, req: { method: string; path: string; headers: Record<string, string> }) {
  let status = 0;
  let nexted = false;
  const res: any = { status: (s: number) => ({ json: () => void (status = s) }) };
  mw(req, res, () => (nexted = true));
  return { status, nexted };
}

describe('hosting guards (APP_HOSTS)', () => {
  const env = { APP_HOSTS: 'studio.example.com', APP_PUBLIC_URL: 'https://studio.example.com' } as NodeJS.ProcessEnv;
  const opts = defaultGuardOptions(env);

  it('allows the public host and its own origin to make changes', () => {
    assert.ok(opts.allowedHosts.includes('studio.example.com'));
    const r = run(hostAndOriginGuard(opts), { method: 'POST', path: '/api/auth/login', headers: { host: 'studio.example.com', origin: 'https://studio.example.com' } });
    assert.equal(r.nexted, true);
  });
  it('still refuses a foreign origin and an unknown host', () => {
    assert.equal(run(hostAndOriginGuard(opts), { method: 'POST', path: '/x', headers: { host: 'studio.example.com', origin: 'https://evil.example' } }).status, 403);
    assert.equal(run(hostAndOriginGuard(opts), { method: 'GET', path: '/x', headers: { host: 'evil.example' } }).status, 403);
  });
  it('the public app host reaches the whole app (login protects it); a tunnel host stays limited', () => {
    const guard = tunnelPathGuard(['studio.example.com']);
    assert.equal(run(guard, { method: 'GET', path: '/api/memes', headers: { host: 'studio.example.com' } }).nexted, true);
    assert.equal(run(guard, { method: 'GET', path: '/api/memes', headers: { host: 'x.ngrok-free.dev' } }).status, 403);
    assert.equal(run(guard, { method: 'GET', path: '/api/instagram/auth/callback', headers: { host: 'x.ngrok-free.dev' } }).nexted, true);
    assert.equal(run(guard, { method: 'GET', path: '/api/memes', headers: { host: 'localhost:3000' } }).nexted, true);
  });
  it('without APP_HOSTS nothing changes for local use', () => {
    const local = defaultGuardOptions({} as NodeJS.ProcessEnv);
    assert.deepEqual(local.allowedHosts, ['localhost', '127.0.0.1', '[::1]']);
    assert.deepEqual(local.extraOrigins, []);
  });
});

// ---- AuthGuard ----------------------------------------------------------------------------------------

describe('AuthGuard', () => {
  class Routes {
    secret() {}
    open() {}
  }
  Public()(Routes.prototype, 'open', Object.getOwnPropertyDescriptor(Routes.prototype, 'open')!);

  const ctx = (handler: Function, req: any): ExecutionContext =>
    ({ getHandler: () => handler, getClass: () => Routes, switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
  const fakeAuth = (session: any, owner = true) => ({ sessionFromRequest: async () => session, ownerExists: async () => owner }) as any;
  const req = (method = 'GET', headers: Record<string, string> = {}) => ({ method, headers });
  const enable = (env: Record<string, string> = {}) => setConfigForTests(loadConfig(env));
  afterEach(() => setConfigForTests(null));

  it('lets public routes through without a session', async () => {
    enable();
    assert.equal(await new AuthGuard(new Reflector(), fakeAuth(null)).canActivate(ctx(Routes.prototype.open, req())), true);
  });
  it('refuses a protected route without a session, saying whether setup is needed', async () => {
    enable();
    await assert.rejects(new AuthGuard(new Reflector(), fakeAuth(null, true)).canActivate(ctx(Routes.prototype.secret, req())), (e: any) => {
      assert.equal(e.getStatus(), 401);
      assert.equal(e.getResponse().code, 'auth_required');
      assert.equal(e.getResponse().setupRequired, false);
      return true;
    });
    await assert.rejects(new AuthGuard(new Reflector(), fakeAuth(null, false)).canActivate(ctx(Routes.prototype.secret, req())), (e: any) => e.getResponse().setupRequired === true);
  });
  it('admits a signed-in request and exposes who it is', async () => {
    enable();
    const r: any = req();
    const s = { userId: '1', username: 'owner', tokenHash: 'h' };
    assert.equal(await new AuthGuard(new Reflector(), fakeAuth(s)).canActivate(ctx(Routes.prototype.secret, r)), true);
    assert.deepEqual(r.auth, s);
  });
  it('refuses a state-changing request the browser labels cross-site, even with a valid session', async () => {
    enable();
    const s = { userId: '1', username: 'owner', tokenHash: 'h' };
    const g = new AuthGuard(new Reflector(), fakeAuth(s));
    await assert.rejects(g.canActivate(ctx(Routes.prototype.secret, req('POST', { 'sec-fetch-site': 'cross-site' }))), (e: any) => e.getStatus() === 403);
    assert.equal(await g.canActivate(ctx(Routes.prototype.secret, req('POST', { 'sec-fetch-site': 'same-origin' }))), true);
    assert.equal(await g.canActivate(ctx(Routes.prototype.secret, req('POST', { 'sec-fetch-site': 'same-site' }))), true);
    assert.equal(await g.canActivate(ctx(Routes.prototype.secret, req('GET', { 'sec-fetch-site': 'cross-site' }))), true, 'reads are not state-changing');
  });
  it('does nothing when login is switched off', async () => {
    enable({ AUTH_ENABLED: 'false' });
    assert.equal(await new AuthGuard(new Reflector(), fakeAuth(null)).canActivate(ctx(Routes.prototype.secret, req())), true);
  });
});

describe('static login configuration (AUTH_STATIC_*)', () => {
  it('is off unless both the username and the password are set', () => {
    assert.equal(loadConfig({}).auth.staticUsername, undefined);
    assert.equal(loadConfig({ AUTH_STATIC_USERNAME: 'admin' }).auth.staticPassword, undefined);
    assert.equal(loadConfig({ AUTH_STATIC_PASSWORD: 'admin' }).auth.staticUsername, undefined);
    assert.equal(loadConfig({ AUTH_STATIC_USERNAME: 'admin', AUTH_STATIC_PASSWORD: '' }).auth.staticUsername, undefined);
  });
  it('reads both; the username is trimmed, the password is kept exactly as written', () => {
    const a = loadConfig({ AUTH_STATIC_USERNAME: ' admin ', AUTH_STATIC_PASSWORD: ' pa ss ' }).auth;
    assert.equal(a.staticUsername, 'admin');
    assert.equal(a.staticPassword, ' pa ss ');
  });
  it('never puts the credentials into the log-safe description', () => {
    const d = JSON.stringify(describeConfig(loadConfig({ AUTH_STATIC_USERNAME: 'admin', AUTH_STATIC_PASSWORD: 'hunter2-secret-value' })));
    assert.ok(d.includes('"staticLogin":true'));
    assert.ok(!d.includes('hunter2-secret-value'));
    assert.ok(!JSON.stringify(describeConfig(loadConfig({}))).includes('"staticLogin":true'));
  });
});
