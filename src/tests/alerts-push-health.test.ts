/**
 * New sign-in alerts (WhatsApp + push), push notifications (who may be reached, what a finished meme says, a real
 * encrypted VAPID request) and the health report's verdicts. No database, no Meta, no push service.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as webpush from 'web-push';
import { loadConfig, setConfigForTests } from '../config/app-config';
import { SignInAlertService } from '../services/signin-alerts.service';
import { isAllowedPushEndpoint, PushService } from '../services/push.service';
import { buildHealth, HealthFacts, HealthService } from '../services/health.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { AdaptationJobService } from '../services/adaptation-job.service';
import { AuthService, SignInEvent } from '../auth/auth.service';
import { END_SESSION_PREFIX, WhatsAppLoginService } from '../auth/whatsapp-login.service';

const OWNER = '919347708120';
const PARTNER = '918885550123';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const ENV = { WHATSAPP_ALLOWED_PHONE: `${OWNER},${PARTNER}`, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_APP_SECRET: 's' } as any;

function fakeWhatsApp(opts: { buttons?: boolean } = {}) {
  const sent: { kind: string; to: string; text?: string; ids?: string[]; template?: string; params?: string[]; payloads?: string[] }[] = [];
  return {
    sent,
    async sendButtonsMessage(to: string, text: string, buttons: { id: string }[]) {
      if (opts.buttons === false) return false;
      sent.push({ kind: 'buttons', to, text, ids: buttons.map(b => b.id) });
      return true;
    },
    async sendTextMessage(to: string, text: string) {
      sent.push({ kind: 'text', to, text });
      return true;
    },
    async sendTemplateMessage(to: string, template: string, _lang: string, params: string[], payloads: string[]) {
      sent.push({ kind: 'template', to, template, params, payloads });
      return true;
    }
  };
}
function fakePush() {
  const sent: { kind: string; msg: any }[] = [];
  return { sent, async send(kind: string, msg: any) { sent.push({ kind, msg }); return { sent: 1, removed: 0, failed: 0 }; } };
}
const signin = (over: Partial<SignInEvent> = {}): SignInEvent => ({ sessionId: '65f000000000000000000001', username: 'owner', method: 'password', ip: '49.205.1.2', userAgent: CHROME, at: new Date(), ...over });

describe('sign-in alerts', () => {
  before(() => setConfigForTests(loadConfig(ENV)));
  after(() => setConfigForTests(null));

  it('tells every allowed number about a password sign-in, with a button that ends that session', async () => {
    const wa = fakeWhatsApp();
    const push = fakePush();
    const svc = new SignInAlertService({ events: new EventEmitter() } as any, wa as any, undefined, push as any);
    const r = await svc.onSignIn(signin());
    assert.deepEqual(wa.sent.map(s => s.to), [OWNER, PARTNER]);
    assert.match(wa.sent[0].text!, /New sign-in to the studio[\s\S]*Chrome on Windows[\s\S]*49\.205\.1\.2[\s\S]*With the password/);
    assert.deepEqual(wa.sent[0].ids, [`${END_SESSION_PREFIX}65f000000000000000000001`]);
    assert.equal(push.sent[0].kind, 'security');
    assert.match(push.sent[0].msg.body, /Chrome on Windows · 49\.205\.1\.2 · with the password/);
    assert.equal(push.sent[0].msg.requireInteraction, true);
    assert.deepEqual({ sent: r!.whatsappSent, failed: r!.whatsappFailed, push: r!.pushSent, via: r!.via }, { sent: 2, failed: 0, push: 1, via: 'message' });
    assert.equal(svc.last, r);
  });

  it('does not alert the number that approved a WhatsApp sign-in (it already has its answer)', async () => {
    const wa = fakeWhatsApp();
    const svc = new SignInAlertService({ events: new EventEmitter() } as any, wa as any);
    await svc.onSignIn(signin({ method: 'whatsapp', approvedBy: OWNER }));
    assert.deepEqual(wa.sent.map(s => s.to), [PARTNER]);
    assert.match(wa.sent[0].text!, /a WhatsApp code from the number ending 8120/);
  });

  it('falls back to plain words when buttons cannot be sent', async () => {
    const wa = fakeWhatsApp({ buttons: false });
    const svc = new SignInAlertService({ events: new EventEmitter() } as any, wa as any);
    await svc.onSignIn(signin());
    assert.equal(wa.sent[0].kind, 'text');
    assert.match(wa.sent[0].text!, /Send \*Sign out everywhere\*/);
  });

  it('uses the approved template when one is set (delivered outside the 24-hour window)', async () => {
    setConfigForTests(loadConfig({ ...ENV, WHATSAPP_ALERT_TEMPLATE: 'studio_signin', WHATSAPP_ALERT_TEMPLATE_LANG: 'en_US' }));
    try {
      const wa = fakeWhatsApp();
      const svc = new SignInAlertService({ events: new EventEmitter() } as any, wa as any);
      const r = await svc.onSignIn(signin());
      assert.equal(r!.via, 'template');
      assert.deepEqual(wa.sent[0], { kind: 'template', to: OWNER, template: 'studio_signin', params: ['Chrome on Windows', '49.205.1.2', 'the password'], payloads: [`${END_SESSION_PREFIX}65f000000000000000000001`] });
    } finally {
      setConfigForTests(loadConfig(ENV));
    }
  });

  it('says when sign-in was paused after wrong passwords', async () => {
    const wa = fakeWhatsApp();
    const push = fakePush();
    const svc = new SignInAlertService({ events: new EventEmitter() } as any, wa as any, undefined, push as any);
    await svc.onLockout({ username: 'owner', ip: '203.0.113.9', minutes: 15, at: new Date() });
    assert.match(wa.sent[0].text!, /Sign-in paused[\s\S]*"owner" from 203\.0\.113\.9[\s\S]*15 minutes/);
    assert.equal(push.sent[0].msg.tag, 'lockout-203.0.113.9');
  });

  it('stays quiet when switched off, and listens to the sign-in events by itself', async () => {
    const events = new EventEmitter();
    const wa = fakeWhatsApp();
    const svc = new SignInAlertService({ events } as any, wa as any);
    svc.onModuleInit();
    events.emit('signin', signin());
    await new Promise(r => setTimeout(r, 20));
    assert.equal(wa.sent.length, 2, 'the event reached the alerts');
    setConfigForTests(loadConfig({ ...ENV, AUTH_SIGNIN_ALERTS: 'false' }));
    try {
      assert.equal(await svc.onSignIn(signin()), null);
      assert.equal(wa.sent.length, 2);
    } finally {
      setConfigForTests(loadConfig(ENV));
    }
  });

  it('"That wasn\'t me" under an alert ends exactly that session', async () => {
    const ended: string[] = [];
    const login = new WhatsAppLoginService({ endSession: async (id: string) => (ended.push(id), id === 'live') } as any);
    assert.match((await login.onWhatsAppButton(OWNER, `${END_SESSION_PREFIX}live`, true))!.text, /Signed out[\s\S]*change the password/);
    assert.match((await login.onWhatsAppButton(OWNER, `${END_SESSION_PREFIX}gone`, true))!.text, /already ended/);
    assert.equal(await login.onWhatsAppButton('447700900123', `${END_SESSION_PREFIX}live`, false), null, 'strangers cannot');
    assert.deepEqual(ended, ['live', 'gone']);
  });
});

