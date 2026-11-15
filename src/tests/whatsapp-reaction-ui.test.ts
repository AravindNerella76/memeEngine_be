/**
 * The WhatsApp side of the reaction library and the "which frame?" question: numbered sheets, the choices for a stacked
 * picture, reading answers typed in a chat, and the small-picture warning. No phone needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  SHEET_PAGE,
  describeFraming,
  folderListText,
  framingFromRow,
  framingOptions,
  framingQuestionText,
  parseFolderReply,
  parseFramingAnswer,
  renderFramingSheet,
  renderSheet,
  softWarning
} from '../services/whatsapp-reaction-ui';
import { analyzeReactionImage, ReactionAnalysis } from '../services/reaction-framing';

const stack = (frames: number): ReactionAnalysis => ({
  width: 480,
  height: 480,
  frames: Array.from({ length: frames }, (_, i) => ({ x: 0, y: (480 / frames) * i, width: 480, height: 480 / frames })),
  stacked: true,
  autoFocus: Array.from({ length: frames }, () => ({ x: 0.5, y: 0.5 }))
});

describe('the choices for a stacked picture', () => {
  it('are numbered the same way the question shows them', () => {
    const o = framingOptions(stack(2));
    assert.deepEqual(o.map(x => [x.n, x.id]), [[1, 'split'], [2, '0'], [3, '1'], [4, 'whole'], [5, 'single']]);
    assert.deepEqual(o[1].framing, { frame: 0 });
    assert.deepEqual(o[3].framing, { fit: 'whole' });
    assert.deepEqual(o[4].framing, { split: false });
    assert.equal(framingOptions(stack(3)).length, 6, 'a third frame adds a choice');
  });

  it('the question lists every choice with its number', () => {
    const a = stack(2);
    const text = framingQuestionText(a, framingOptions(a));
    for (const t of ['2 frames', '1. *Both frames*', '2. *First frame*', '3. *Second frame*', '4. *Whole picture*', '5. *One picture*', 'Reply with a number']) assert.ok(text.includes(t), t);
  });

  it('reads numbers and everyday words', () => {
    const o = framingOptions(stack(2));
    const pick = (t: string) => parseFramingAnswer(t, o)?.id ?? null;
    assert.equal(pick('1'), 'split');
    assert.equal(pick('2'), '0');
    assert.equal(pick('3'), '1');
    assert.equal(pick('4'), 'whole');
    assert.equal(pick('5'), 'single');
    for (const t of ['both', 'Both', 'side by side', 'auto']) assert.equal(pick(t), 'split', t);
    for (const t of ['first', 'top', '1st', 'First frame', 'frame 1', 'only 1']) assert.equal(pick(t), '0', t);
    for (const t of ['second', 'bottom', '2nd', 'frame 2']) assert.equal(pick(t), '1', t);
    for (const t of ['whole', 'all', 'full', 'whole picture']) assert.equal(pick(t), 'whole', t);
    for (const t of ['one', 'single', 'cropped']) assert.equal(pick(t), 'single', t);
  });

  it('does not guess at anything else', () => {
    const o = framingOptions(stack(2));
    for (const t of ['', '  ', '9', '0', 'hello', 'approve', 'ఇది నా పంచ్‌లైన్!', 'third', 'frame 3']) assert.equal(parseFramingAnswer(t, o), null, JSON.stringify(t));
  });

  it('knows a third frame only when there is one', () => {
    assert.equal(parseFramingAnswer('third', framingOptions(stack(3)))?.id, '2');
  });

  it('reads a tapped list row', () => {
    const o = framingOptions(stack(2));
    assert.equal(framingFromRow('fr:whole', o)?.framing.fit, 'whole');
    assert.equal(framingFromRow('fr:1', o)?.framing.frame, 1);
    assert.equal(framingFromRow('fr:7', o), null);
    assert.equal(framingFromRow('whole', o), null);
  });

  it('describes a choice in words', () => {
    assert.equal(describeFraming({ frame: 0 }), 'the first frame only');
    assert.equal(describeFraming({ frame: 1 }), 'the second frame only');
    assert.equal(describeFraming({ fit: 'whole' }), 'the whole picture');
    assert.equal(describeFraming({ split: false }), 'one picture (cropped)');
    assert.equal(describeFraming({ split: true }), 'both frames side by side');
  });
});

describe('the small-picture warning', () => {
  it('appears for a small picture and says how soft it will be', () => {
    const w = softWarning(stack(2), { frame: 0 });
    assert.ok(w && /480 px wide/.test(w) && /larger/.test(w));
  });
  it('stays quiet for a large picture', () => {
    const big: ReactionAnalysis = { ...stack(2), width: 2160, height: 2160, frames: [{ x: 0, y: 0, width: 2160, height: 1080 }, { x: 0, y: 1080, width: 2160, height: 1080 }] };
    assert.equal(softWarning(big, { frame: 0 }), null);
  });
  it('is quiet when the whole picture is shown small but sharp', () => {
    assert.equal(softWarning(stack(2), { fit: 'whole' }), null, 'a 480 px picture shown 567 px tall is barely enlarged');
  });
});

describe('numbered picture sheets', () => {
  const photo = async (hue: number) => {
    const c = createCanvas(320, 240);
    const g = c.getContext('2d');
    g.fillStyle = `hsl(${hue}, 60%, 45%)`;
    g.fillRect(0, 0, 320, 240);
    return c.toBuffer('image/jpeg', 80);
  };

  it('draws a JPEG with every picture, the title and a number badge', async () => {
    const tiles = await Promise.all(Array.from({ length: SHEET_PAGE }, async (_, i) => ({ image: await photo(i * 28), label: `pic ${i + 1}` })));
    const buf = await renderSheet(tiles, { title: 'Shocking', subtitle: '16 pictures · page 1 of 2' });
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8, 'a JPEG');
    const img = await loadImage(buf);
    assert.equal(img.width, 4 * 300 + 5 * 10, '4 columns');
    assert.equal(img.height, 58 + 3 * 225 + 4 * 10, 'a header and 3 rows');
    assert.ok(buf.length < 400 * 1024, `small enough to send quickly (${Math.round(buf.length / 1024)} KB)`);
  });

  it('works with a single picture, and survives a picture that cannot be read', async () => {
    const one = await renderSheet([{ image: await photo(10) }], { title: 'One' });
    assert.ok((await loadImage(one)).width < 400);
    const broken = await renderSheet([{ image: Buffer.alloc(0) }, { image: await photo(200) }], { title: 'Broken' });
    assert.ok(broken.length > 1000);
  });

  it('draws every choice of a stacked picture on one sheet', async () => {
    const c = createCanvas(480, 480);
    const g = c.getContext('2d');
    g.fillStyle = '#2a5d8f';
    g.fillRect(0, 0, 480, 236);
    g.fillStyle = '#050505';
    g.fillRect(0, 236, 480, 8);
    g.fillStyle = '#8f4a2a';
    g.fillRect(0, 244, 480, 236);
    const img = await loadImage(c.toBuffer('image/png'));
    const a = analyzeReactionImage(img);
    const options = framingOptions(a.stacked ? a : stack(2));
    const sheet = await renderFramingSheet(img, a.stacked ? a : stack(2), options);
    assert.equal(sheet[0], 0xff);
    assert.ok((await loadImage(sheet)).width > 800);
  });
});

describe('the library in a chat', () => {
  const folders = [{ category: 'shocking', count: 16 }, { category: 'sad funny', count: 5 }];

  it('lists folders with counts, numbered from 1, and offers recently used as 0', () => {
    const t = folderListText(folders, 21, 3);
    for (const x of ['21 pictures', '0. ⭐ *Recently used* (3)', '1. Shocking (16)', '2. Sad funny (5)', 'search']) assert.ok(t.includes(x), x);
    assert.ok(!folderListText(folders, 21, 0).includes('Recently used'));
  });

  it('reads a reply as a number, a name, "recent" or search words', () => {
    assert.deepEqual(parseFolderReply('1', folders, true), { kind: 'folder', category: 'shocking' });
    assert.deepEqual(parseFolderReply('2', folders, false), { kind: 'folder', category: 'sad funny' });
    assert.deepEqual(parseFolderReply('0', folders, true), { kind: 'recent' });
    assert.deepEqual(parseFolderReply('recent', folders, true), { kind: 'recent' });
    assert.deepEqual(parseFolderReply('Sad Funny', folders, false), { kind: 'folder', category: 'sad funny' });
    assert.deepEqual(parseFolderReply('brahmanandam', folders, false), { kind: 'search', words: 'brahmanandam' });
    assert.deepEqual(parseFolderReply('9', folders, false), { kind: 'search', words: '9' }, 'a number with no folder is a search');
    assert.deepEqual(parseFolderReply('0', folders, false), { kind: 'search', words: '0' }, '0 means recent only when there is a recent list');
  });
});
