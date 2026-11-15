/**
 * Offline test of the WhatsApp conversation with the reaction library and the "which frame?" question: fake session store,
 * fake library, fake engine, real pictures drawn in code. Nothing is sent anywhere.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const PHONE = '911234567890';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reactions-'));

function drawScene(g: any, x: number, y: number, w: number, h: number, hue: number, seed: number) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = `hsl(${hue}, 45%, 38%)`;
  g.fillRect(x, y, w, h);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsl(${hue + rnd() * 50}, ${30 + rnd() * 50}%, ${20 + rnd() * 55}%)`;
    g.beginPath();
    g.arc(x + rnd() * w, y + rnd() * h, 8 + rnd() * 40, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgb(205,150,115)';
  g.beginPath();
  g.ellipse(x + w * 0.72, y + h * 0.32, w * 0.09, h * 0.2, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** A square picture of two stacked frames (like the owner's). */
function makeStack(file: string, size = 480) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const half = Math.floor((size - 16) / 2);
  drawScene(g, 0, 0, size, half, 200, 1);
  g.fillStyle = '#050505';
  g.fillRect(0, half, size, 16);
  drawScene(g, 0, half + 16, size, half, 250, 2);
  fs.writeFileSync(file, c.toBuffer('image/png'));
}
function makeSingle(file: string) {
  const c = createCanvas(1280, 720);
  drawScene(c.getContext('2d'), 0, 0, 1280, 720, 210, 3);
  fs.writeFileSync(file, c.toBuffer('image/jpeg', 85));
}

const STACK = path.join(TMP, 'stack.png');
const BIG_STACK = path.join(TMP, 'stack-big.png');
const SINGLE = path.join(TMP, 'single.jpg');