describe('push notifications', () => {
  it('only sends to the push services browsers really use (no arbitrary addresses)', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QA', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(isAllowedPushEndpoint(ok), true, ok);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://127.0.0.1/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url', 42, 'https://' + 'a'.repeat(1001)]) {
      assert.equal(isAllowedPushEndpoint(bad), false, String(bad).slice(0, 60));
    }
  });

  it('builds a real encrypted, VAPID-signed request for a browser subscription', () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    const vapid = webpush.generateVAPIDKeys();
    const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: 'Your meme is ready' }), { vapidDetails: { subject: 'mailto:studio@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60, urgency: 'high', topic: 'job-1' });
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    assert.match(String(req.headers.Authorization), /^vapid t=.+, k=/);
    assert.equal(req.headers.Urgency, 'high');
    assert.ok(Buffer.isBuffer(req.body) && (req.body as Buffer).length > 40, 'the payload is encrypted, not sent as text');
    assert.ok(!(req.body as Buffer).toString('utf8').includes('Your meme'));
  });

  it('a finished meme becomes "Your meme is ready" with the punchline, the meme picture and a link to it', async () => {
    const sent: any[] = [];
    const svc: any = Object.create(PushService.prototype);
    svc.send = async (kind: string, msg: any) => (sent.push({ kind, msg }), { sent: 1, removed: 0, failed: 0 });
    await svc.announceJob({ id: 'job1', status: 'done', elapsedMs: 1, stages: [], slots: [], log: [], result: { memeId: 'meme_42', content: { punchline: '  Idi   maa\nstyle  ' } } });
    await svc.announceJob({ id: 'job2', status: 'failed', elapsedMs: 1, stages: [], slots: [], log: [], error: { status: 422, message: 'Could not find Mahesh Babu.' } });
    assert.deepEqual(sent[0], { kind: 'meme', msg: { title: 'Your meme is ready', body: '“Idi maa style” · saved in My Memes. Tap to see it.', url: '/meme/meme_42', tag: 'job-job1', image: '/api/memes/meme_42/thumb' } });
    assert.deepEqual(sent[1].msg, { title: 'The meme could not be made', body: 'Could not find Mahesh Babu.', url: '/', tag: 'job-job2' });
  });

  it('the job service announces finished jobs (and a failing listener never breaks a job)', async () => {
    const jobs = new AdaptationJobService();
    const seen: string[] = [];
    jobs.events.on('finished', () => {
      throw new Error('listener bug');
    });
    jobs.events.prependListener('finished', (v: any) => seen.push(v.status));
    const a = jobs.start(async () => ({ memeId: 'm' }));
    const b = jobs.start(async () => {
      throw new Error('boom');
    });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(seen.sort(), ['done', 'failed']);
    assert.equal(jobs.get(a.id)!.status, 'done');
    assert.equal(jobs.get(b.id)!.status, 'failed');
  });
});

