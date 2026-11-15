/**
 * Offline tests for the layout library (saved meme layouts) and its WhatsApp flows.
 * Layout only: fonts and colours are never stored (they come from Settings).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FormatLibraryService, cleanFormatName } from '../services/format-library.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { FormatController } from '../controllers/format.controller';
import { createCanvas } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, setConfigForTests } from '../config/app-config';

/** Minimal analysed reference with the given number of image slots per row. */
function analysis(cols: number[], o: { header?: boolean; reaction?: boolean; statement?: string | null } = {}): any {
  const slots: any[] = [];
  let idx = 0;
  cols.forEach((c, row) => {
    for (let col = 0; col < c; col++) {
      slots.push({ slotId: `s${idx + 1}`, index: idx++, row, column: col, bbox: { x: col / c, y: row / cols.length, width: 1 / c, height: 1 / cols.length } });
    }
  });
  return {
    memeFormat: 'other',
    legacyMemeType: 'custom',
    header: { present: o.header ?? true, text: null, heightFraction: 0.12 },
    overlayText: { statement: o.statement ?? null, bulletPoints: [], attribution: null },
    grid: { rows: cols.length, columnsPerRow: cols, rowHeightFractions: cols.map(() => 1 / cols.length) },
    slots,
    reactionPanel: { present: o.reaction ?? true, heightFraction: 0.4 }
  };
}

/** In-memory stand-in for the Mongoose model (just the calls the service makes). */
function fakeModel() {
  const docs: any[] = [];
  let t = 0;
  const decorate = (d: any) => {
    Object.defineProperty(d, 'save', { value: async () => d, enumerable: false, configurable: true });
    Object.defineProperty(d, 'toObject', { value: () => ({ ...d }), enumerable: false, configurable: true });
    return d;
  };
  const find = (q: any) => docs.find(d => Object.entries(q).every(([k, v]) => d[k] === v)) || null;
  const lean = (v: any) => ({ lean: () => ({ exec: async () => (Array.isArray(v) ? v.map(x => ({ ...x })) : v ? { ...v } : null) }), exec: async () => (v ? decorate(v) : null) });
  return {
    docs,
    find: () => ({ sort: () => lean([...docs].sort((a, b) => a.createdAt - b.createdAt)) }),
    findOne: (q: any) => lean(find(q)),
    estimatedDocumentCount: async () => docs.length,
    create: async (d: any) => {
      const rec = { ...d, createdAt: ++t };
      docs.push(rec);
      return decorate(rec);
    },
    findOneAndUpdate: (q: any, upd: any) => {
      const rec = find(q);
      if (rec) Object.assign(rec, upd.$set);
      return lean(rec);
    },
    findOneAndDelete: (q: any) => {
      const rec = find(q);
      if (rec) docs.splice(docs.indexOf(rec), 1);
      return lean(rec);
    },
    updateOne: (q: any, upd: any) => {
      const rec = find(q);
      if (rec) {
        rec.usageCount = (rec.usageCount || 0) + (upd.$inc?.usageCount || 0);
        Object.assign(rec, upd.$set || {});
      }
      return { exec: async () => ({}) };
    }
  };
}

describe('layout signature and description', () => {
  it('tells structures apart and describes them in plain words', () => {
    const three = analysis([3]);
    const twoOne = analysis([2, 1]);
    assert.notEqual(FormatLibraryService.signatureOf(three), FormatLibraryService.signatureOf(twoOne));
    assert.notEqual(FormatLibraryService.signatureOf(three), FormatLibraryService.signatureOf(analysis([3], { header: false })));
    assert.equal(FormatLibraryService.signatureOf(three), FormatLibraryService.signatureOf(analysis([3])), 'same structure, same signature');

    const d = (a: any) => FormatLibraryService.describe({ slotCount: a.slots.length, rows: a.grid.columnsPerRow, hasHeader: a.header.present, hasStatement: Boolean(a.overlayText.statement), hasReactionPanel: a.reactionPanel.present });
    assert.equal(d(three), '3 images side by side · header · reaction panel');
    assert.equal(d(twoOne), '3 images (2 + 1) · header · reaction panel');
    assert.equal(d(analysis([1, 1], { header: false, reaction: false })), '2 images stacked');
  });

  it('cleans names', () => {
    assert.equal(cleanFormatName('  My   layout \n'), 'My layout');
    assert.equal(cleanFormatName('x'.repeat(100))?.length, 60);
    assert.equal(cleanFormatName('   '), null);
    assert.equal(cleanFormatName(42 as any), null);
  });
});