function thumb(hue: number) {
  const c = createCanvas(240, 180);
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${hue}, 60%, 40%)`;
  g.fillRect(0, 0, 240, 180);
  return c.toBuffer('image/jpeg', 80);
}

const ITEMS = [
  { imageId: 'a1', category: 'shocking', name: '', tags: ['brahmanandam'], usedCount: 0 },
  { imageId: 'a2', category: 'shocking', name: 'Brahmi mouth open', tags: ['brahmanandam', 'laugh'], usedCount: 2 },
  { imageId: 'a3', category: 'shocking', name: '', tags: [], usedCount: 0 },
  { imageId: 'b1', category: 'sad funny', name: '', tags: ['sunil'], usedCount: 1 }
];

function build(opts: { library?: boolean; listWorks?: boolean; pictureFor?: Record<string, string> } = {}) {
  const sent: string[] = [];
  const images: Array<{ url: string; caption?: string }> = [];
  const lists: Array<{ body: string; rows: any[] }> = [];
  const used: string[] = [];
  let doc: any = null;
  const make = (phoneNumber: string) => ({ phoneNumber, state: 'IDLE', mode: 'viral', manualSubjects: [], punchline: null, reactionImagePath: null, async save() { return this; } });
  const model: any = {
    findOne: async () => doc,
    create: async (d: any) => ((doc = Object.assign(make(d.phoneNumber), d)), doc),
    findOneAndUpdate: async (_q: any, upd: any) => { doc.manualSubjects.push(upd.$push.manualSubjects); return doc; }
  };
  const adaptCalls: any[] = [];
  const viral: any = {
    analyzeDraft: async () => ({ draftId: 'draft1', slots: [{ slot: 1, label: 'Hero', subject: 'Someone' }] }),
    adapt: async (input: any) => { adaptCalls.push(input); return { meme: { memeId: 'v1', outputUrls: { jpeg: '/output/v1.jpeg' }, content: {} } }; }
  };
  let engineInput: any = null;
  const engine: any = { generateMeme: async (i: any) => { engineInput = i; return { memeId: 'm1', outputUrls: { jpeg: '/output/m1.jpeg' }, content: i.content }; } };
  const selection: any = { stageUpload: async () => ({ token: 't' }), discard: () => {} };

  const library: any = opts.library === false ? undefined : {
    categories: async () => {
      const m = new Map<string, number>();
      ITEMS.forEach(i => m.set(i.category, (m.get(i.category) || 0) + 1));
      const categories = [...m].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
      return { categories, total: ITEMS.length };
    },
    list: async (q: any) => {
      let rows = ITEMS.filter(i => (!q.category || i.category === q.category) && (!q.search || [i.name, i.category, ...i.tags].some(t => t.toLowerCase().includes(String(q.search).toLowerCase()))));
      if (q.sort === 'recent') rows = rows.filter(i => i.usedCount > 0);
      return { items: rows.slice(q.skip, q.skip + q.limit), total: rows.length };
    },
    thumbs: async (ids: string[]) => new Map(ids.map((id, i) => [id, { data: thumb(i * 40), mime: 'image/jpeg' }])),
    materialize: async (id: string) => ({ filePath: opts.pictureFor?.[id] || SINGLE, mimeType: SINGLE.endsWith('.png') ? 'image/png' : 'image/jpeg', category: ITEMS.find(i => i.imageId === id)?.category || '' }),
    markUsed: async (id: string) => { used.push(id); }
  };

  const svc: any = new WhatsAppService(model, viral, {} as any, engine, selection, { list: async () => [], get: async () => null, getByPosition: async () => null, markUsed: async () => {} } as any, undefined, library);
  svc.sheetDir = TMP;
  svc.sendTextMessage = async (_to: string, t: string) => (sent.push(t), true);
  svc.sendImageMessage = async (_to: string, url: string, caption?: string) => (images.push({ url, caption }), sent.push('[image] ' + (caption || '')), true);
  svc.sendListMessage = async (_to: string, body: string, _btn: string, rows: any[]) => {
    if (opts.listWorks === false) return false;
    lists.push({ body, rows });
    sent.push('[list] ' + rows.map(r => r.id).join(','));
    return true;
  };
  let n = 0;
  const received: string[] = [];
  svc.downloadMedia = async () => {
    const p = received.shift() || SINGLE;
    return { filePath: p, filename: path.basename(p), mimeType: p.endsWith('.png') ? 'image/png' : 'image/jpeg', width: 100, height: 100, convertedFrom: 'none', n: ++n };
  };
  const text = (body: string) => svc.handleUserMessage(PHONE, { type: 'text', text: { body } });
  const image = (caption = '') => svc.handleUserMessage(PHONE, { type: 'image', image: { id: '123', caption } });
  const tap = (id: string) => svc.handleUserMessage(PHONE, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 'x' } } });
  return {
    svc, sent, images, lists, used, adaptCalls, text, image, tap,
    nextPictures(...p: string[]) { received.push(...p); },
    get doc() { return doc; },
    get engineInput() { return engineInput; },
    last() { return sent[sent.length - 1]; }
  };
}

describe('WhatsApp: the reaction library', () => {
  before(() => {
    setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any));
    makeStack(STACK);
    makeStack(BIG_STACK, 1440);
    makeSingle(SINGLE);
  });
  after(() => setConfigForTests(null));

  it('offers the library once the reference is in, browses a folder as a numbered sheet and uses a picture', async () => {
    const t = build();
    await t.image(); // the reference
    assert.equal(t.doc.state, 'AWAITING_REACTION');
    assert.ok(t.sent.some(m => /Library/.test(m) && /4 saved reactions/.test(m)), 'the reaction request mentions the library');

    await t.text('library');
    assert.equal(t.doc.state, 'LIBRARY_FOLDERS');
    assert.ok(/Shocking \(3\)/.test(t.last()) && /Sad funny \(1\)/.test(t.last()), 'folders with counts: ' + t.last().slice(0, 120));
    assert.ok(/Recently used/.test(t.last()), 'recently used is offered');

    await t.text('1'); // Shocking
    assert.equal(t.doc.state, 'LIBRARY_PICK');
    assert.deepEqual(t.doc.libraryIds, ['a1', 'a2', 'a3']);
    assert.equal(t.images.length, 1);
    assert.match(t.images[0].url, /\/output\/wa_sheet_[0-9a-f-]+\.jpg$/);
    assert.ok(fs.existsSync(path.join(TMP, path.basename(t.images[0].url))), 'the sheet is a real file');
    assert.ok((t.images[0].caption || '').includes('*number* of the picture'), 'the caption says how to choose');

    await t.text('2'); // Brahmi mouth open
    assert.equal(t.doc.state, 'AWAITING_PUNCHLINE', 'an ordinary picture goes straight to the punchline');
    assert.equal(t.doc.reactionLibraryId, 'a2');
    assert.equal(t.doc.reactionImagePath, SINGLE);
    assert.ok(t.sent.some(m => /Using your \*shocking\* picture/.test(m)));

    await t.text('Super line');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(t.adaptCalls.length, 1);
    assert.equal(t.adaptCalls[0].punchline, 'Super line');
    assert.equal(t.adaptCalls[0].reactionFraming, undefined, 'no choice made, nothing sent');
    assert.deepEqual(t.used, ['a2'], 'the library picture is counted as used');
  });

  it('searches by words, shows recently used, pages and goes back', async () => {
    const t = build();
    await t.image();
    await t.text('library laugh');
    assert.equal(t.doc.state, 'LIBRARY_PICK');
    assert.deepEqual(t.doc.libraryIds, ['a2'], 'a tag search');

    await t.text('back'); // the folders
    assert.equal(t.doc.state, 'LIBRARY_FOLDERS');
    await t.text('0'); // recently used
    assert.equal(t.doc.state, 'LIBRARY_PICK');
    assert.deepEqual(t.doc.libraryIds, ['a2', 'b1']);
    await t.text('more');
    assert.match(t.last(), /last page/);
    await t.text('zzz-not-a-number');
    assert.match(t.last(), /Reply with a number from 1 to 2/);
    await t.text('close');
    assert.equal(t.doc.state, 'AWAITING_REACTION');
  });

  it('says so when nothing matches, and when the library is empty or missing', async () => {
    const t = build();
    await t.image();
    await t.text('library nothing-like-this');
    assert.match(t.last(), /Nothing found/);
    assert.equal(t.doc.state, 'LIBRARY_FOLDERS');
    await t.text('back');
    assert.equal(t.doc.state, 'AWAITING_REACTION');

    const none = build({ library: false });
    await none.image();
    await none.text('library');
    assert.equal(none.doc.state, 'AWAITING_REACTION', 'without a library the word is just text');
    assert.ok(!none.sent.some(m => /saved reactions/.test(m)));
  });

  it('asks for the reference first when the library is opened too early, and Reset leaves it', async () => {
    const t = build();
    await t.text('library');
    assert.equal(t.doc.state, 'IDLE');
    assert.match(t.last(), /reference meme/);
    await t.image();
    await t.text('library');
    await t.text('reset');
    assert.equal(t.doc.state, 'IDLE');
    assert.equal(t.doc.reactionFraming, null);
    assert.deepEqual(t.doc.libraryIds, []);
  });

  it('a picture sent while the library is open is used as the reaction image', async () => {
    const t = build();
    await t.image();
    await t.text('library');
    await t.image('Caption punchline');
    assert.equal(t.doc.reactionLibraryId, null);
    assert.equal(t.doc.state, 'AWAITING_APPROVAL', 'the caption was the punchline, so it generated');
  });
});

describe('WhatsApp: the "which frame?" question', () => {
  before(() => {
    setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any));
    if (!fs.existsSync(STACK)) {
      makeStack(STACK);
      makeStack(BIG_STACK, 1440);
      makeSingle(SINGLE);
    }
  });
  after(() => {
    setConfigForTests(null);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('asks about a stacked picture from the library, with a picture of the choices and a tap-list', async () => {
    const t = build({ pictureFor: { a1: STACK } });
    await t.image();
    await t.text('library');
    await t.text('1');
    await t.text('1');
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    assert.equal(t.doc.framingNext, 'viral');
    assert.ok(t.images.length >= 2, 'the sheet of choices was sent after the library sheet');
    assert.deepEqual(t.lists[0].rows.map(r => r.id), ['fr:split', 'fr:0', 'fr:1', 'fr:whole', 'fr:single']);
    assert.match(t.lists[0].body, /This picture has 2 frames/);
  });

  it('holds the punchline and the generation until the answer, and re-asks on an unclear one', async () => {
    const t = build({ pictureFor: { a1: STACK } });
    await t.image();
    await t.text('library'); await t.text('1'); await t.text('1');
    await t.text('Super line'); // not an answer
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    assert.equal(t.adaptCalls.length, 0, 'nothing is generated while the question is open');
    assert.match(t.last(), /did not get that/);
    await t.text('2'); // first frame only
    assert.deepEqual(t.doc.reactionFraming, { frame: 0 });
    assert.ok(t.sent.some(m => /Using \*the first frame only\*/.test(m)));
    assert.equal(t.doc.state, 'AWAITING_PUNCHLINE');
    await t.text('Super line');
    assert.equal(t.adaptCalls.length, 1);
    assert.deepEqual(t.adaptCalls[0].reactionFraming, { frame: 0 }, 'the choice reaches the meme');
  });

  it('warns that a small picture will look soft', async () => {
    const t = build({ pictureFor: { a1: STACK } });
    await t.image();
    await t.text('library'); await t.text('1'); await t.text('1');
    await t.text('first');
    assert.ok(t.sent.some(m => /only 480 px wide/.test(m)), 'a 480 px stack warns');

    const big = build({ pictureFor: { a1: BIG_STACK } });
    await big.image();
    await big.text('library'); await big.text('1'); await big.text('1');
    await big.text('first');
    assert.ok(!big.sent.some(m => /only \d+ px wide/.test(m)), 'a large stack does not');
  });

  it('takes a tapped list row as the answer', async () => {
    const t = build({ pictureFor: { a1: STACK } });
    await t.image();
    await t.text('library'); await t.text('1'); await t.text('1');
    await t.tap('fr:whole');
    assert.deepEqual(t.doc.reactionFraming, { fit: 'whole' });
    assert.equal(t.doc.state, 'AWAITING_PUNCHLINE');
    await t.tap('fr:0'); // a tap with no question open does nothing
    assert.deepEqual(t.doc.reactionFraming, { fit: 'whole' });
  });

  it('asks in plain text when a list cannot be sent', async () => {
    const t = build({ pictureFor: { a1: STACK }, listWorks: false });
    await t.image();
    await t.text('library'); await t.text('1'); await t.text('1');
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    assert.ok(t.sent.some(m => /1\. \*Both frames\*/.test(m) && /5\. \*One picture\*/.test(m)), 'the numbered question as text');
  });

  it('asks about a stacked picture sent by hand, and generates right after the answer when the caption was the punchline', async () => {
    const t = build();
    await t.image(); // reference
    t.nextPictures(STACK);
    await t.image('My caption punchline');
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    assert.equal(t.doc.punchline, 'My caption punchline');
    assert.equal(t.adaptCalls.length, 0);
    await t.text('both');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.deepEqual(t.adaptCalls[0].reactionFraming, { split: true });
  });

  it('never asks about an ordinary picture', async () => {
    const t = build();
    await t.image();
    t.nextPictures(SINGLE);
    await t.image();
    assert.equal(t.doc.state, 'AWAITING_PUNCHLINE');
    assert.equal(t.lists.length, 0);
  });

  it('a new picture replaces the question', async () => {
    const t = build();
    await t.image();
    t.nextPictures(STACK);
    await t.image();
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    t.nextPictures(SINGLE);
    await t.image();
    assert.equal(t.doc.state, 'AWAITING_PUNCHLINE');
    assert.equal(t.doc.reactionImagePath, SINGLE);
  });

  it('the manual flow asks too, and sends the choice to the engine', async () => {
    const t = build();
    for (const m of ['manual', 'skip', 'skip', 'skip']) await t.text(m);
    await t.image('Subject');
    await t.text('done');
    assert.equal(t.doc.state, 'MANUAL_REACTION');
    t.nextPictures(STACK);
    await t.image();
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    assert.equal(t.doc.framingNext, 'manual');
    await t.text('3'); // second frame only
    assert.equal(t.doc.state, 'MANUAL_PUNCHLINE');
    await t.text('Manual line');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.deepEqual(t.engineInput.design.reactionFraming, { frame: 1 });
    assert.equal(t.engineInput.content.punchline, 'Manual line');
  });

  it('the manual flow can use the library too', async () => {
    const t = build({ pictureFor: { b1: STACK } });
    for (const m of ['manual', 'skip', 'skip', 'skip']) await t.text(m);
    await t.image('Subject');
    await t.text('done');
    await t.text('library');
    await t.text('2'); // sad funny
    await t.text('1');
    assert.equal(t.doc.state, 'AWAITING_FRAMING');
    await t.text('whole');
    await t.text('Line');
    assert.deepEqual(t.engineInput.design.reactionFraming, { fit: 'whole' });
    assert.deepEqual(t.used, ['b1']);
  });

  it('Status shows the choice, and Reset forgets it', async () => {
    const t = build({ pictureFor: { a1: STACK } });
    await t.image();
    await t.text('library'); await t.text('1'); await t.text('1');
    await t.text('whole');
    await t.text('status');
    assert.match(t.last(), /from your library/);
    assert.match(t.last(), /Framing: the whole picture/);
    await t.text('reset');
    assert.equal(t.doc.reactionFraming, null);
    assert.equal(t.doc.reactionLibraryId, null);
  });
});
