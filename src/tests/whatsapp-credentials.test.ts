/**
 * Offline tests: WhatsApp token saved in the app (encrypted, verified with Meta before saving,
 * used by the sender, health indicator). Meta's API is faked; nothing leaves the machine.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppCredentialsService, cleanAccessToken } from '../services/whatsapp-credentials.service';
import { InstagramTokenService } from '../services/instagram-token.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const ENV_TOKEN = 'EAAENV' + 'e'.repeat(40);
const NEW_TOKEN = 'EAANEW' + 'n'.repeat(40) + 'WXYZ';
const KEY = 'a'.repeat(64);

function fakeModel() {
  let doc: any = null;
  const chain = (v: any) => ({ lean: () => ({ exec: async () => (v ? { ...v } : null) }), exec: async () => v });
  return {
    get doc() { return doc; },
    set doc(v: any) { doc = v; },
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
type Handler = (url: string, init?: any) => { status: number; body: any } | Error;
function mockFetch(handler: Handler) {
  const seen: { url: string; init?: any }[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push({ url: String(url), init });
    const r = handler(String(url), init);
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body), headers: new Headers() };
  }) as any;
  return seen;
}

/** Meta says the token is fine for the phone number, and (token inspector) expires in 2 days. */
const metaOk: Handler = url =>
  url.includes('/debug_token')
    ? { status: 200, body: { data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 2 * 86400 } } }
    : { status: 200, body: { id: '111222333', display_phone_number: '+1 555 010 7826', verified_name: 'Test Number' } };
const metaExpired: Handler = () => ({ status: 401, body: { error: { code: 190, message: 'Error validating access token: Session has expired' } } });