describe('FormatLibraryService', () => {
  it('saves a new structure once, counts repeats and keeps a given name', async () => {
    const model: any = fakeModel();
    const lib = new FormatLibraryService(model);
    const first = await lib.saveFromAnalysis(analysis([2, 1]), { source: 'viral_auto' });
    assert.equal(first.created, true);
    assert.equal(first.format.name, null);
    assert.deepEqual(first.format.rows, [2, 1]);
    assert.ok(first.format.grid, 'non-standard structure keeps its grid');

    const again = await lib.saveFromAnalysis(analysis([2, 1]), { source: 'whatsapp', name: 'Facts trio' });
    assert.equal(again.created, false);
    assert.equal(model.docs.length, 1);
    assert.equal(again.format.name, 'Facts trio', 'the first name given to an unnamed layout is kept');
    assert.equal(model.docs[0].usageCount, 2);

    await lib.saveFromAnalysis(analysis([3]), { source: 'viral_auto' });
    const list = await lib.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].displayName, 'Facts trio');
    assert.match(list[1].displayName, /^Unnamed layout 2/);
    assert.equal((await lib.getByPosition(2))?.slotCount, 3);
    assert.equal(await lib.getByPosition(9), null);
  });

  it('refuses an example without image slots, renames and deletes', async () => {
    const lib = new FormatLibraryService(fakeModel() as any);
    await assert.rejects(() => lib.saveFromAnalysis(analysis([]), { source: 'api' }), /No image slots/);
    const { format } = await lib.saveFromAnalysis(analysis([1]), { source: 'api' });
    assert.equal((await lib.rename(format.formatId, '  Hero shot ')).name, 'Hero shot');
    await assert.rejects(() => lib.rename(format.formatId, '   '), /name/i);
    assert.deepEqual(await lib.remove(format.formatId), { deleted: true });
    await assert.rejects(() => lib.remove(format.formatId), /not found/i);
  });

  it('builds a layout request from a saved layout (grid, proportions), without any styling', () => {
    const saved: any = { memeType: 'custom', arrangement: 'custom_grid', grid: { rows: [{ heightWeight: 1, slots: [{ widthWeight: 1 }] }] }, hasHeader: true, headerHeightRatio: 0.14, reactionHeightRatio: 0.4 };
    const withHeadline = FormatLibraryService.layoutFor(saved, true);
    assert.equal(withHeadline.arrangement, 'custom_grid');
    assert.ok(withHeadline.grid);
    assert.equal(withHeadline.headerHeightRatio, 0.14);
    assert.equal(withHeadline.reactionHeightRatio, 0.4);
    assert.equal(FormatLibraryService.layoutFor(saved, false).headerHeightRatio, undefined, 'no header space without a headline');
    assert.equal(FormatLibraryService.layoutFor({ ...saved, headerHeightRatio: 0.05 }, true).headerHeightRatio, undefined, 'small header: Settings value applies');
    const keys = Object.keys(withHeadline);
    assert.ok(!keys.some(k => /font|color|colour/i.test(k)), 'layout only');
  });
});

