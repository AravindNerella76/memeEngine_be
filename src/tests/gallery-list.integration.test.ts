/**
 * INTEGRATION (scratch MongoDB only; skipped unless MONGO_TEST_URI is set): the paged, lightweight gallery list.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27999/meme_test npm run test:integration
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { Logger } from '@nestjs/common';
import { Meme, MemeSchema } from '../schemas/meme.schema';
import { MemeEngineService } from '../services/meme-engine.service';
import { LayoutEngineService } from '../services/layout-engine.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { RegenerationService } from '../services/regeneration.service';
import { ThumbnailService } from '../services/thumbnail.service';
import { THUMB_WIDTHS } from '../security/request-validation';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { loadConfig } from '../config/app-config';
import { TEST_ASSETS_ROOT } from '../security/path-guard';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';

describe('paged gallery list (integration)', { skip }, () => {
  let engine: MemeEngineService;
  let thumbs: ThumbnailService;
  const created: string[] = [];
  const ta = (f: string) => path.join(TEST_ASSETS_ROOT, f);
  const asset = (f: string, i: number) => ({ id: `t${i}`, originalName: f, filename: f, path: ta(f), mimeType: 'image/jpeg', role: (i === 99 ? 'reaction_punchline' : 'subject_item') as any, orderIndex: i });
  const make = async (headline: string, memeType: 'movie_update' | 'comparison') => {
    const m = await engine.generateMeme({
      content: { topic: headline, headline, punchline: 'ఇది నా పంచ్‌లైన్!' },
      assets: { subjectImages: [asset('movie_subject1.jpg', 0), asset('movie_subject2.jpg', 1)], reactionImage: asset('movie_reaction.jpg', 99) },
      layout: { memeType }
    });
    created.push(m.memeId);
    return m;
  };

  before(async () => {
    Logger.overrideLogger(false);
    await mongoose.connect(URI as string);
    const model = mongoose.models[Meme.name] || mongoose.model(Meme.name, MemeSchema);
    const offline = new VisionCliRunner().useConfig({ ...loadConfig({}).vision, cliPath: null });
    const renderer = new CanvasRendererService();
    renderer.registerFonts();
    thumbs = new ThumbnailService();
    engine = new MemeEngineService(model as any, new LayoutEngineService(), renderer, new RegenerationService(offline), undefined, undefined, thumbs);
    engine.onModuleInit();
    for (let i = 1; i <= 5; i++) await make(`PAGINGTEST ${i}`, i % 2 ? 'movie_update' : 'comparison');
  });

  after(async () => {
    for (const id of created) await engine.deleteMeme(id).catch(() => undefined);
    await mongoose.disconnect();
  });

  it('pages cover every meme exactly once, newest first, and report the total', async () => {
    const seen: string[] = [];
    let skipN = 0;
    for (;;) {
      const page = await engine.listMemes({ search: 'PAGINGTEST', sort: 'newest', limit: 2, skip: skipN });
      assert.equal(page.total, 5);
      seen.push(...page.items.map(m => m.content.headline));
      if (!page.items.length) break;
      skipN += page.items.length;
    }
    assert.deepEqual(seen, ['PAGINGTEST 5', 'PAGINGTEST 4', 'PAGINGTEST 3', 'PAGINGTEST 2', 'PAGINGTEST 1']);
    assert.equal(new Set(seen).size, 5, 'no repeats across pages');
  });

  it('makes the small copies right after a meme is saved, so the first gallery view finds them ready', async () => {
    const m = await make('PAGINGTEST THUMBS', 'comparison');
    const wanted = THUMB_WIDTHS.map(w => thumbs.thumbPath(`${m.memeId}_v1`, w));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !wanted.every(f => fs.existsSync(f))) await new Promise(r => setTimeout(r, 100));
    for (const f of wanted) assert.ok(fs.existsSync(f), `missing ${path.basename(f)}`);
    assert.ok(fs.statSync(wanted[2]).size < 150 * 1024, 'a 480 px copy is small');
    await engine.deleteMeme(m.memeId);
    thumbs.removeForMeme(m.memeId);
  });

  it('oldest-first reverses the order', async () => {
    const page = await engine.listMemes({ search: 'PAGINGTEST', sort: 'oldest', limit: 3, skip: 0 });
    assert.deepEqual(page.items.map(m => m.content.headline), ['PAGINGTEST 1', 'PAGINGTEST 2', 'PAGINGTEST 3']);
  });

  it('keeps the type and search filters', async () => {
    const cmp = await engine.listMemes({ search: 'PAGINGTEST', type: 'comparison', limit: 24, skip: 0 });
    assert.equal(cmp.total, 2);
    assert.ok(cmp.items.every(m => m.layout.memeType === 'comparison'));
    assert.equal((await engine.listMemes({ search: 'PAGINGTEST 3', limit: 24, skip: 0 })).total, 1);
    assert.equal((await engine.listMemes({ search: 'no-such-meme-xyz', limit: 24, skip: 0 })).items.length, 0);
  });

  it('returns only what a card needs, flagged as lightweight', async () => {
    const { items } = await engine.listMemes({ search: 'PAGINGTEST 1', limit: 1, skip: 0 });
    const m = items[0];
    assert.equal(m.lite, true);
    assert.equal(m.versionCount, 1);
    assert.equal(m.currentVersion, 1);
    assert.ok(m.memeId && m.createdAt && m.outputUrls?.jpeg && m.outputUrls?.png);
    for (const heavy of ['versions', 'assets', 'design', 'generationReport', 'outputPaths', '_id', '__v']) assert.equal((m as any)[heavy], undefined, `${heavy} is not sent`);
    const full = JSON.stringify(await engine.getMemeById(m.memeId));
    assert.ok(JSON.stringify(m).length < full.length / 3, 'much smaller than the full record');
  });

  it('resolves the image of a version for thumbnails, and nothing for unknown memes', async () => {
    const { items } = await engine.listMemes({ search: 'PAGINGTEST 1', limit: 1, skip: 0 });
    const out = await engine.resolveOutputFile(items[0].memeId);
    assert.ok(out && out.version === 1 && /\.jpe?g$/.test(out.path));
    assert.equal(await engine.resolveOutputFile('00000000-0000-4000-8000-000000000000'), null);
    assert.equal(await engine.resolveOutputFile(items[0].memeId, 99), null);
  });
});