describe('the services really get their collaborators from Nest (no type-only imports)', () => {
  const types = (cls: any) => (Reflect.getMetadata('design:paramtypes', cls) || []) as unknown[];
  it('alerts, push and health', () => {
    assert.ok(types(SignInAlertService).includes(WhatsAppService) && types(SignInAlertService).includes(PushService) && types(SignInAlertService).includes(AuthService));
    assert.ok(types(PushService).includes(AdaptationJobService) && types(PushService).includes(AuthService));
    for (const c of [AuthService, WhatsAppService, PushService, SignInAlertService, WhatsAppLoginService]) assert.ok(types(HealthService).includes(c), c.name);
  });
});

describe('health report', () => {
  const NOW = new Date('2026-11-21T12:00:00Z');
  const good = (): HealthFacts => ({
    now: NOW,
    live: false,
    uptimeSec: 7200,
    db: { ok: true, ms: 4 },
    auth: { enabled: true, ownerExists: true, staticLogin: false, staticWeak: false, appUrl: 'https://studio.example.com', cookieSecure: true, hosted: true, whatsappLogin: { ok: true }, alerts: { enabled: true, template: false, last: null } },
    whatsapp: {
      status: { configured: true, missing: [], expired: false, expiresAt: null, lastFailure: null, unreadable: [], allowedPhone: OWNER, live: null, neverExpires: true },
      lastWebhookAt: new Date(NOW.getTime() - 5 * 60_000),
      lastDeliveryFailure: null
    },
    instagram: { connected: true, metaConfigured: true, missingSecret: false, account: { instagramUserId: '1', username: 'kanyaraasi_memes', status: 'connected', scopes: [], connectedAt: NOW, daysUntilExpiration: 40 } },
    publicBaseUrl: 'https://studio.example.com',
    vision: { configured: true, backend: 'cli', source: 'home' },
    providers: [{ id: 'wikipedia', label: 'Wikipedia', enabled: true, keyConfigured: true, disabledReason: null }],
    usage: [],
    storage: { writable: true, freeBytes: 20 * 1024 ** 3, ephemeral: false },
    push: { ready: true, problem: null, devices: 1, signedInDevices: 1, failingDevices: 0 }
  });
  const find = (r: ReturnType<typeof buildHealth>, id: string) => r.groups.flatMap(g => g.checks).find(c => c.id === id)!;

  it('all good: every check passes and the report says so', () => {
    const r = buildHealth(good());
    assert.equal(r.overall, 'ok');
    assert.equal(r.counts.bad + r.counts.warn, 0, JSON.stringify(r.groups.flatMap(g => g.checks).filter(c => c.status !== 'ok')));
    assert.match(find(r, 'database').summary, /4 ms/);
    assert.match(find(r, 'instagram-account').summary, /@kanyaraasi_memes, connected for another 40 days/);
  });

  it('a database that does not answer is the worst news', () => {
    const f = good();
    f.db = { ok: false, ms: null, error: 'Not connected.' };
    const r = buildHealth(f);
    assert.equal(r.overall, 'bad');
    assert.equal(find(r, 'database').status, 'bad');
    assert.match(find(r, 'database').fix!.text, /MONGO_URI/);
  });

  it('flags the old development tunnel as the public address on a hosted server', () => {
    const f = good();
    f.publicBaseUrl = 'https://jailer-effective-wiring.ngrok-free.dev';
    assert.equal(find(buildHealth(f), 'public-url').status, 'bad');
    f.auth.hosted = false;
    assert.equal(find(buildHealth(f), 'public-url').status, 'warn');
  });

  it('warns about a guessable temporary login and a bot that hears nothing', () => {
    const f = good();
    f.auth.staticLogin = true;
    f.auth.staticWeak = true;
    f.whatsapp.lastWebhookAt = null;
    const r = buildHealth(f);
    assert.equal(find(r, 'login').status, 'warn');
    assert.match(find(r, 'login').summary, /easy-to-guess/);
    assert.equal(find(r, 'whatsapp-webhook').status, 'warn');
    assert.match(find(r, 'whatsapp-webhook').summary, /Nothing received in the 2 hours/);
  });

  it('explains the 24-hour window when WhatsApp holds a message back', () => {
    const f = good();
    f.whatsapp.lastDeliveryFailure = { at: new Date(NOW.getTime() - 10 * 60_000), code: 131047, title: 'Re-engagement message', recipientTail: '8120' };
    const c = find(buildHealth(f), 'whatsapp-delivery');
    assert.equal(c.status, 'warn');
    assert.match(c.summary, /24-hour window had closed/);
    assert.match(c.detail!, /WHATSAPP_ALERT_TEMPLATE/);
  });

  it('an expired token, a missing vision tool and a nearly used-up quota', () => {
    const f = good();
    f.whatsapp.status!.lastFailure = { message: 'Error validating access token', at: new Date(NOW.getTime() - 3600_000) };
    f.vision = { configured: false, backend: 'cli', source: 'not_found' };
    f.providers.push({ id: 'brave-images', label: 'Brave Image Search', enabled: true, keyConfigured: true, disabledReason: null });
    f.usage = [{ provider: 'brave-images', used: 870, limit: 1000 }];
    const r = buildHealth(f);
    assert.equal(find(r, 'whatsapp-token').status, 'bad');
    assert.equal(find(r, 'whatsapp-token').fix!.to, '/settings?section=whatsapp');
    assert.equal(find(r, 'vision').status, 'bad');
    assert.match(find(r, 'quota-brave-images').summary, /870 of 1000/);
    assert.equal(r.overall, 'bad');
  });

  it('a host that forgets files, and no notification devices yet', () => {
    const f = good();
    f.storage.ephemeral = true;
    f.push = { ready: true, problem: null, devices: 0, signedInDevices: 0, failingDevices: 0 };
    const r = buildHealth(f);
    assert.equal(find(r, 'storage').status, 'warn');
    assert.match(find(r, 'storage').summary, /forgets files/);
    assert.equal(find(r, 'push').status, 'off');
    assert.equal(r.overall, 'warn', '"off" (not set up) is not a problem by itself');
  });

  it('alerts that reached nobody', () => {
    const f = good();
    f.auth.alerts.last = { at: new Date(NOW.getTime() - 120_000), kind: 'signin', whatsappSent: 0, whatsappFailed: 2, pushSent: 0, via: 'message' };
    assert.equal(find(buildHealth(f), 'alerts').status, 'warn');
    f.auth.alerts.last = { ...f.auth.alerts.last, whatsappSent: 2, whatsappFailed: 0, pushSent: 1 };
    assert.match(find(buildHealth(f), 'alerts').summary, /went out 2 minutes ago to 2 WhatsApp numbers and 1 device/);
  });
});