describe('WhatsApp layout flows', () => {
  const PHONE = '911234567890';
  const last = (a: string[]) => a[a.length - 1];
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  function build() {
    const sent: string[] = [];
    const doc: any = { phoneNumber: PHONE, state: 'IDLE', mode: 'viral', manualSubjects: [], async save() { return this; } };
    const model: any = {
      findOne: async () => doc,
      create: async () => doc,
      findOneAndUpdate: async (_q: any, upd: any) => (doc.manualSubjects.push(upd.$push.manualSubjects), doc)
    };
    const formatModel: any = fakeModel();
    const formats = new FormatLibraryService(formatModel);
    let engineInput: any = null;
    const engine: any = { generateMeme: async (i: any) => ((engineInput = i), { memeId: 'm1', outputUrls: { jpeg: '/output/m1.jpeg' }, content: i.content }) };
    const viral: any = { analyzeForFormat: async () => analysis([2, 1]) };
    const svc: any = new WhatsAppService(model, viral, {} as any, engine, {} as any, formats);
    svc.sendTextMessage = async (_t: string, m: string) => (sent.push(m), true);
    svc.sendImageMessage = async (_t: string, _u: string, c?: string) => (sent.push('[image] ' + c), true);
    let n = 0;
    svc.downloadMedia = async () => ({ filePath: `/x/wa_${++n}.jpg`, filename: `wa_${n}.jpg`, mimeType: 'image/jpeg', width: 3000, height: 2000, convertedFrom: 'none' });
    const text = (body: string) => svc.handleUserMessage(PHONE, { type: 'text', text: { body } });
    const image = (caption = '') => svc.handleUserMessage(PHONE, { type: 'document', document: { id: '1', caption } });
    return { svc, sent, doc, text, image, formats, formatModel, get engineInput() { return engineInput; } };
  }

  it('learns a layout from an example, asks for a name, and lists it', async () => {
    const t = build();
    await t.text('layouts');
    assert.ok(last(t.sent).includes('No saved layouts yet'));

    await t.text('new layout');
    assert.equal(t.doc.state, 'LAYOUT_EXAMPLE');
    await t.image('');
    assert.equal(t.doc.state, 'LAYOUT_NAME');
    assert.ok(last(t.sent).includes('3 images (2 + 1)') && last(t.sent).includes('What should I call it'));
    await t.text('Facts trio');
    assert.equal(t.doc.state, 'IDLE');
    assert.equal(t.formatModel.docs[0].name, 'Facts trio');
    assert.equal(t.formatModel.docs[0].source, 'whatsapp');

    await t.text('layouts');
    assert.ok(last(t.sent).includes('1. *Facts trio* — 3 images (2 + 1)'));
  });

  it('a caption names the layout immediately, and a known structure is not saved twice', async () => {
    const t = build();
    await t.text('new layout');
    await t.image('Brahmi trio');
    assert.equal(t.doc.state, 'IDLE');
    assert.equal(t.formatModel.docs[0].name, 'Brahmi trio');
    await t.text('new layout');
    await t.image('');
    assert.equal(t.formatModel.docs.length, 1);
    assert.ok(last(t.sent).includes('already saved as *Brahmi trio*'));
  });

  it('renames and deletes by number, and ordinary text is not mistaken for a command mid-flow', async () => {
    const t = build();
    await t.formats.saveFromAnalysis(analysis([3]), { source: 'viral_auto' });
    await t.text('name 1 Three across');
    assert.equal(t.formatModel.docs[0].name, 'Three across');
    await t.text('delete layout 5');
    assert.ok(last(t.sent).includes('do not have layout 5'));
    await t.text('delete layout 1');
    assert.equal(t.formatModel.docs.length, 0);

    // while the manual flow waits for a headline, "name 2 things" is a headline, not a command
    await t.text('manual');
    await t.text('skip');
    await t.text('name 2 things');
    assert.equal(t.doc.manualHeadline, 'name 2 things');
  });

  it('manual mode offers saved layouts, asks only what they need, and renders with their grid', async () => {
    const t = build();
    await t.formats.saveFromAnalysis(analysis([2, 1], { header: false }), { source: 'whatsapp', name: 'Trio' });
    await t.text('manual');
    const menu = last(t.sent);
    assert.ok(menu.includes('Your saved layouts') && menu.includes('6. *Trio*'), menu);

    await t.text('7');                                        // no such layout
    assert.equal(t.doc.state, 'MANUAL_TYPE');
    assert.ok(last(t.sent).includes('1 to 6'));

    await t.text('6');
    assert.equal(t.doc.manualSlotCount, 3);
    assert.equal(t.doc.state, 'MANUAL_SUBJECTS', 'layout without header/statement goes straight to the images');
    await t.text('done');
    assert.ok(last(t.sent).includes('at least one'));
    await t.image('A');
    await t.text('done');
    assert.ok(last(t.sent).includes('needs *3* images and I have 1'));
    await t.image('B');
    assert.equal(t.doc.state, 'MANUAL_SUBJECTS');
    await t.image('C');
    assert.equal(t.doc.state, 'MANUAL_REACTION', 'continues by itself after the last image');
    await t.image('Punch line');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');

    const input = t.engineInput;
    assert.equal(input.assets.subjectImages.length, 3);
    assert.equal(input.layout.arrangement, 'custom_grid');
    assert.ok(input.layout.grid, 'grid of the saved layout is used');
    assert.equal(input.content.headline, undefined);
    assert.equal(t.formatModel.docs[0].usageCount, 2, 'use is counted');
  });

  it('built-in types still work unchanged next to saved layouts', async () => {
    const t = build();
    await t.formats.saveFromAnalysis(analysis([3]), { source: 'viral_auto' });
    await t.text('manual');
    await t.text('2');
    assert.equal(t.doc.manualFormatId, null);
    assert.equal(t.doc.manualMemeType, 'facts_collage');
    assert.equal(t.doc.state, 'MANUAL_HEADLINE');
    assert.equal(t.doc.manualSlotCount, null);
  });
});

