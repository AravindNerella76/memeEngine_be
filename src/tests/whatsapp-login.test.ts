/**
 * Sign in by sending a code from WhatsApp: the code store, the sign-in service (approval, the waiting page, "That wasn't
 * me", "Sign out everywhere"), the bot answering in the chat, and the HTTP routes over a real socket. No database, no Meta.
 */
import { describe, it, before, after } from 'node:test';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { formatCode, parseLoginCode, phoneTail, TooManyChallengesError, WhatsAppChallenges } from '../auth/whatsapp-challenges';
import { botNumberFrom, DENY_PREFIX, WhatsAppLoginService } from '../auth/whatsapp-login.service';
import { WhatsAppLoginController } from '../auth/whatsapp-login.controller';
import { AuthService } from '../auth/auth.service';
import { describeDevice } from '../auth/device';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const OWNER = '919347708120';
const STRANGER = '447700900123';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const last = <T>(a: T[]): T => a[a.length - 1];
const client = (ip = '203.0.113.7') => ({ ip, userAgent: CHROME });
const ENV = {
  WHATSAPP_ALLOWED_PHONE: `${OWNER},918885550123`,
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_APP_SECRET: 'test-secret',
  WHATSAPP_DISPLAY_PHONE: '+91 90000 11111'
} as any;

