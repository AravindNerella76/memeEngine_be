/**
 * Three small things the WhatsApp buttons and the manual form rely on, tested offline with a fake meme store:
 *  - the Instagram caption (one builder for WhatsApp and the studio),
 *  - changing the punchline of a stored meme (the owner's own words, as the next version),
 *  - a real preview of a meme being built by hand (rendered in memory, nothing saved).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { buildCaption, DEFAULT_HASHTAGS, FOLLOW_LINE, MAX_CAPTION } from '../services/instagram-caption';
import { MemeEngineService } from '../services/meme-engine.service';
import { LayoutEngineService } from '../services/layout-engine.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { RegenerationService } from '../services/regeneration.service';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { loadConfig, setConfigForTests } from '../config/app-config';
import { OUTPUT_ROOT, TEST_ASSETS_ROOT } from '../security/path-guard';

describe('Instagram caption', () => {
  it('is the punchline, then the headline, the topic, the follow line and the hashtags', () => {
    const c = buildCaption({ punchline: 'Punch', headline: 'HEAD', topic: 'Topic' });
    assert.equal(c, `Punch\n\nHEAD\n\n📌 Topic\n\n${FOLLOW_LINE}\n\n${DEFAULT_HASHTAGS.join(' ')}`);
  });
  it('does not repeat a headline or topic that equals what is already there', () => {
    const c = buildCaption({ punchline: 'Same', headline: 'Same', topic: 'Same' });
    assert.equal(c.split('Same').length - 1, 1);
  });
  it('keeps the owner\'s Telugu exactly and never exceeds Instagram\'s limit', () => {
    assert.ok(buildCaption({ punchline: 'ఇది నా సొంత పంచ్‌లైన్!' }).startsWith('ఇది నా సొంత పంచ్‌లైన్!'));
    const long = buildCaption({ punchline: 'x'.repeat(5000) });
    assert.ok(long.length <= MAX_CAPTION);
    const nearly = buildCaption({ punchline: 'y'.repeat(2100) });
    assert.ok(nearly.length <= MAX_CAPTION && nearly.startsWith('yyyy'), 'the hashtags go first, not the words');
  });
  it('copes with a meme that has no content at all', () => {
    assert.ok(buildCaption(undefined).includes(FOLLOW_LINE));
  });
});

describe('engine: change the punchline / preview a manual meme', () => {
  const asset = (f: string, i: number) => ({ id: `t${i}`, originalName: f, filename: f, path: path.join(TEST_ASSETS_ROOT, f), mimeType: 'image/jpeg', role: (i === 99 ? 'reaction_punchline' : 'subject_item') as any, orderIndex: i, label: i === 99 ? undefined : `LABEL ${i + 1}` });
  const assets = () => ({ subjectImages: [0, 1, 2].map(i => asset(['compare_col1.jpg', 'compare_col2.jpg', 'compare_col3.jpg'][i], i)), reactionImage: asset('compare_reaction.jpg', 99) });
  const written: string[] = [];
  let engine: MemeEngineService;
  let doc: any;
  let saves = 0;

  before(() => {
    setConfigForTests(loadConfig({}));
    const offline = new VisionCliRunner().useConfig({ ...loadConfig({}).vision, cliPath: null });
    const renderer = new CanvasRendererService();
    renderer.registerFonts();
    const model: any = { findOne: (q: { memeId: string }) => ({ exec: async () => (doc && doc.memeId === q.memeId ? doc : null) }) };
    engine = new MemeEngineService(model, new LayoutEngineService(), renderer, new RegenerationService(offline));
    doc = {
      memeId: 'punch-test',
      currentVersion: 1,
      content: { topic: 't', headline: 'NET WORTH OF CHIEF MINISTERS', punchline: 'Old line', reactionContext: '* TELUGU PEOPLE' },
      design: {},
      layout: { memeType: 'comparison' },
      assets: assets(),
      outputPaths: {},
      outputUrls: {},
      versions: [{ versionNumber: 1, instruction: 'Initial Generation', content: { punchline: 'Old line' } }],
      toObject() { return JSON.parse(JSON.stringify({ ...this, toObject: undefined, save: undefined })); },
      async save() { saves++; return this; }
    };
  });
  after(() => {
    setConfigForTests(null);
    for (const f of fs.readdirSync(OUTPUT_ROOT)) if (f.startsWith('meme_punch-test_')) fs.rmSync(path.join(OUTPUT_ROOT, f), { force: true });
    written.forEach(f => fs.rmSync(f, { force: true }));
  });

  it('re-renders with the owner\'s new words as the next version, and leaves everything else alone', async () => {
    const before = JSON.parse(JSON.stringify({ assets: doc.assets, layout: doc.layout, design: doc.design, v1: doc.versions[0] }));
    const updated: any = await engine.changePunchline('punch-test', '  సూపర్ సార్ మీరు  ');
    assert.equal(updated.currentVersion, 2);
    assert.equal(updated.content.punchline, 'సూపర్ సార్ మీరు', 'only the surrounding spaces were removed');
    assert.equal(updated.content.headline, 'NET WORTH OF CHIEF MINISTERS');
    assert.equal(updated.versions.length, 2);
    assert.equal(updated.versions[1].interpreter, 'punchline_edit');
    assert.equal(updated.versions[1].content.punchline, 'సూపర్ సార్ మీరు');
    assert.deepEqual(updated.versions[0], before.v1, 'version 1 is untouched');
    assert.deepEqual(JSON.parse(JSON.stringify(updated.layout)), before.layout);
    assert.deepEqual(JSON.parse(JSON.stringify(updated.design)), before.design);
    assert.equal(updated.assets.subjectImages.length, 3);
    assert.ok(fs.existsSync(updated.outputPaths.jpeg) && /_v2\.jpeg$/.test(updated.outputPaths.jpeg), 'a new picture was written for version 2');
    assert.equal(saves, 1);
  });

  it('refuses an empty, an over-long or an unchanged punchline, and an unknown meme', async () => {
    await assert.rejects(() => engine.changePunchline('punch-test', '   '), BadRequestException);
    await assert.rejects(() => engine.changePunchline('punch-test', 'x'.repeat(1001)), BadRequestException);
    await assert.rejects(() => engine.changePunchline('punch-test', 5 as any), BadRequestException);
    await assert.rejects(() => engine.changePunchline('punch-test', 'సూపర్ సార్ మీరు'), UnprocessableEntityException);
    await assert.rejects(() => engine.changePunchline('nope', 'anything'), /not found/);
  });

  it('two changes at once: one wins, the other is told to wait', async () => {
    const results = await Promise.allSettled([engine.changePunchline('punch-test', 'First at once'), engine.changePunchline('punch-test', 'Second at once')]);
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ConflictException);
  });

  it('previews a manual meme in memory: a real picture, and nothing saved anywhere', async () => {
    const filesBefore = fs.readdirSync(OUTPUT_ROOT).sort();
    const savesBefore = saves;
    const r = await engine.previewManual({
      content: { topic: 'preview', headline: 'PREVIEW HEADLINE', punchline: 'ప్రివ్యూ లైన్', itemLabels: ['A', 'B', 'C'] },
      assets: assets(),
      design: { canvasPreset: 'portrait_4_5' } as any,
      layout: { memeType: 'comparison' }
    });
    assert.match(r.image, /^data:image\/jpeg;base64,/);
    assert.deepEqual([r.width, r.height], [1080, 1350]);
    assert.ok(Buffer.from(r.image.split(',')[1], 'base64').length > 20_000, 'a real render, not a placeholder');
    assert.deepEqual(fs.readdirSync(OUTPUT_ROOT).sort(), filesBefore, 'no file was written');
    assert.equal(saves, savesBefore, 'no record was saved');
  });

  it('a preview follows the canvas size the owner chose', async () => {
    const square = await engine.previewManual({
      content: { topic: 'p', punchline: 'line' },
      assets: assets(),
      design: { canvasPreset: 'square_1_1' } as any,
      layout: { memeType: 'comparison' }
    });
    assert.deepEqual([square.width, square.height], [1080, 1080]);
  });

  it('renders 2-line punchline with larger second line and positioned down on reaction image', async () => {
    const twoLines = await engine.previewManual({
      content: { topic: 'test', headline: 'HEAD', punchline: 'MALLI NOVEMBER EH\nMALLI NOVEMBER EH' },
      assets: assets(),
      design: { canvasPreset: 'portrait_4_5' } as any,
      layout: { memeType: 'comparison' }
    });
    assert.deepEqual([twoLines.width, twoLines.height], [1080, 1350]);
    assert.match(twoLines.image, /^data:image\/jpeg;base64,/);
  });
});