describe('WhatsApp credentials saved in the app', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ACCESS_TOKEN: ENV_TOKEN, WHATSAPP_PHONE_NUMBER_ID: '111222333', WHATSAPP_VERIFY_TOKEN: 'env-verify-token', WHATSAPP_ALLOWED_PHONE: '919876543210', META_APP_ID: '42', META_APP_SECRET: 'appsecret0123456789abcdef', INSTAGRAM_TOKEN_ENCRYPTION_KEY: KEY } as any)));
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

  it('uses the server setting until a token is saved, then the saved token wins', async () => {
    const before = await svc.getEffective();
    assert.equal(before.tokenSource, 'server');
    assert.equal(before.accessToken, ENV_TOKEN);

    mockFetch(metaOk);
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    const after = await svc.getEffective();
    assert.equal(after.tokenSource, 'app');
    assert.equal(after.accessToken, NEW_TOKEN);
  });

  it('stores the token encrypted and never returns it', async () => {
    mockFetch(metaOk);
    const status = await svc.saveAndVerify({ accessToken: `Bearer ${NEW_TOKEN}\n` });
    const stored = JSON.stringify(model.doc);
    assert.ok(!stored.includes(NEW_TOKEN), 'no plaintext token in the database record');
    assert.ok(!stored.includes('nnnnnnnn'), 'not even a long fragment');
    assert.equal(model.doc.tokenLast4, 'WXYZ');
    assert.ok(model.doc.encryptedAccessToken && model.doc.iv && model.doc.tag);

    assert.equal(status.tokenHint, '••••WXYZ');
    assert.equal(status.tokenSource, 'app');
    assert.equal(status.live?.ok, true);
    assert.equal(status.live?.verifiedName, 'Test Number');
    assert.equal(status.expired, false);
    assert.ok(status.expiresAt && status.expiresAt.getTime() > Date.now());
    assert.ok(!JSON.stringify(status).includes(NEW_TOKEN), 'the status never contains the token');
    assert.ok(!JSON.stringify(status).includes(ENV_TOKEN));
  });

  it('does not save a token that Meta rejects, and keeps the working one', async () => {
    mockFetch(metaOk);
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    const kept = JSON.stringify(model.doc);

    mockFetch(metaExpired);
    await assert.rejects(() => svc.saveAndVerify({ accessToken: 'EAABAD' + 'b'.repeat(40) }), /invalid or has expired.*Nothing was saved/s);
    assert.equal(JSON.stringify(model.doc), kept, 'saved record untouched');
    assert.equal((await svc.getEffective()).accessToken, NEW_TOKEN);
  });

  it('does not save when Meta cannot be reached', async () => {
    mockFetch(() => new Error('getaddrinfo ENOTFOUND graph.facebook.com'));
    await assert.rejects(() => svc.saveAndVerify({ accessToken: NEW_TOKEN }), /Could not reach Meta.*Nothing was saved/s);
    assert.equal(model.doc, null);
  });

  it('rejects things that are not tokens, and cleans pasted ones', async () => {
    mockFetch(metaOk);
    await assert.rejects(() => svc.saveAndVerify({ accessToken: 'hello world' }), /does not look like an access token/);
    await assert.rejects(() => svc.saveAndVerify({ accessToken: 'x'.repeat(2000) }), /does not look like an access token/);
    await assert.rejects(() => svc.saveAndVerify({}), /at least one value/);
    await assert.rejects(() => svc.saveAndVerify({ phoneNumberId: 'abc' }), /phone number ID/);
    assert.equal(cleanAccessToken('  Authorization: Bearer "EAAxx yy"\n'), 'EAAxxyy');
    assert.equal(cleanAccessToken(42), null);
  });

  it('can change only the phone number ID (checked with the current token)', async () => {
    const seen = mockFetch(metaOk);
    const s = await svc.saveAndVerify({ phoneNumberId: ' 999888777 ' });
    assert.equal(s.phoneNumberId, '999888777');
    assert.equal(s.phoneSource, 'app');
    assert.equal(s.tokenSource, 'server', 'token still from the server setting');
    assert.ok(seen[0].url.includes('/999888777?'));
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${ENV_TOKEN}`);
  });

  it('removing the saved token goes back to the server setting', async () => {
    mockFetch(metaOk);
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    const s = await svc.clearSavedToken();
    assert.equal(s.tokenSource, 'server');
    assert.equal((await svc.getEffective()).accessToken, ENV_TOKEN);
    assert.equal(model.doc.encryptedAccessToken, null);
  });

  it('survives an unreadable saved token (encryption key changed) by falling back and saying so', async () => {
    model.doc = { key: 'default', encryptedAccessToken: 'Zm9v', iv: 'YmFy', tag: 'YmF6', tokenLast4: 'abcd' };
    const eff = await svc.getEffective();
    assert.equal(eff.tokenSource, 'server');
    assert.equal(eff.savedTokenUnreadable, true);
  });

  it('flags a rejected token seen while sending, and clears it after a good send or a new token', async () => {
    mockFetch(metaOk);
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    assert.equal((await svc.indicator()).problem, null);
    svc.noteSendResult({ error: { code: 190, message: 'Session has expired' } });
    assert.equal((await svc.indicator()).problem, 'rejected');
    svc.noteSendResult(null);
    assert.equal((await svc.indicator()).problem, null);

    svc.noteSendResult({ error: { code: 131030, message: 'recipient not in allowed list' } });
    assert.equal((await svc.indicator()).problem, null, 'other WhatsApp errors are not token problems');

    svc.noteSendResult({ error: { code: 190, message: 'expired' } });
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    assert.equal((await svc.indicator()).problem, null, 'saving a working token clears it');
  });

  it('reports an expired token from its saved expiry date', async () => {
    mockFetch(metaOk);
    await svc.saveAndVerify({ accessToken: NEW_TOKEN });
    model.doc = { ...model.doc, tokenExpiresAt: new Date(Date.now() - 3600_000) };
    const i = await svc.indicator();
    assert.equal(i.configured, true);
    assert.equal(i.problem, 'expired');
  });

  it('live check marks an expired token as expired', async () => {
    mockFetch(metaExpired);
    const s = await svc.status(true);
    assert.equal(s.live?.ok, false);
    assert.equal(s.live?.errorCode, 190);
    assert.equal(s.expired, true);
    assert.equal(s.lastFailure?.message.includes('expired'), true);
  });
});

describe('WhatsApp sender uses the saved credentials', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ACCESS_TOKEN: ENV_TOKEN, WHATSAPP_PHONE_NUMBER_ID: '111222333' } as any)));
  after(() => {
    setConfigForTests(null);
    globalThis.fetch = realFetch;
  });

  function build(creds?: any) {
    return new WhatsAppService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, creds);
  }

  it('sends with the saved token and phone number ID, and reports a rejected token', async () => {
    const noted: any[] = [];
    const creds: any = { getEffective: async () => ({ accessToken: 'SAVED_TOKEN_' + 'x'.repeat(20), phoneNumberId: '999000111' }), noteSendResult: (b: any) => noted.push(b) };
    const svc = build(creds);

    let seen = mockFetch(() => ({ status: 200, body: { messages: [{ id: 'wamid' }] } }));
    assert.equal(await svc.sendTextMessage('911234567890', 'hello'), true);
    assert.ok(seen[0].url.includes('/999000111/messages'));
    assert.equal(seen[0].init.headers.Authorization, 'Bearer SAVED_TOKEN_' + 'x'.repeat(20));
    assert.deepEqual(noted, [null], 'a good send clears the problem flag');

    seen = mockFetch(() => ({ status: 401, body: { error: { code: 190, message: 'Session has expired' } } }));
    assert.equal(await svc.sendTextMessage('911234567890', 'hello'), false);
    assert.equal(noted[1].error.code, 190);
    assert.equal(await svc.sendImageMessage('911234567890', 'https://x/y.jpg'), false);
    assert.equal(noted[2].error.code, 190);
  });

  it('still works with the server settings when there is no credentials service', async () => {
    const svc = build(undefined);
    const seen = mockFetch(() => ({ status: 200, body: {} }));
    assert.equal(await svc.sendTextMessage('911234567890', 'hi'), true);
    assert.ok(seen[0].url.includes('/111222333/messages'));
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${ENV_TOKEN}`);
  });
});
