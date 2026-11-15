/**
 * Offline tests: every WhatsApp setting (access token, phone number ID, verify token, app secret, allowed
 * phone) can be saved in the app and is then what the bot actually uses. Meta's API is faked.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { WhatsAppCredentialsService } from '../services/whatsapp-credentials.service';
import { InstagramTokenService } from '../services/instagram-token.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { WhatsAppController } from '../controllers/whatsapp.controller';
import { loadConfig, setConfigForTests } from '../config/app-config';

const ENV_TOKEN = 'EAAENV' + 'e'.repeat(40);
const KEY = 'b'.repeat(64);
const SAVED_SECRET = 'abcdef0123456789abcdef0123456789';
const SAVED_VERIFY = 'my-own-verify-token-42';
const ENV_SECRET = 'envappsecret0123456789abcdef';

function fakeModel() {
  let doc: any = null;
  const chain = (v: any) => ({ lean: () => ({ exec: async () => (v ? { ...v } : null) }), exec: async () => v });
  return {
    get doc() { return doc; },
    findOne: () => chain(doc),
    findOneAndUpdate: (_q: any, upd: any) => {
      doc = { ...(doc || { key: 'default' }), ...upd.$set };
      return chain(doc);
    },
    updateOne: (_q: any, upd: any) => {
      if (doc) doc = { ...doc, ...upd.$set };
      return { exec: async () => ({}) };
    }
  };
}

const realFetch = globalThis.fetch;
function mockMetaOk() {
  const seen: string[] = [];
  globalThis.fetch = (async (url: any) => {
    seen.push(String(url));
    const body = String(url).includes('/debug_token')
      ? { data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 86400 } }
      : { id: '111222333', display_phone_number: '+1 555 010 7826', verified_name: 'Test Number' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() };
  }) as any;
  return seen;
}

describe('every WhatsApp field can be saved in the app', () => {
  before(() =>
    setConfigForTests(
      loadConfig({ WHATSAPP_ACCESS_TOKEN: ENV_TOKEN, WHATSAPP_PHONE_NUMBER_ID: '111222333', WHATSAPP_VERIFY_TOKEN: 'env-verify-token', WHATSAPP_ALLOWED_PHONE: '919876543210', META_APP_ID: '42', META_APP_SECRET: ENV_SECRET, INSTAGRAM_TOKEN_ENCRYPTION_KEY: KEY } as any)
    )
  );
  after(() => {
    setConfigForTests(null);
    globalThis.fetch = realFetch;
  });
  let model: ReturnType<typeof fakeModel>;
  let svc: WhatsAppCredentialsService;
  beforeEach(() => {
    model = fakeModel();
    svc = new WhatsAppCredentialsService(model as any, new InstagramTokenService());
  });

  it('saves verify token, app secret and allowed phone without asking Meta; secrets are encrypted', async () => {
    const seen = mockMetaOk();
    const s = await svc.saveAndVerify({ verifyToken: SAVED_VERIFY, appSecret: SAVED_SECRET, allowedPhone: '+91 93477-08120' });
    assert.equal(seen.length, 0, 'nothing is sent to Meta when only these fields change');

    const stored = JSON.stringify(model.doc);
    assert.ok(!stored.includes(SAVED_VERIFY) && !stored.includes(SAVED_SECRET), 'secrets are not stored in plain text');
    assert.equal(model.doc.allowedPhone, '919347708120', 'phone normalised to digits');
    assert.equal(model.doc.verifyTokenLast4, SAVED_VERIFY.slice(-4));

    const eff = await svc.getEffective();
    assert.equal(eff.verifyToken, SAVED_VERIFY);
    assert.equal(eff.appSecret, SAVED_SECRET);
    assert.equal(eff.allowedPhone, '919347708120');
    assert.deepEqual([eff.sources.verifyToken, eff.sources.appSecret, eff.sources.allowedPhone, eff.sources.accessToken], ['app', 'app', 'app', 'server']);

    assert.equal(s.fields.verifyToken.hint, `••••${SAVED_VERIFY.slice(-4)}`);
    assert.equal(s.fields.appSecret.hint, `••••${SAVED_SECRET.slice(-4)}`);
    assert.equal(s.fields.allowedPhone.value, '919347708120');
    const out = JSON.stringify(s);
    assert.ok(!out.includes(SAVED_VERIFY) && !out.includes(SAVED_SECRET) && !out.includes(ENV_TOKEN), 'the status never contains a secret');
  });

  it('an empty box leaves the saved value alone', async () => {
    mockMetaOk();
    await svc.saveAndVerify({ verifyToken: SAVED_VERIFY, allowedPhone: '919347708120' });
    await svc.saveAndVerify({ verifyToken: '', appSecret: SAVED_SECRET });
    const eff = await svc.getEffective();
    assert.equal(eff.verifyToken, SAVED_VERIFY, 'empty box = unchanged');
    assert.equal(eff.appSecret, SAVED_SECRET);
    await assert.rejects(() => svc.saveAndVerify({ verifyToken: '', appSecret: '' }), /at least one value/);
  });

  it('checks the format of each field and saves nothing on a bad one', async () => {
    mockMetaOk();
    await assert.rejects(() => svc.saveAndVerify({ verifyToken: 'short' }), /verify token/);
    await assert.rejects(() => svc.saveAndVerify({ verifyToken: 'has spaces in it!' }), /verify token/);
    await assert.rejects(() => svc.saveAndVerify({ appSecret: 'not-an-app-secret' }), /app secret/);
    await assert.rejects(() => svc.saveAndVerify({ allowedPhone: '12345' }), /allowed phone/);
    await assert.rejects(() => svc.saveAndVerify({ allowedPhone: '1'.repeat(20) }), /allowed phone/);
    await assert.rejects(() => svc.saveAndVerify({ verifyToken: SAVED_VERIFY, allowedPhone: '12' }), /allowed phone/);
    assert.equal(model.doc, null, 'a bad value in the same request stops everything from being saved');
  });

  it('clears one saved value at a time and falls back to the server setting for it', async () => {
    mockMetaOk();
    await svc.saveAndVerify({ verifyToken: SAVED_VERIFY, appSecret: SAVED_SECRET, allowedPhone: '919347708120' });
    const s = await svc.clearSaved('verifyToken');
    assert.equal(s.fields.verifyToken.source, 'server');
    const eff = await svc.getEffective();
    assert.equal(eff.verifyToken, 'env-verify-token');
    assert.equal(eff.appSecret, SAVED_SECRET, 'other values are untouched');
    assert.equal(eff.allowedPhone, '919347708120');
    await svc.clearSaved('all');
    const all = await svc.getEffective();
    assert.deepEqual(Object.values(all.sources), ['server', 'server', 'server', 'server', 'server']);
  });

  it('the webhook handshake and the signature check use the saved values', async () => {
    mockMetaOk();
    await svc.saveAndVerify({ verifyToken: SAVED_VERIFY, appSecret: SAVED_SECRET });
    const wa = new WhatsAppService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, svc);
    assert.equal(await wa.verifyWebhook('subscribe', SAVED_VERIFY, 'CHALLENGE'), 'CHALLENGE');
    assert.equal(await wa.verifyWebhook('subscribe', 'env-verify-token', 'CHALLENGE'), null, 'the old server value no longer works');

    const processed: any[] = [];
    const ctl = new WhatsAppController({ processIncomingWebhook: async (b: any) => (processed.push(b), undefined) } as any, svc);
    const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
    const send = async (secret: string) => {
      let status = 0;
      const res: any = { status: (c: number) => ((status = c), { send: () => {} }) };
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
      await ctl.handleWebhook(JSON.parse(body.toString()), { rawBody: body } as any, sig, res);
      return status;
    };
    assert.equal(await send(SAVED_SECRET), 200, 'signed with the saved app secret');
    assert.equal(await send(ENV_SECRET), 403, 'signed with the old server secret');
    assert.equal(processed.length, 1);
  });

  it('only the saved allowed phone may use the bot', async () => {
    mockMetaOk();
    await svc.saveAndVerify({ allowedPhone: '911111111111' });
    const sent: string[] = [];
    const doc: any = { phoneNumber: '911111111111', state: 'IDLE', mode: 'viral', async save() { return this; } };
    const wa: any = new WhatsAppService({ findOne: async () => doc, create: async () => doc } as any, {} as any, {} as any, {} as any, {} as any, {} as any, svc);
    wa.sendTextMessage = async (_t: string, m: string) => (sent.push(m), true);
    await wa.handleUserMessage('919876543210', { type: 'text', text: { body: 'hi' } });    // the old server number
    assert.ok(!sent.some(m => m.includes('Meme Engine WhatsApp Bot')), 'no menu for a number that is not allowed');
    await wa.handleUserMessage('911111111111', { type: 'text', text: { body: 'hi' } });    // the saved number
    assert.ok(sent.some(m => m.includes('Meme Engine WhatsApp Bot')));
  });
});

describe('incomplete setup is reported', () => {
  after(() => setConfigForTests(null));
  it('flags a missing verify token, app secret and allowed phone even when the token works', async () => {
    setConfigForTests(loadConfig({ WHATSAPP_ACCESS_TOKEN: ENV_TOKEN, WHATSAPP_PHONE_NUMBER_ID: '111222333' } as any));
    const svc = new WhatsAppCredentialsService(fakeModel() as any, new InstagramTokenService());
    const i = await svc.indicator();
    assert.equal(i.configured, true);
    assert.equal(i.problem, 'incomplete');
    assert.deepEqual([...i.missing].sort(), ['allowedPhone', 'appSecret', 'verifyToken']);
  });
});
