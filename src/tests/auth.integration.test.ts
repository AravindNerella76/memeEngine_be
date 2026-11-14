/**
 * Full sign-in flow over real HTTP with a real database (scratch MongoDB only). Skipped unless MONGO_TEST_URI is set:
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27999/auth_test npm run test:integration
 * Boots a small Nest app with the real AuthController, AuthGuard and AuthService plus two probe routes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from '../auth/auth.controller';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { AuthSession, AuthSessionSchema, AuthUser, AuthUserSchema } from '../auth/auth.schemas';
import { hashPassword } from '../auth/password';
import { Public } from '../auth/public.decorator';
import { loadConfig, setConfigForTests } from '../config/app-config';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';

@Controller('api')
class ProbeController {
  @Get('secret') secret() { return { secret: true }; }
  @Public() @Get('open') open() { return { open: true }; }
}

const OWNER = 'owner@example.com';
const PASSWORD = 'purple-mango-telescope-river';

describe('sign-in over HTTP (integration)', { skip }, () => {
  let app: any;
  let base = '';
  let users: any;
  let sessions: any;

  const call = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method: init.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers || {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0], headers: res.headers };
  };
  const login = (username = OWNER, password = PASSWORD) => call('/api/auth/login', { method: 'POST', body: { username, password } });

  before(async () => {
    Logger.overrideLogger(false);
    setConfigForTests(loadConfig({ AUTH_MAX_FAILURES: '3', AUTH_LOCK_MINUTES: '5' }));

    @Module({
      imports: [MongooseModule.forRoot(URI as string), MongooseModule.forFeature([{ name: AuthUser.name, schema: AuthUserSchema }, { name: AuthSession.name, schema: AuthSessionSchema }])],
      controllers: [AuthController, ProbeController],
      providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }]
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    users = app.get(AuthService)['users'];
    sessions = app.get(AuthService)['sessions'];
    await users.deleteMany({});
    await sessions.deleteMany({});
  });

  after(async () => {
    await users?.deleteMany({});
    await sessions?.deleteMany({});
    await app?.close();
    await mongoose.disconnect().catch(() => undefined);
    setConfigForTests(null);
  });

  it('before an owner exists: everything is locked and the app is told setup is needed', async () => {
    const me = await call('/api/auth/me');
    assert.deepEqual(me.json, { authEnabled: true, authenticated: false, setupRequired: true });
    const r = await call('/api/secret');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'auth_required');
    assert.equal(r.json.setupRequired, true);
    assert.equal((await login()).status, 401, 'cannot sign in to an account that does not exist');
  });

  it('public routes stay open, protected ones need a session', async () => {
    await users.create({ username: OWNER, passwordHash: await hashPassword(PASSWORD) });
    assert.equal((await call('/api/open')).status, 200);
    const r = await call('/api/secret');
    assert.equal(r.status, 401);
    assert.equal(r.json.setupRequired, false);
  });

  it('signs in: sets an HttpOnly SameSite cookie and never returns the token in the body', async () => {
    const r = await login();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { authenticated: true, username: OWNER });
    assert.match(r.setCookie, /^me_session=[\w-]{43};/);
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(r.setCookie.includes(flag), flag);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(r.json).includes(r.cookie.split('=')[1]));
  });

  it('with that cookie the protected route works and /me names the user', async () => {
    const { cookie } = await login();
    assert.equal((await call('/api/secret', { cookie })).status, 200);
    assert.deepEqual((await call('/api/auth/me', { cookie })).json, { authEnabled: true, authenticated: true, username: OWNER });
  });

  it('stores only a hash of the token', async () => {
    const { cookie } = await login();
    const token = cookie.split('=')[1];
    assert.equal(await sessions.countDocuments({ tokenHash: token }), 0);
    assert.ok(await sessions.countDocuments({}) >= 1);
  });

  it('gives the same answer for a wrong password and an unknown user (no account enumeration)', async () => {
    const wrong = await login(OWNER, 'not-the-password-at-all');
    const unknown = await login('nobody@example.com', 'not-the-password-at-all');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    assert.equal(wrong.setCookie, '');
  });

  it('refuses non-text credentials (NoSQL-injection shapes)', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { username: { $ne: '' }, password: { $ne: '' } } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_body');
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: OWNER, password: ['x'] } })).status, 400);
  });

  it('rejects forged, truncated and unknown cookies', async () => {
    for (const bad of ['me_session=', 'me_session=abc', `me_session=${'a'.repeat(43)}`, 'me_session=%00']) assert.equal((await call('/api/secret', { cookie: bad })).status, 401, bad);
  });

  it('logout ends the session on the server, not just in the browser', async () => {
    const { cookie } = await login();
    assert.equal((await call('/api/secret', { cookie })).status, 200);
    const out = await call('/api/auth/logout', { method: 'POST', cookie });
    assert.equal(out.status, 200);
    assert.ok(out.setCookie.includes('Max-Age=0'));
    assert.equal((await call('/api/secret', { cookie })).status, 401, 'the old cookie is dead even if someone kept it');
    assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 200, 'signing out twice is fine');
  });

  it('an expired session (idle or absolute) stops working and is removed', async () => {
    const { cookie } = await login();
    await sessions.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await call('/api/secret', { cookie })).status, 401);
    const second = await login();
    await sessions.updateMany({}, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await call('/api/secret', { cookie: second.cookie })).status, 401);
  });

  it('a state-changing request labelled cross-site is refused even with a valid cookie', async () => {
    const { cookie } = await login();
    const r = await call('/api/auth/logout-others', { method: 'POST', cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'cross_site');
  });

  it('changing the password: needs the current one, enforces the policy, ends other sessions, keeps this one', async () => {
    const a = await login();
    const b = await login();
    const bad = await call('/api/auth/change-password', { method: 'POST', cookie: a.cookie, body: { currentPassword: 'wrong-wrong-wrong', newPassword: 'another-long-passphrase-1' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'wrong_current_password');
    const weak = await call('/api/auth/change-password', { method: 'POST', cookie: a.cookie, body: { currentPassword: PASSWORD, newPassword: 'short' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.code, 'weak_password');

    const NEW = 'a-brand-new-passphrase-2026';
    const ok = await call('/api/auth/change-password', { method: 'POST', cookie: a.cookie, body: { currentPassword: PASSWORD, newPassword: NEW } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.otherSessionsEnded >= 1);
    assert.equal((await call('/api/secret', { cookie: a.cookie })).status, 200, 'this session survives');
    assert.equal((await call('/api/secret', { cookie: b.cookie })).status, 401, 'the other one is ended');
    assert.equal((await login(OWNER, PASSWORD)).status, 401, 'old password no longer works');
    assert.equal((await login(OWNER, NEW)).status, 200);

    // put it back for the remaining tests
    const back = await login(OWNER, NEW);
    await call('/api/auth/change-password', { method: 'POST', cookie: back.cookie, body: { currentPassword: NEW, newPassword: PASSWORD } });
  });

  it('lists sessions and can end all the others', async () => {
    const keep = await login();
    await login();
    const list = await call('/api/auth/sessions', { cookie: keep.cookie });
    assert.equal(list.status, 200);
    assert.ok(list.json.sessions.length >= 2);
    assert.equal(list.json.sessions.filter((s: any) => s.current).length, 1);
    const r = await call('/api/auth/logout-others', { method: 'POST', cookie: keep.cookie });
    assert.ok(r.json.ended >= 1);
    assert.equal((await call('/api/auth/sessions', { cookie: keep.cookie })).json.sessions.length, 1);
  });

  it('locks sign-in after repeated wrong passwords, even for the right one, then reports Retry-After', async () => {
    // fresh username so earlier tests do not count; limit is 3 (see before())
    for (let i = 0; i < 2; i++) assert.equal((await login('attacker@example.com', `wrong-guess-number-${i}`)).status, 401);
    const locking = await login('attacker@example.com', 'wrong-guess-number-3');
    assert.equal(locking.status, 429);
    assert.equal(locking.json.code, 'too_many_attempts');
    assert.ok(Number(locking.headers.get('retry-after')) > 0);
    assert.equal((await login('attacker@example.com', 'anything')).status, 429, 'stays locked');
  });

  it('the strict lock is per username and address: attempts against another username do not lock the owner', async () => {
    assert.equal((await login(OWNER, PASSWORD)).status, 200);
  });
});

describe('static login from the environment (integration)', { skip }, () => {
  let app: any;
  let base = '';
  let svc: AuthService;
  const call = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await fetch(base + path, {
      method: init.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const json: any = await res.json().catch(() => null);
    return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = (username: string, password: string) => call('/api/auth/login', { method: 'POST', body: { username, password } });
  const env = (password: string) => loadConfig({ AUTH_STATIC_USERNAME: 'Admin', AUTH_STATIC_PASSWORD: password });

  before(async () => {
    Logger.overrideLogger(false);
    setConfigForTests(env('admin'));
    @Module({
      imports: [MongooseModule.forRoot(URI as string), MongooseModule.forFeature([{ name: AuthUser.name, schema: AuthUserSchema }, { name: AuthSession.name, schema: AuthSessionSchema }])],
      controllers: [AuthController, ProbeController],
      providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }]
    })
    class StaticModule {}
    app = await NestFactory.create(StaticModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    svc = app.get(AuthService);
    await svc['users'].deleteMany({});
    await svc['sessions'].deleteMany({});
    await svc.ensureStaticOwner();
  });

  after(async () => {
    await svc?.['users'].deleteMany({});
    await svc?.['sessions'].deleteMany({});
    await app?.close();
    await mongoose.disconnect().catch(() => undefined);
    setConfigForTests(null);
  });

  it('admin / admin signs in (the username is not case-sensitive) and the app is told it is a weak static login', async () => {
    const r = await login('ADMIN', 'admin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { authenticated: true, username: 'admin', staticCredentials: true, staticWeak: true });
    const me = await call('/api/auth/me', { cookie: r.cookie });
    assert.equal(me.json.staticCredentials, true);
    assert.equal((await call('/api/secret', { cookie: r.cookie })).status, 200);
  });

  it('a wrong password is still refused', async () => {
    assert.equal((await login('admin', 'Admin')).status, 401);
    assert.equal((await login('admin', 'admin ')).status, 401);
  });

  it('the password cannot be changed from the app (the server settings own it)', async () => {
    const { cookie } = await login('admin', 'admin');
    const r = await call('/api/auth/change-password', { method: 'POST', cookie, body: { currentPassword: 'admin', newPassword: 'a-much-better-passphrase-2026' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'static_credentials');
  });

  it('is idempotent: restarting does not create a second account', async () => {
    await svc.ensureStaticOwner();
    await svc.ensureStaticOwner();
    assert.equal(await svc['users'].countDocuments({ username: 'admin' }), 1);
  });

  it('changing the password in the environment replaces it and ends every old session', async () => {
    const old = await login('admin', 'admin');
    assert.equal((await call('/api/secret', { cookie: old.cookie })).status, 200);

    setConfigForTests(env('a-much-better-passphrase-2026')); // what editing the host setting and restarting does
    await svc.ensureStaticOwner();

    assert.equal((await call('/api/secret', { cookie: old.cookie })).status, 401, 'old sessions are ended');
    assert.equal((await login('admin', 'admin')).status, 401, 'the old password no longer works');
    const fresh = await login('admin', 'a-much-better-passphrase-2026');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.staticWeak, false, 'a strong password is not flagged weak');
  });
});
