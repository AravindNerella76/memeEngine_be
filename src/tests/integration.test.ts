/**
 * INTEGRATION tests (need a scratch MongoDB). Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27999/meme_test npm run test:integration
 * Uses the repository test-assets as inputs and removes every meme it creates.
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
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { loadConfig } from '../config/app-config';
import { TEST_ASSETS_ROOT } from '../security/path-guard';
import { ProviderUsageRecord, ProviderUsageSchema, ProviderUsageService } from '../discovery/provider-usage';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';

describe('MemeEngineService with MongoDB (integration)', { skip }, () => {
  let engine: MemeEngineService;
  const created: string[] = [];
  const ta = (f: string) => path.join(TEST_ASSETS_ROOT, f);
  const asset = (f: string, i: number) => ({ id: `t${i}`, originalName: f, filename: f, path: ta(f), mimeType: 'image/jpeg', role: (i === 99 ? 'reaction_punchline' : 'subject_item') as any, orderIndex: i });

  before(async () => {
    Logger.overrideLogger(false);
    await mongoose.connect(URI as string);
    const model = mongoose.models[Meme.name] || mongoose.model(Meme.name, MemeSchema);
    const offlineRunner = new VisionCliRunner().useConfig({ ...loadConfig({}).vision, cliPath: null }); // AI unavailable -> keyword rules
    const renderer = new CanvasRendererService();
    renderer.registerFonts();
    engine = new MemeEngineService(model as any, new LayoutEngineService(), renderer, new RegenerationService(offlineRunner));
    engine.onModuleInit();
  });

  after(async () => {
    for (const id of created) await engine.deleteMeme(id).catch(() => undefined);
    await mongoose.disconnect();
  });

  const input = () => ({
    content: { topic: 'Integration test', headline: 'INTEGRATION TEST', punchline: 'ఇది నా పంచ్‌లైన్!' },
    assets: { subjectImages: [asset('movie_subject1.jpg', 0), asset('movie_subject2.jpg', 1)], reactionImage: asset('movie_reaction.jpg', 99) },
    layout: { memeType: 'movie_update' as const }
  });

  it('generates v1, keeps the punchline exactly, stores the version asset snapshot', async () => {
    const m = await engine.generateMeme(input());
    created.push(m.memeId);
    assert.equal(m.currentVersion, 1);
    assert.equal(m.content.punchline, 'ఇది నా పంచ్‌లైన్!');
    assert.ok((m.versions[0] as any).assets?.subjectImages?.length === 2);
    assert.ok(fs.existsSync(m.outputPaths.png));
  });

  it('persists the generation report, keeps it out of the gallery list, returns it on request', async () => {
    const m = await engine.generateMeme(input(), { pipeline: 'viral_adaptation_v2', generationReport: { version: 2, slots: [{ slotId: 's1', subject: 'X', alternates: [] }] } });
    created.push(m.memeId);
    const list = await engine.getAllMemes({});
    const listed = list.find((x: any) => x.memeId === m.memeId) as any;
    assert.ok(listed);
    assert.equal(listed.generationReport, undefined, 'list stays light');
    assert.equal(listed.pipeline, 'viral_adaptation_v2');
    const rep = await engine.getReport(m.memeId);
    assert.equal(rep.report.version, 2);
    assert.ok(rep.report.render?.textFit, 'render details are added to the report');
  });

  it('regenerate -> restore -> regenerate creates unique versions and never overwrites old outputs', async () => {
    const m = await engine.generateMeme(input());
    created.push(m.memeId);
    const v2 = await engine.regenerateWithInstruction(m.memeId, 'make the outline thicker');
    assert.equal(v2.currentVersion, 2);
    assert.equal((v2.versions[1] as any).interpreter, 'keyword');
    const v2Png = v2.outputPaths.png;
    const v2Bytes = fs.readFileSync(v2Png);
    await engine.restoreVersion(m.memeId, 1);
    const v3 = await engine.regenerateWithInstruction(m.memeId, 'change text colour to white');
    const nums = v3.versions.map(v => v.versionNumber);
    assert.deepEqual(nums, [1, 2, 3]);
    assert.ok(fs.readFileSync(v2Png).equals(v2Bytes), 'version 2 output untouched');
    assert.equal(v3.content.punchline, 'ఇది నా పంచ్‌లైన్!');
  });

  it('unsupported instructions are refused without creating a version', async () => {
    const m = await engine.generateMeme(input());
    created.push(m.memeId);
    await assert.rejects(() => engine.regenerateWithInstruction(m.memeId, 'please do something nice'), (e: any) => e.getStatus?.() === 422);
    const again = await engine.getMemeById(m.memeId);
    assert.equal(again.versions.length, 1);
  });

  it('delete removes every output file', async () => {
    const m = await engine.generateMeme(input());
    const v2 = await engine.regenerateWithInstruction(m.memeId, 'make the outline thicker');
    const outputs = v2.versions.flatMap(v => [v.outputPaths.png, v.outputPaths.jpeg]);
    await engine.deleteMeme(m.memeId);
    assert.ok(outputs.every(p => !fs.existsSync(p)));
    assert.ok(fs.existsSync(ta('movie_subject1.jpg')), 'repository test assets are never deleted');
  });
});

describe('ProviderUsageService with MongoDB (integration)', { skip }, () => {
  let service: ProviderUsageService;
  let model: mongoose.Model<any>;
  const provider = `test-provider-${Date.now()}`;

  before(async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connect(URI as string);
    model = (mongoose.models[ProviderUsageRecord.name] || mongoose.model(ProviderUsageRecord.name, ProviderUsageSchema)) as mongoose.Model<any>;
    service = new ProviderUsageService(model as any);
  });

  after(async () => {
    await model.deleteMany({ provider }).catch(() => undefined);
    await mongoose.disconnect();
  });

  it('never lets concurrent requests exceed the monthly cap, and survives a new service instance (restart)', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => service.consume(provider, 5)));
    assert.equal(results.filter(r => r.allowed).length, 5);
    assert.equal((await service.current(provider)).used, 5);
    const restarted = new ProviderUsageService(model as any);
    assert.equal((await restarted.consume(provider, 5)).allowed, false, 'the count is persisted');
    assert.equal((await restarted.consume(provider, 6)).allowed, true, 'a raised limit allows more');
    assert.equal(await model.countDocuments({ provider }), 1, 'one record per provider and month');
  });
});