describe('layout API (web app)', () => {
  function build() {
    const model: any = fakeModel();
    const formats = new FormatLibraryService(model);
    const viral: any = { analyzeForFormat: async () => analysis([2, 1]) };
    return { ctl: new FormatController(formats, viral), model };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upload = () => {
    const p = path.join(dir, `ex_${Math.random().toString(36).slice(2)}.jpg`);
    const c: any = createCanvas(400, 500);
    c.getContext('2d').fillRect(0, 0, 400, 500);
    fs.writeFileSync(p, c.toBuffer('image/jpeg', 80));
    return { image: [{ fieldname: 'image', originalname: 'ex.jpg', encoding: '7bit', mimetype: 'image/jpeg', size: fs.statSync(p).size, destination: dir, filename: path.basename(p), path: p }] };
  };

  it('learns a layout from an uploaded example, and does not save the same structure twice', async () => {
    const { ctl, model } = build();
    const first = await ctl.add(upload(), 'Facts trio');
    assert.equal(first.created, true);
    assert.equal(first.layout.name, 'Facts trio');
    assert.equal(first.layout.description, '3 images (2 + 1) · header · reaction panel');
    assert.equal(model.docs[0].source, 'api');
    const again = await ctl.add(upload(), undefined);
    assert.equal(again.created, false);
    assert.equal(model.docs.length, 1);
    assert.equal((await ctl.list()).formats.length, 1);
  });

  it('rejects a request without an image and bad ids', async () => {
    const { ctl } = build();
    await assert.rejects(() => ctl.add({} as any, 'x'), /example meme image/);
    await assert.rejects(() => ctl.rename('not-an-id', { name: 'x' }), /Invalid layout id/);
    await assert.rejects(() => ctl.remove('../../etc'), /Invalid layout id/);
  });

  it('renames and deletes through the API', async () => {
    const { ctl } = build();
    const { layout } = await ctl.add(upload(), undefined);
    assert.equal((await ctl.rename(layout.formatId, { name: ' Renamed ' })).name, 'Renamed');
    assert.deepEqual(await ctl.remove(layout.formatId), { deleted: true });
    assert.equal((await ctl.list()).formats.length, 0);
  });
});
