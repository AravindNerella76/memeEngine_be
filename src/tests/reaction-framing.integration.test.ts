/**
 * INTEGRATION (scratch MongoDB only; skipped unless MONGO_TEST_URI is set): a stacked reaction picture is shown side by
 * side in a real render, the owner's framing choice changes it, it survives regeneration, and an ordinary picture renders
 * exactly as it always did.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27999/meme_test npm run test:integration
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { Logger } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Meme, MemeSchema } from '../schemas/meme.schema';
import { MemeEngineService } from '../services/meme-engine.service';
import { LayoutEngineService } from '../services/layout-engine.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { RegenerationService } from '../services/regeneration.service';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { loadConfig } from '../config/app-config';
import { TEST_ASSETS_ROOT } from '../security/path-guard';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';
const STACK_FILE = 'tmp_stacked_reaction.png';

describe('reaction framing in a real render (integration)', { skip }, () => {
  let engine: MemeEngineService;
  const created: string[] = [];
  const ta = (f: string) => path.join(TEST_ASSETS_ROOT, f);
  const asset = (f: string, i: number) => ({ id: `t${i}`, originalName: f, filename: f, path: ta(f), mimeType: 'image/png', role: (i === 99 ? 'reaction_punchline' : 'subject_item') as any, orderIndex: i, aspectRatio: undefined as number | undefined });

  /** Two stacked "frames" of a real photo, one above the other: a square reaction picture like the owner's. */
  const makeStack = async () => {
    const photo = await loadImage(fs.readFileSync(ta('movie_reaction.jpg')));
    const c = createCanvas(480, 480);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 480, 480);
    g.drawImage(photo, 0, 0, 480, 236);
    g.drawImage(photo, 0, 244, 480, 236); // a thin black divider between
    // make the two frames differ, like two different shots
    g.fillStyle = 'rgba(0, 60, 160, 0.35)';
    g.fillRect(0, 244, 480, 236);
    fs.writeFileSync(ta(STACK_FILE), c.toBuffer('image/png'));
  };

  const make = async (reaction: string, design?: any) => {
    const m = await engine.generateMeme({
      content: { topic: 'framing', headline: 'FRAMING TEST', punchline: 'ఇది నా పంచ్‌లైన్!' },
      assets: { subjectImages: [asset('movie_subject1.jpg', 0), asset('movie_subject2.jpg', 1)], reactionImage: asset(reaction, 99) },
      layout: { memeType: 'movie_update' },
      ...(design ? { design } : {})
    } as any);
    created.push(m.memeId);
    return m;
  };
  const png = (m: any) => fs.readFileSync(m.outputPaths.png);

  before(async () => {
    Logger.overrideLogger(false);
    await mongoose.connect(URI as string);
    const model = mongoose.models[Meme.name] || mongoose.model(Meme.name, MemeSchema);
    const offline = new VisionCliRunner().useConfig({ ...loadConfig({}).vision, cliPath: null });
    const renderer = new CanvasRendererService();
    renderer.registerFonts();
    engine = new MemeEngineService(model as any, new LayoutEngineService(), renderer, new RegenerationService(offline));
    engine.onModuleInit();
    await makeStack();
  });

  after(async () => {
    for (const id of created) await engine.deleteMeme(id).catch(() => undefined);
    fs.rmSync(ta(STACK_FILE), { force: true });
    await mongoose.disconnect();
  });

  it('shows a stacked reaction picture side by side, and "one picture" brings the old crop back', async () => {
    const auto = await make(STACK_FILE);
    const one = await make(STACK_FILE, { reactionFraming: { split: false } });
    assert.ok(!png(auto).equals(png(one)), 'the side-by-side render differs from the single crop');
    assert.deepEqual((one.design as any).reactionFraming, { split: false }, 'the choice is stored with the meme');
    assert.equal((auto.design as any).reactionFraming, undefined, 'no choice stored when automatic');
  });

  it('an ordinary single picture renders exactly as before (same bytes with and without the new setting)', async () => {
    const a = await make('movie_reaction.jpg');
    const b = await make('movie_reaction.jpg', { reactionFraming: { split: true } });
    assert.ok(png(a).equals(png(b)), 'split has nothing to split here, so nothing changes');
  });

  it('the owner\'s focus changes the framing', async () => {
    const left = await make(STACK_FILE, { reactionFraming: { focus: [{ x: 0.05, y: 0.5 }, { x: 0.05, y: 0.5 }] } });
    const right = await make(STACK_FILE, { reactionFraming: { focus: [{ x: 0.95, y: 0.5 }, { x: 0.95, y: 0.5 }] } });
    assert.ok(!png(left).equals(png(right)));
  });

  it('the choice survives regeneration', async () => {
    const m = await make(STACK_FILE, { reactionFraming: { split: false } });
    const v2 = await engine.regenerateWithInstruction(m.memeId, 'make the outline thicker');
    assert.equal(v2.currentVersion, 2);
    assert.deepEqual((v2.design as any).reactionFraming, { split: false });
  });

  it('rejects a malformed choice at the front door', async () => {
    const { validateReactionFraming } = await import('../security/request-validation');
    assert.throws(() => validateReactionFraming('{"split":"maybe"}'));
    assert.deepEqual(validateReactionFraming('{"split":false}'), { split: false });
  });
});
