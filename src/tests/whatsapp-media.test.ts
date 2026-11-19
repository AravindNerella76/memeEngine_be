/**
 * Pictures reach the user even when the server's public address is wrong: the bot uploads them to WhatsApp itself. And a
 * failed delivery is reported instead of leaving the user with nothing. Meta's API is replaced by a recording stub.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const PHONE = '911234567890';
const realFetch = globalThis.fetch;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
const JPEG = path.join(TMP, 'meme.jpeg');

interface Call { url: string; method: string; json?: any; form?: FormData }

function installMeta(behaviour: { upload?: 'ok' | 'fail'; message?: 'ok' | 'fail' } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const call: Call = { url: String(url), method: init.method || 'GET' };
    if (init.body instanceof FormData) call.form = init.body;
    else if (typeof init.body === 'string') call.json = JSON.parse(init.body);
    calls.push(call);
    const isUpload = /\/media$/.test(call.url);
    const fail = isUpload ? behaviour.upload === 'fail' : behaviour.message === 'fail';
    const body = fail ? { error: { message: 'nope', code: 100 } } : isUpload ? { id: 'MEDIA123' } : { messages: [{ id: 'wamid.1' }] };
    return new Response(JSON.stringify(body), { status: fail ? 400 : 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return calls;
}

function build() {
  const sent: string[] = [];
  const svc: any = new WhatsAppService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const text = svc.sendTextMessage.bind(svc);
  svc.sendTextMessage = async (to: string, t: string) => (sent.push(`${to}: ${t}`), true);
  svc.__realText = text;
  return { svc, sent };
}

describe('WhatsApp pictures are uploaded, not linked', () => {
  before(() => {
    setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE, WHATSAPP_ACCESS_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '555' } as any));
    fs.writeFileSync(JPEG, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]));
  });
  after(() => {
    globalThis.fetch = realFetch;
    setConfigForTests(null);
    fs.rmSync(TMP, { recursive: true, force: true });
  });
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uploads the file to WhatsApp and sends it by media id, never touching the public address', async () => {
    const calls = installMeta();
    const { svc } = build();
    const ok = await svc.sendPicture(PHONE, { filePath: JPEG, url: 'https://wrong.ngrok-free.dev/output/meme.jpeg' }, 'Ready!');
    assert.equal(ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/555\/media$/);
    assert.equal(calls[0].form?.get('messaging_product'), 'whatsapp');
    assert.equal(calls[0].form?.get('type'), 'image/jpeg');
    assert.ok(calls[0].form?.get('file') instanceof Blob);
    assert.match(calls[1].url, /\/555\/messages$/);
    assert.deepEqual(calls[1].json.image, { id: 'MEDIA123', caption: 'Ready!' });
    assert.equal(JSON.stringify(calls).includes('ngrok'), false, 'the wrong public address is not used at all');
  });

  it('sends a picture held in memory the same way', async () => {
    const calls = installMeta();
    const { svc } = build();
    assert.equal(await svc.sendPicture(PHONE, { buffer: Buffer.from('jpegbytes'), mimeType: 'image/jpeg', url: 'https://x/y.jpg' }), true);
    assert.equal(calls[1].json.image.id, 'MEDIA123');
    assert.equal(calls[1].json.image.caption, undefined);
  });

  it('falls back to the link when the upload fails', async () => {
    const calls = installMeta({ upload: 'fail' });
    const { svc } = build();
    const ok = await svc.sendPicture(PHONE, { filePath: JPEG, url: 'https://good.example/output/meme.jpeg' }, 'Hi');
    assert.equal(ok, true);
    assert.deepEqual(calls.map(c => c.url.split('/').pop()), ['media', 'messages']);
    assert.deepEqual(calls[1].json.image, { link: 'https://good.example/output/meme.jpeg', caption: 'Hi' });
  });

  it('falls back to the link when the file is missing, and reports failure only when both ways fail', async () => {
    const calls = installMeta();
    const { svc } = build();
    assert.equal(await svc.sendPicture(PHONE, { filePath: path.join(TMP, 'gone.jpeg'), url: 'https://good.example/a.jpg' }), true);
    assert.equal(calls.length, 1, 'no upload was attempted without a file');
    assert.equal(calls[0].json.image.link, 'https://good.example/a.jpg');

    const none = installMeta({ upload: 'fail', message: 'fail' });
    assert.equal(await svc.sendPicture(PHONE, { filePath: JPEG, url: 'https://good.example/a.jpg' }), false);
    assert.equal(none.length, 2);
  });

  it('does not try to upload a picture larger than WhatsApp accepts (5 MB)', async () => {
    const calls = installMeta();
    const { svc } = build();
    await svc.sendPicture(PHONE, { buffer: Buffer.alloc(5 * 1024 * 1024 + 1), url: 'https://good.example/big.jpg' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].json.image.link, 'https://good.example/big.jpg');
  });

  it('a delivered meme goes out by upload under three buttons: Publish, Change punchline, Discard', async () => {
    const calls = installMeta();
    const { svc } = build();
    const session: any = { phoneNumber: PHONE, state: 'GENERATING', async save() { return this; } };
    await svc.deliverMeme(session, PHONE, { memeId: 'm1', outputUrls: { jpeg: '/output/m1.jpeg' }, outputPaths: { jpeg: JPEG }, content: { headline: 'HEAD', punchline: 'My punchline' } }, 'My punchline');
    assert.equal(session.state, 'AWAITING_APPROVAL');
    const msg = calls.find(c => /messages$/.test(c.url))!;
    assert.equal(msg.json.type, 'interactive');
    assert.equal(msg.json.interactive.type, 'button');
    assert.deepEqual(msg.json.interactive.header, { type: 'image', image: { id: 'MEDIA123' } }, 'the picture is uploaded, not linked');
    assert.match(msg.json.interactive.body.text, /My punchline/);
    const buttons = msg.json.interactive.action.buttons.map((b: any) => b.reply);
    assert.deepEqual(buttons.map((b: any) => b.id), ['pub:m1', 'pl:m1', 'no:m1']);
    assert.ok(buttons.every((b: any) => b.title.length <= 20), 'WhatsApp allows 20 characters per button');
    // the Instagram caption is the studio's: punchline, headline, follow line and hashtags
    assert.match(session.lastGeneratedCaption, /My punchline[\s\S]*HEAD[\s\S]*Follow @kanyaraasi_memes[\s\S]*#telugumemes/);
  });

  it('when buttons cannot be sent, the same meme goes out as a picture with the written commands', async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const call: Call = { url: String(url), method: init.method || 'GET' };
      if (typeof init.body === 'string') call.json = JSON.parse(init.body);
      calls.push(call);
      const isUpload = /\/media$/.test(call.url);
      const refuse = call.json?.type === 'interactive';
      return new Response(JSON.stringify(refuse ? { error: { message: 'no buttons', code: 100 } } : isUpload ? { id: 'MEDIA123' } : { messages: [{ id: 'wamid.1' }] }), { status: refuse ? 400 : 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    const { svc } = build();
    const session: any = { phoneNumber: PHONE, state: 'GENERATING', async save() { return this; } };
    await svc.deliverMeme(session, PHONE, { memeId: 'm1', outputUrls: { jpeg: '/output/m1.jpeg' }, outputPaths: { jpeg: JPEG }, content: { punchline: 'My punchline' } }, 'My punchline');
    const image = calls.filter(c => /messages$/.test(c.url) && c.json?.type === 'image').pop()!;
    assert.equal(image.json.image.id, 'MEDIA123');
    assert.match(image.json.image.caption, /My punchline[\s\S]*Approve/);
    assert.equal(session.state, 'AWAITING_APPROVAL');
  });
});

describe('WhatsApp reports a message it could not deliver', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  const failed = (id: string, code: number) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id, status: 'failed', recipient_id: PHONE, errors: [{ code, title: 'Media upload error', error_data: { details: 'Unable to fetch the media' } }] }] } }] }] });

  it('tells the user once when a picture could not be loaded', async () => {
    const { svc, sent } = build();
    await svc.processIncomingWebhook(failed('wamid.A', 131053));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /could not load the picture/);
    assert.match(sent[0], /My Memes/);
    await svc.processIncomingWebhook(failed('wamid.A', 131053)); // Meta repeats itself
    assert.equal(sent.length, 1, 'once per message');
  });

  it('never answers a failed text with a text, and ignores delivered and read', async () => {
    const { svc, sent } = build();
    await svc.processIncomingWebhook(failed('wamid.B', 131047)); // outside the 24 h window
    await svc.processIncomingWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.C', status: 'delivered', recipient_id: PHONE }, { id: 'wamid.D', status: 'read', recipient_id: PHONE }] } }] }] });
    assert.deepEqual(sent, []);
  });

  it('does not message a number that is not allowed', async () => {
    const { svc, sent } = build();
    const body = failed('wamid.E', 131053);
    (body.entry[0].changes[0].value.statuses[0] as any).recipient_id = '910000000000';
    await svc.processIncomingWebhook(body);
    assert.deepEqual(sent, []);
  });
});
