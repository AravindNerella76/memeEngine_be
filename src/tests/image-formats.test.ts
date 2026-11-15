/**
 * Offline tests: accepting any image format (HEIC, PDF, WebP ...) at full resolution, WhatsApp
 * documents and links, and Instagram feed image rules. No network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { ImageValidationError } from '../security/image-verify';
import { isHeic, isPdf, normalizeImageBuffer } from '../security/image-normalize';
import { WhatsAppService } from '../services/whatsapp.service';
import { InstagramPublisherService } from '../services/instagram-publisher.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

function solid(w: number, h: number, color = '#2060e0'): any {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

/** A one-page PDF whose page is a single embedded JPEG, like a photo saved as PDF. */
function pdfWithJpeg(jpg: Buffer, w: number, h: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    len += buf.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>');
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  offsets[5] = len;
  push('5 0 obj\n');
  push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
  push(jpg);
  push('\nendstream\nendobj\n');
  const xref = len;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe('image normalisation', () => {
  it('keeps JPEG, PNG and WebP byte-for-byte (no quality loss)', async () => {
    const c = solid(800, 600);
    for (const [mime, type] of [['image/jpeg', 'jpeg'], ['image/png', 'png'], ['image/webp', 'webp']] as const) {
      const buf = c.toBuffer(mime as any);
      const r = await normalizeImageBuffer(buf);
      assert.equal(r.type, type);
      assert.equal(r.convertedFrom, 'none');
      assert.equal(r.buffer, buf, 'same bytes');
      assert.equal(r.width, 800);
    }
  });

  it('converts a PDF page to a full-resolution image', async () => {
    const jpg = solid(1500, 2121).toBuffer('image/jpeg', 92);
    const r = await normalizeImageBuffer(pdfWithJpeg(jpg, 1500, 2121));
    assert.equal(r.convertedFrom, 'pdf');
    assert.ok(Math.max(r.width, r.height) >= 3900, `long side ${Math.max(r.width, r.height)} should be about 4000px`);
    assert.ok(Math.abs(r.width / r.height - 595 / 842) < 0.01, 'page proportions kept');
    assert.ok(['png', 'jpeg'].includes(r.type));
  });

  it('detects HEIC/PDF by content and gives a readable error for a damaged HEIC', async () => {
    const fakeHeic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
    assert.equal(isHeic(fakeHeic), true);
    assert.equal(isPdf(Buffer.from('%PDF-1.7\n...')), true);
    await assert.rejects(() => normalizeImageBuffer(fakeHeic), (e: any) => e instanceof ImageValidationError && /HEIC/.test(e.message));
  });

  it('rejects everything that is not a supported picture, whatever the file name says', async () => {
    for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('GIF89a......'), Buffer.from('<html>hi</html>'), Buffer.alloc(0)]) {
      await assert.rejects(() => normalizeImageBuffer(bad), ImageValidationError);
    }
    await assert.rejects(() => normalizeImageBuffer(Buffer.from('%PDF-1.4 truncated nonsense')), ImageValidationError);
  });
});