/** Stands in for AuthService: remembers the sessions WhatsApp sign-ins create. */
function fakeAuth() {
  const sessions: { phone: string; challengeId: string; ip: string }[] = [];
  let beforeWrite: (() => void) | null = null;
  return {
    sessions,
    /** runs while a session is being written (to test what happens when WhatsApp answers at that very moment) */
    duringWrite(fn: () => void) {
      beforeWrite = fn;
    },
    ownerExists: async () => true,
    staticFlags: () => ({}),
    async signInWithWhatsApp(phone: string, c: { ip: string }, challengeId: string) {
      beforeWrite?.();
      beforeWrite = null;
      sessions.push({ phone, challengeId, ip: c.ip });
      return { token: 'A'.repeat(43), username: 'owner', maxAgeSeconds: 3600 };
    },
    async endSessionsOfChallenge(id: string) {
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].challengeId === id) sessions.splice(i, 1);
      return before - sessions.length;
    },
    async endAllSessions() {
      const n = sessions.length;
      sessions.length = 0;
      return n;
    }
  };
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('WhatsApp sign-in', () => {
  before(() => setConfigForTests(loadConfig(ENV)));
  after(() => setConfigForTests(null));

  describe('reading a code out of a WhatsApp message', () => {
    it('accepts the ways people actually type it', () => {
      for (const t of ['482915', '482 915', '482-915', 'Login 482915', 'login: 482 915', 'LOGIN482915', 'sign in 482915', 'Sign-in 482-915', 'code 482915', 'OTP: 482915', ' 482915. ']) {
        assert.equal(parseLoginCode(t)?.code, '482915', t);
      }
    });
    it('knows when it was said in words (surely a sign-in) and when it is bare digits', () => {
      assert.equal(parseLoginCode('Login 482915')?.explicit, true);
      assert.equal(parseLoginCode('482915')?.explicit, false);
    });
    it('ignores anything that is not exactly a code', () => {
      for (const t of ['48291', '4829150', 'login', 'my code is 482915 thanks', '482915 482915', '₹482915', '', 'x'.repeat(100)]) assert.equal(parseLoginCode(t), null, t);
      assert.equal(parseLoginCode(42 as any), null);
    });
    it('formats codes and numbers for people', () => {
      assert.equal(formatCode('048213'), '048 213');
      assert.equal(phoneTail('+91 93477 08120'), '8120');
      assert.deepEqual(botNumberFrom('+91 90000 11111', 'Kanyaraasi'), { digits: '919000011111', display: '+91 90000 11111', name: 'Kanyaraasi' });
      assert.deepEqual(botNumberFrom('15550123456'), { digits: '15550123456', display: '+15550123456' });
      assert.equal(botNumberFrom('12345'), null);
      assert.equal(describeDevice(CHROME), 'Chrome on Windows');
      assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    });
  });

  describe('the code store', () => {
    it('hands out unique 6-digit codes and a secret token that is not the code', () => {
      const s = new WhatsAppChallenges({ perIpMax: 1000, maxActive: 1000 });
      const codes = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const { challenge, token } = s.create(client(`10.0.${i >> 8}.${i & 255}`));
        assert.match(challenge.code, /^\d{6}$/);
        assert.doesNotMatch(challenge.code, /^(\d)\1+$/, 'no 000000 / 111111');
        assert.ok(!token.includes(challenge.code));
        codes.add(challenge.code);
      }
      assert.equal(codes.size, 300);
    });

    it('approves once; a second message with the same code is "used"', () => {
      const s = new WhatsAppChallenges();
      const { challenge, token } = s.create(client());
      assert.equal(s.approve(challenge.code, OWNER).result, 'approved');
      assert.equal(s.approve(challenge.code, OWNER).result, 'used');
      assert.equal(s.consume(token)?.approvedBy, OWNER);
      assert.equal(s.consume(token), null, 'a session is handed out exactly once');
      assert.equal(s.approve(challenge.code, OWNER).result, 'used');
    });

    it('runs out after five minutes, and a late message is told so (not "unknown")', () => {
      const c = clock();
      const s = new WhatsAppChallenges({}, c.now);
      const { challenge, token } = s.create(client());
      c.advance(5 * 60_000 - 1);
      assert.equal(s.lookup(token)?.state, 'pending');
      c.advance(2);
      assert.equal(s.lookup(token)?.state, 'expired');
      assert.equal(s.approve(challenge.code, OWNER).result, 'expired');
      assert.equal(s.approve('123456', OWNER).result, 'unknown');
    });

    it('gives a sleeping page time to collect an approval that came at the last second', () => {
      const c = clock();
      const s = new WhatsAppChallenges({}, c.now);
      const { challenge, token } = s.create(client());
      c.advance(5 * 60_000 - 1000);
      s.approve(challenge.code, OWNER);
      c.advance(60_000);
      assert.equal(s.consume(token)?.state, 'consumed');
    });

    it('never approves a code sent from a number that is not allowed, but tells the waiting page', () => {
      const s = new WhatsAppChallenges();
      const { challenge, token } = s.create(client());
      assert.equal(s.reject(challenge.code, STRANGER), true);
      assert.equal(s.lookup(token)?.state, 'pending');
      assert.equal(s.lookup(token)?.rejectedFrom, '0123');
    });

    it('limits new codes per address, but renewing your own code never counts', () => {
      const s = new WhatsAppChallenges({ perIpMax: 3 });
      let last = s.create(client()).token;
      s.create(client());
      for (let i = 0; i < 10; i++) last = s.create(client(), last).token; // "new code" presses
      s.create(client());
      assert.throws(() => s.create(client()), (e: any) => e instanceof TooManyChallengesError && e.scope === 'ip' && e.retryAfterSec > 0);
      assert.doesNotThrow(() => s.create(client('198.51.100.1')), 'another address is not affected');
    });

    it('a renewed code replaces the old one: the old code stops working', () => {
      const s = new WhatsAppChallenges();
      const first = s.create(client());
      const second = s.create(client(), first.token);
      assert.equal(s.approve(first.challenge.code, OWNER).result, 'cancelled');
      assert.equal(s.approve(second.challenge.code, OWNER).result, 'approved');
    });

    it('caps how many codes can wait at once', () => {
      const s = new WhatsAppChallenges({ maxActive: 2, perIpMax: 100 });
      s.create(client());
      s.create(client());
      assert.throws(() => s.create(client()), (e: any) => e instanceof TooManyChallengesError && e.scope === 'global');
    });

    it('wakes the waiting page the moment the code is approved', async () => {
      const s = new WhatsAppChallenges();
      const { challenge } = s.create(client());
      const t0 = Date.now();
      setTimeout(() => s.approve(challenge.code, OWNER), 30);
      await s.waitForChange(challenge, 5000);
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(challenge.state, 'approved');
    });

    it('stops waiting when the page goes away', async () => {
      const s = new WhatsAppChallenges();
      const { challenge } = s.create(client());
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      const t0 = Date.now();
      await s.waitForChange(challenge, 5000, ac.signal);
      assert.ok(Date.now() - t0 < 1000);
    });
  });

  describe('the sign-in service', () => {
    const setup = () => {
      const auth = fakeAuth();
      const svc = new WhatsAppLoginService(auth as unknown as AuthService);
      return { auth, svc };
    };

    it('is offered only when the bot is fully set up, and shows its number', async () => {
      const { svc } = setup();
      assert.deepEqual(await svc.availability(), { available: true, bot: { digits: '919000011111', display: '+91 90000 11111' } });
      setConfigForTests(loadConfig({ ...ENV, WHATSAPP_APP_SECRET: '' }));
      assert.match(String((await svc.availability()).reason), /app secret/);
      setConfigForTests(loadConfig({ ...ENV, WHATSAPP_ALLOWED_PHONE: '' }));
      assert.match(String((await svc.availability()).reason), /No WhatsApp number is allowed/);
      setConfigForTests(loadConfig({ ...ENV, AUTH_WHATSAPP_LOGIN: 'false' }));
      assert.equal((await svc.configured()).ok, false);
      setConfigForTests(loadConfig(ENV));
    });

    it('signs the waiting page in when an allowed number sends the code', async () => {
      const { auth, svc } = setup();
      const { challenge, token } = svc.start(client());
      const waiting = svc.poll(token, client('203.0.113.7'));
      const reply = await svc.onWhatsAppText(OWNER, `Login ${challenge.code}`, true);
      assert.match(reply!.text, /Signed in to the studio/);
      assert.match(reply!.text, /Chrome on Windows/);
      assert.match(reply!.text, /203\.0\.113\.7/);
      assert.deepEqual(reply!.buttons, [{ id: `${DENY_PREFIX}${challenge.id}`, title: "That wasn't me" }]);
      assert.match(reply!.fallback!, /Sign out everywhere/);
      const out = await waiting;
      assert.equal(out.status, 'approved');
      assert.equal((out as any).phoneTail, '8120');
      assert.deepEqual(auth.sessions, [{ phone: OWNER, challengeId: challenge.id, ip: '203.0.113.7' }]);
      assert.equal((await svc.poll(token, client())).status, 'used', 'a second tab cannot collect it again');
    });

    it('keeps the page waiting (and says why) when a stranger sends the code', async () => {
      const { auth, svc } = setup();
      const { challenge, token } = svc.start(client());
      assert.equal(await svc.onWhatsAppText(STRANGER, challenge.code, false), null, 'the chat answers as it does for strangers');
      const out = await svc.poll(token, client(), undefined, 10);
      assert.deepEqual(out, { status: 'pending', expiresAt: challenge.expiresAt, rejectedFrom: '0123' });
      assert.equal(auth.sessions.length, 0);
    });

    it('leaves bare digits alone unless they are one of our codes', async () => {
      const { svc } = setup();
      assert.equal(await svc.onWhatsAppText(OWNER, '123456', true), null);
      assert.match((await svc.onWhatsAppText(OWNER, 'login 123456', true))!.text, /No sign-in is waiting for code 123 456/);
      assert.equal(await svc.onWhatsAppText(OWNER, 'Mahesh babu', true), null);
    });

    it('tells the sender when the code expired or was used', async () => {
      const c = clock();
      const auth = fakeAuth();
      const svc = new WhatsAppLoginService(auth as unknown as AuthService, undefined, new WhatsAppChallenges({}, c.now));
      const a = svc.start(client());
      c.advance(6 * 60_000);
      assert.match((await svc.onWhatsAppText(OWNER, a.challenge.code, true))!.text, /has expired/);
      const b = svc.start(client());
      await svc.onWhatsAppText(OWNER, b.challenge.code, true);
      assert.match((await svc.onWhatsAppText(OWNER, b.challenge.code, true))!.text, /already used/);
    });

    it('"That wasn\'t me" ends that sign-in and nothing else', async () => {
      const { auth, svc } = setup();
      const mine = svc.start(client('198.51.100.9'));
      await svc.onWhatsAppText(OWNER, mine.challenge.code, true);
      await svc.poll(mine.token, client('198.51.100.9'));
      const theirs = svc.start(client());
      await svc.onWhatsAppText(OWNER, theirs.challenge.code, true);
      await svc.poll(theirs.token, client());
      assert.equal(auth.sessions.length, 2);
      const r = await svc.onWhatsAppButton(OWNER, `${DENY_PREFIX}${theirs.challenge.id}`, true);
      assert.match(r!.text, /Signed out/);
      assert.deepEqual(auth.sessions.map(s => s.challengeId), [mine.challenge.id]);
      assert.match((await svc.onWhatsAppButton(OWNER, `${DENY_PREFIX}${theirs.challenge.id}`, true))!.text, /already ended/);
    });

    it('"That wasn\'t me" before the page collects: the page is refused', async () => {
      const { auth, svc } = setup();
      const { challenge, token } = svc.start(client());
      await svc.onWhatsAppText(OWNER, challenge.code, true);
      await svc.onWhatsAppButton(OWNER, `${DENY_PREFIX}${challenge.id}`, true);
      assert.deepEqual(await svc.poll(token, client()), { status: 'cancelled', by: 'whatsapp' });
      assert.equal(auth.sessions.length, 0);
    });

    it('"That wasn\'t me" while the session is being written: the session does not survive', async () => {
      const { auth, svc } = setup();
      const { challenge, token } = svc.start(client());
      await svc.onWhatsAppText(OWNER, challenge.code, true);
      auth.duringWrite(() => void svc.onWhatsAppButton(OWNER, `${DENY_PREFIX}${challenge.id}`, true));
      const out = await svc.poll(token, client());
      await new Promise(r => setTimeout(r, 10));
      assert.equal(out.status, 'cancelled');
      assert.equal(auth.sessions.length, 0);
    });

    it('a stranger cannot press "That wasn\'t me"', async () => {
      const { auth, svc } = setup();
      const { challenge, token } = svc.start(client());
      await svc.onWhatsAppText(OWNER, challenge.code, true);
      await svc.poll(token, client());
      assert.equal(await svc.onWhatsAppButton(STRANGER, `${DENY_PREFIX}${challenge.id}`, false), null);
      assert.equal(auth.sessions.length, 1);
    });

    it('"Sign out everywhere" ends every sign-in and every waiting code', async () => {
      const { auth, svc } = setup();
      const done = svc.start(client());
      await svc.onWhatsAppText(OWNER, done.challenge.code, true);
      await svc.poll(done.token, client());
      const waiting = svc.start(client('198.51.100.2'));
      const r = await svc.onWhatsAppText(OWNER, 'Sign out everywhere', true);
      assert.match(r!.text, /Signed out everywhere\.\* 1 sign-in ended, and 1 waiting code stopped working/);
      assert.equal(auth.sessions.length, 0);
      assert.equal((await svc.poll(waiting.token, client())).status, 'cancelled');
      assert.match((await svc.onWhatsAppText(OWNER, waiting.challenge.code, true))!.text, /cancelled when you signed out everywhere/);
      assert.equal(await svc.onWhatsAppText(STRANGER, 'sign out everywhere', false), null, 'strangers cannot');
    });

    it('a page that renews its code cancels the old one; an unknown token is "expired"', async () => {
      const { svc } = setup();
      const a = svc.start(client());
      svc.start(client(), a.token);
      assert.equal((await svc.poll(a.token, client())).status, 'cancelled');
      assert.equal((await svc.poll('B'.repeat(43), client())).status, 'expired');
      assert.equal((await svc.poll({ $ne: '' }, client())).status, 'expired');
    });
  });

  describe('in the WhatsApp chat', () => {
    it('the bot really receives the sign-in service from Nest (a type-only import would leave it undefined)', () => {
      const types: unknown[] = Reflect.getMetadata('design:paramtypes', WhatsAppService) || [];
      assert.ok(types.includes(WhatsAppLoginService), 'WhatsAppService must declare WhatsAppLoginService as a runtime parameter type');
    });


    function chat() {
      const auth = fakeAuth();
      const login = new WhatsAppLoginService(auth as unknown as AuthService);
      let doc: any = null;
      const model: any = {
        findOne: async () => doc,
        create: async (d: any) => (doc = { ...d, manualSubjects: [], async save() { return this; } })
      };
      const none: any = {};
      const svc: any = new WhatsAppService(model, none, none, none, none, { list: async () => [] } as any, undefined, undefined, login);
      const sent: { to: string; text: string }[] = [];
      const buttons: { to: string; text: string; ids: string[] }[] = [];
      let buttonsWork = true;
      svc.sendTextMessage = async (to: string, text: string) => (sent.push({ to, text }), true);
      svc.sendButtonsMessage = async (to: string, text: string, b: any[]) => (buttonsWork ? (buttons.push({ to, text, ids: b.map(x => x.id) }), true) : false);
      svc.markReadTyping = async () => undefined;
      let n = 0;
      const hook = (from: string, m: any) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: `wamid.${++n}`, from, ...m }] } }] }] });
      return {
        auth, login, sent, buttons,
        get doc() { return doc; },
        noButtons: () => (buttonsWork = false),
        text: (from: string, body: string) => svc.processIncomingWebhook(hook(from, { type: 'text', text: { body } })),
        tap: (from: string, id: string) => svc.processIncomingWebhook(hook(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } }))
      };
    }

    it('approves the code, answers with the device and a "That wasn\'t me" button, and leaves the meme chat alone', async () => {
      const h = chat();
      const { challenge, token } = h.login.start(client());
      await h.text(OWNER, `Login ${challenge.code}`);
      assert.equal(h.buttons.length, 1);
      assert.match(h.buttons[0].text, /Signed in to the studio[\s\S]*Chrome on Windows/);
      assert.deepEqual(h.buttons[0].ids, [`${DENY_PREFIX}${challenge.id}`]);
      assert.equal(h.doc, null, 'no meme session was created or changed');
      assert.equal((await h.login.poll(token, client())).status, 'approved');

      await h.tap(OWNER, `${DENY_PREFIX}${challenge.id}`);
      assert.match(last(h.sent).text, /Signed out/);
      assert.equal(h.auth.sessions.length, 0);
      assert.equal(h.doc, null);
    });

    it('falls back to plain words when buttons cannot be sent', async () => {
      const h = chat();
      h.noButtons();
      const { challenge } = h.login.start(client());
      await h.text(OWNER, challenge.code);
      assert.match(last(h.sent).text, /Not you\? Send \*Sign out everywhere\*/);
    });

    it('answers a stranger exactly as before and approves nothing', async () => {
      const h = chat();
      const { challenge, token } = h.login.start(client());
      await h.text(STRANGER, challenge.code);
      assert.match(last(h.sent).text, /authorized users only/);
      assert.equal(h.buttons.length, 0);
      const out = await h.login.poll(token, client(), undefined, 10);
      assert.equal(out.status, 'pending');
      assert.equal((out as any).rejectedFrom, '0123');
    });

    it('bare digits that are not a code go to the meme chat as usual', async () => {
      const h = chat();
      await h.text(OWNER, '555123');
      assert.equal(h.buttons.length, 0);
      assert.ok(h.doc, 'handled by the normal chat');
    });

    it('mentions sign-in in Help', async () => {
      const h = chat();
      await h.text(OWNER, 'help');
      assert.match(last(h.sent).text, /Studio sign-in:[\s\S]*Sign out everywhere/);
    });
  });

  describe('over HTTP', () => {
    let base = '';
    let close: () => Promise<void>;
    let login: WhatsAppLoginService;
    const auth = fakeAuth();

    before(async () => {
      login = new WhatsAppLoginService(auth as unknown as AuthService);
      @Module({ controllers: [WhatsAppLoginController], providers: [{ provide: WhatsAppLoginService, useValue: login }, { provide: AuthService, useValue: auth }] })
      class TestModule {}
      const app = await NestFactory.create(TestModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/auth/whatsapp`;
      close = () => app.close();
    });
    after(() => close());

    const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME }, body: JSON.stringify(body) });

    it('start → message from WhatsApp → the held poll answers with a session cookie', async () => {
      const res = await post('start', {});
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const s: any = await res.json();
      assert.match(s.code, /^\d{6}$/);
      assert.equal(s.codeDisplay, formatCode(s.code));
      assert.equal(s.message, `Login ${s.code}`);
      assert.equal(s.link, `https://wa.me/919000011111?text=Login%20${s.code}`);
      assert.deepEqual(s.bot, { digits: '919000011111', display: '+91 90000 11111' });
      assert.equal(s.ttlSeconds, 300);

      const held = post('poll', { token: s.token });
      await new Promise(r => setTimeout(r, 50));
      await login.onWhatsAppText(OWNER, s.code, true);
      const p = await held;
      const body: any = await p.json();
      assert.equal(body.status, 'approved');
      assert.equal(body.username, 'owner');
      assert.equal(body.phoneTail, '8120');
      assert.match(String(p.headers.get('set-cookie')), /^me_session=A{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600/);
    });

    it('a code from a stranger: the poll stays pending and says so; cancel ends the code', async () => {
      const s: any = await (await post('start', { replaces: undefined })).json();
      await login.onWhatsAppText(STRANGER, s.code, false);
      const p: any = await (await post('poll', { token: s.token })).json();
      assert.equal(p.status, 'pending');
      assert.equal(p.rejectedFrom, '0123');
      assert.ok(p.serverNow && p.expiresAt);
      assert.deepEqual(await (await post('cancel', { token: s.token })).json(), { cancelled: true });
      assert.equal(((await (await post('poll', { token: s.token })).json()) as any).status, 'cancelled');
    });

    it('refuses objects and missing tokens', async () => {
      assert.equal((await post('poll', { token: { $ne: '' } })).status, 400);
      assert.equal((await post('poll', {})).status, 400);
      assert.equal((await post('start', { replaces: ['x'] })).status, 400);
    });

    it('says plainly when WhatsApp sign-in is not available', async () => {
      setConfigForTests(loadConfig({ ...ENV, WHATSAPP_ACCESS_TOKEN: '' }));
      try {
        const res = await post('start', {});
        assert.equal(res.status, 503);
        const b: any = await res.json();
        assert.equal(b.code, 'whatsapp_unavailable');
        assert.match(b.message, /not connected/);
      } finally {
        setConfigForTests(loadConfig(ENV));
      }
    });
  });
});