describe('WhatsApp documents and links', () => {
  const PHONE = '911234567890';
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  function build() {
    const sent: string[] = [];
    const doc: any = { phoneNumber: PHONE, state: 'IDLE', mode: 'viral', manualSubjects: [], async save() { return this; } };
    const model: any = { findOne: async () => doc, create: async () => doc };
    const svc: any = new WhatsAppService(model, {} as any, {} as any, {} as any, {} as any, {} as any);
    svc.sendTextMessage = async (_t: string, m: string) => (sent.push(m), true);
    const got: any[] = [];
    const img = (n: number) => ({ filePath: `/x/wa_${n}.png`, filename: `wa_${n}.png`, mimeType: 'image/png', width: 3000, height: 2000, convertedFrom: 'none' });
    svc.downloadMedia = async (id: string) => (got.push(['media', id]), img(got.length));
    svc.downloadImageFromUrl = async (u: string) => (got.push(['url', u]), img(got.length));
    return { svc, doc, sent, got };
  }

  it('accepts a document (original quality file) like a photo', async () => {
    const t = build();
    await t.svc.handleUserMessage(PHONE, { type: 'document', document: { id: '777', mime_type: 'image/heic', filename: 'IMG_1.heic' } });
    assert.deepEqual(t.got, [['media', '777']]);
    assert.equal(t.doc.state, 'AWAITING_REACTION');
    assert.equal(t.doc.referenceImagePath, '/x/wa_1.png');
  });

  it('treats a pasted link as the picture when a picture is expected, with extra words as the caption', async () => {
    const t = build();
    await t.svc.handleUserMessage(PHONE, { type: 'text', text: { body: 'https://example.com/ref.jpg' } });
    assert.equal(t.doc.state, 'AWAITING_REACTION');
    await t.svc.handleUserMessage(PHONE, { type: 'text', text: { body: 'https://example.com/face.heic, funny line' } });
    assert.deepEqual(t.got.map(g => g[0]), ['url', 'url']);
    assert.equal(t.got[1][1], 'https://example.com/face.heic');
    assert.equal(t.doc.punchline, ', funny line'.trim(), 'text around the link is the caption');
  });

  it('does not treat a link as a picture while text is expected', async () => {
    const t = build();
    t.doc.state = 'AWAITING_PUNCHLINE';
    t.doc.referenceImagePath = '/x/ref.png';
    t.doc.reactionImagePath = '/x/rx.png';
    t.svc.generateAndSendMeme = async () => {};
    await t.svc.handleUserMessage(PHONE, { type: 'text', text: { body: 'Watch https://example.com/x now' } });
    assert.equal(t.got.length, 0);
    assert.equal(t.doc.punchline, 'Watch https://example.com/x now');
  });

  it('tells the user once that WhatsApp compressed a photo, and that a Document keeps full quality', async () => {
    const t = build();
    t.doc.state = 'AWAITING_REACTION';
    t.svc.downloadMedia = async () => ({ filePath: '/x/a.jpg', filename: 'a.jpg', mimeType: 'image/jpeg', width: 1280, height: 960, convertedFrom: 'none' });
    t.doc.punchline = null;
    await t.svc.handleUserMessage(PHONE, { type: 'image', image: { id: '1' } });
    assert.ok(t.sent.some(m => m.includes('compressed') && m.includes('Document')));
    const tips = () => t.sent.filter(m => m.includes('compressed')).length;
    assert.equal(tips(), 1);
    t.doc.state = 'AWAITING_REACTION';
    await t.svc.handleUserMessage(PHONE, { type: 'image', image: { id: '2' } });
    assert.equal(tips(), 1, 'only once');
  });

  it('reports an unusable file clearly', async () => {
    const t = build();
    t.svc.downloadMedia = async () => { throw new Error('Unsupported file. Send a JPEG, PNG, WebP, HEIC or PDF.'); };
    await t.svc.handleUserMessage(PHONE, { type: 'document', document: { id: '5' } });
    assert.ok(t.sent.some(m => m.includes('could not use that picture') && m.includes('Unsupported file')));
  });

  it('extracts links and rewrites Google Drive / Dropbox share links', () => {
    const { svc } = build();
    assert.equal(svc.extractUrl('see (https://a.example/p.jpg).'), 'https://a.example/p.jpg');
    assert.equal(svc.extractUrl('no link here'), null);
    assert.equal(svc.directDownloadUrl('https://drive.google.com/file/d/AbC_123-x/view?usp=sharing'), 'https://drive.google.com/uc?export=download&id=AbC_123-x');
    assert.equal(svc.directDownloadUrl('https://www.dropbox.com/s/abc/p.heic?dl=0'), 'https://www.dropbox.com/s/abc/p.heic?dl=1');
    assert.equal(svc.directDownloadUrl('https://a.example/p.jpg'), 'https://a.example/p.jpg');
  });
});

describe('Instagram feed image rules', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pub: any = new InstagramPublisherService({} as any, {} as any);
  const file = (w: number, h: number) => {
    const p = path.join(dir, `${w}x${h}.jpeg`);
    fs.writeFileSync(p, solid(w, h).toBuffer('image/jpeg', 80));
    return p;
  };

  it('accepts 4:5, square and 1.91:1', () => {
    for (const [w, h] of [[1080, 1350], [1080, 1080], [1080, 566]]) assert.doesNotThrow(() => pub.assertInstagramFeedImage(file(w, h)));
  });
  it('rejects a 9:16 story-size meme with an explanation, and too-narrow images', () => {
    assert.throws(() => pub.assertInstagramFeedImage(file(1080, 1920)), /4:5 and 1\.91:1/);
    assert.throws(() => pub.assertInstagramFeedImage(file(300, 300)), /320/);
  });
  it('rejects a PNG and ignores a missing file', () => {
    const p = path.join(dir, 'x.png');
    fs.writeFileSync(p, solid(1080, 1350).toBuffer('image/png'));
    assert.throws(() => pub.assertInstagramFeedImage(p), /JPEG/);
    assert.doesNotThrow(() => pub.assertInstagramFeedImage(path.join(dir, 'missing.jpeg')));
    assert.doesNotThrow(() => pub.assertInstagramFeedImage(undefined));
  });
});
