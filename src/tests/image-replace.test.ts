/**
 * Image replacement and user-chosen images.
 *  - offline: staging (validation, preview, expiry), request validation, asset records
 *  - integration (needs MONGO_TEST_URI, a scratch MongoDB): replace one/many images on a stored meme,
 *    versions, restore, unaffected parts stay identical, failures, persistence
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';
import { Logger } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Meme, MemeSchema } from '../schemas/meme.schema';
import { MemeEngineService } from '../services/meme-engine.service';
import { LayoutEngineService } from '../services/layout-engine.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { RegenerationService } from '../services/regeneration.service';
import { ImageSelectionService } from '../services/image-selection.service';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { loadConfig, setConfigForTests } from '../config/app-config';
import { TEST_ASSETS_ROOT } from '../security/path-guard';
import { validateViralOverrides } from '../security/request-validation';

let tmp: string;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function picture(name: string, w: number, h: number, seed: number, format: 'png' | 'jpeg' = 'png'): string {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(seed * 67) % 360}, 60%, 35%)`);
  g.addColorStop(1, `hsl(${(seed * 67 + 120) % 360}, 60%, 60%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `hsla(${(i * 47 + seed * 13) % 360}, 70%, 55%, 0.7)`;
    ctx.beginPath();
    ctx.arc(((i * 97 + seed * 31) % w), ((i * 61 + seed * 17) % h), 10 + ((i * 7) % 40), 0, Math.PI * 2);
    ctx.fill();
  }
  const p = path.join(tmp, name);
  fs.writeFileSync(p, format === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg'));
  return p;
}

/** A discovery stand-in: serves generated pictures for "online" URLs. */
function stubDiscovery(files: Record<string, Buffer>, search: any[] = []) {
  return {
    downloadForUser: async (url: string) => {
      if (!files[url]) throw new Error('HTTP 404');
      return files[url];
    },
    searchForUser: async () => ({ candidates: search, providers: ['stub'], errors: [] })
  } as any;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-test-'));
  setConfigForTests(loadConfig({}));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  setConfigForTests(null);
});

describe('staging a chosen picture (offline)', () => {
  it('accepts a real image, shows a preview and records it as the user\'s own, not AI-verified', async () => {
    const sel = new ImageSelectionService(stubDiscovery({}));
    const st = await sel.stageUpload(picture('ok.png', 640, 800, 1), 'my<b>pic</b>.png');
    const pub = sel.toPublic(st);
    assert.match(pub.thumbnail, /^data:image\/jpeg;base64,/);
    assert.equal(pub.aiVerified, false);
    assert.equal(pub.sourceType, 'user_upload');
    assert.ok(!/[<>]/.test(pub.originalName), 'display name is sanitised');
    const asset = sel.assetFor(st, { path: '/x/upload_a.png', filename: 'upload_a.png' }, { role: 'subject_secondary', orderIndex: 1, label: 'KEEP ME' }, true);
    assert.deepEqual({ t: asset.sourceType, by: asset.selectedBy, ai: asset.aiVerified, label: asset.label, role: asset.role, order: asset.orderIndex, rights: asset.rights, focal: asset.focalX }, { t: 'user_upload', by: 'user', ai: false, label: 'KEEP ME', role: 'subject_secondary', order: 1, rights: undefined, focal: undefined });
    assert.equal(asset.sha256, st.sha256);
  });

  it('rejects files that are not usable images', async () => {
    const sel = new ImageSelectionService(stubDiscovery({}));
    const bad = path.join(tmp, 'notimage.png');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from('<html><script>alert(1)</script></html>'), Buffer.alloc(2000, 32)]));
    await assert.rejects(() => sel.stageUpload(bad, 'notimage.png'), /not a JPEG, PNG or WebP|rejected/);
    const truncated = path.join(tmp, 'trunc.png');
    fs.writeFileSync(truncated, fs.readFileSync(picture('full.png', 600, 600, 2)).subarray(0, 1500));
    await assert.rejects(() => sel.stageUpload(truncated, 'trunc.png'), /./);
    const tiny = picture('tiny.png', 60, 60, 3);
    await assert.rejects(() => sel.stageUpload(tiny, 'tiny.png'), /at least 100px/);
    const tooBig = path.join(tmp, 'big.png');
    fs.writeFileSync(tooBig, Buffer.alloc(21 * 1024 * 1024, 1));
    await assert.rejects(() => sel.stageUpload(tooBig, 'big.png'), /maximum image size/);
    await assert.rejects(() => sel.stageUpload(path.join(tmp, 'missing.png'), 'missing.png'), /could not be read/);
  });

  it('tokens expire, can be cancelled, and arbitrary tokens are refused', async () => {
    const sel = new ImageSelectionService(stubDiscovery({}));
    const st = await sel.stageUpload(picture('t.png', 500, 500, 4), 't.png');
    assert.equal(sel.get(st.token).sha256, st.sha256);
    sel.discard(st.token);
    assert.throws(() => sel.get(st.token), /expired/);
    assert.throws(() => sel.get('../../etc/passwd'), /expired/);
    assert.throws(() => sel.get(undefined), /expired/);
    const st2 = await sel.stageUpload(picture('t2.png', 500, 500, 5), 't2.png');
    (sel as any).staged.get(st2.token).createdAt = Date.now() - 16 * 60 * 1000;
    assert.throws(() => sel.get(st2.token), /expired/);
  });

  it('online search downloads results through the safe downloader, drops unusable and duplicate pictures', async () => {
    const good = fs.readFileSync(picture('o1.png', 700, 700, 6));
    const dup = good;
    const tiny = fs.readFileSync(picture('o2.png', 70, 70, 7));
    const files: Record<string, Buffer> = { 'https://img.example/a.png': good, 'https://img.example/dup.png': dup, 'https://img.example/tiny.png': tiny, 'https://img.example/html': Buffer.alloc(3000, 60) };
    const cand = (u: string, extra: any = {}) => ({ id: u, provider: 'wikimedia-commons', title: u, imageUrl: u, pageUrl: 'https://page.example/' + u.slice(-5), license: 'CC BY 4.0', rights: { classification: 'open_license', label: 'Openly licensed (CC BY 4.0)' }, ...extra });
    const sel = new ImageSelectionService(stubDiscovery(files, [cand('https://img.example/a.png'), cand('https://img.example/dup.png'), cand('https://img.example/tiny.png'), cand('https://img.example/html'), cand('https://img.example/missing.png')]));
    const r = await sel.searchOnline('chiranjeevi');
    assert.equal(r.results.length, 1, 'one usable, unique picture');
    assert.equal(r.results[0].sourceType, 'online_search');
    assert.equal(r.results[0].aiVerified, false);
    await assert.rejects(() => sel.searchOnline(''), /2-200 characters/);
    await assert.rejects(() => sel.searchOnline('x'.repeat(201)), /2-200 characters/);
  });

  it('a search provider that allows only transient storage never has its link or title stored', async () => {
    const buf = fs.readFileSync(picture('tr.png', 700, 700, 8));
    const sel = new ImageSelectionService(stubDiscovery({ 'https://img.example/tr.png': buf }, [{ id: 'b', provider: 'brave-images', title: 'Secret title', imageUrl: 'https://img.example/tr.png', pageUrl: 'https://page.example/x', resultStorage: 'transient', rights: { classification: 'copyrighted_unconfirmed', label: 'Copyrighted: reuse permission not confirmed' } }]));
    const { results } = await sel.searchOnline('anything');
    const st = sel.get(results[0].token);
    const asset = sel.assetFor(st, { path: '/x/internet_a.png', filename: 'internet_a.png' }, {}, true);
    assert.equal(asset.sourceUrl, undefined);
    assert.equal(asset.sourcePage, undefined);
    assert.ok(!/Secret/.test(asset.originalName));
    assert.equal(results[0].sourcePage, undefined);
  });
});

describe('viral override request validation', () => {
  it('accepts a draft id and slot/token pairs only', () => {
    const tok = 'a'.repeat(32);
    assert.deepEqual(validateViralOverrides({ draftId: '0f0f0f0f-0000-4000-8000-000000000001', slotOverrides: JSON.stringify([{ slot: 2, token: tok }]) }), { draftId: '0f0f0f0f-0000-4000-8000-000000000001', overrides: [{ slot: 2, token: tok }] });
    assert.deepEqual(validateViralOverrides({}), { draftId: undefined, overrides: undefined });
    for (const bad of [{ draftId: '../x' }, { slotOverrides: 'not json' }, { slotOverrides: JSON.stringify([{ slot: 0, token: tok }]) }, { slotOverrides: JSON.stringify([{ slot: 1, token: 'http://evil.example/x.png' }]) }, { slotOverrides: JSON.stringify([{ slot: 1, path: '/etc/passwd' }]) }, { slotOverrides: JSON.stringify(new Array(9).fill({ slot: 1, token: tok })) }]) {
      assert.throws(() => validateViralOverrides(bad as any), /./, JSON.stringify(bad).slice(0, 60));
    }
  });
});

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';

describe('Replace Image on a stored meme (integration)', { skip }, () => {
  let engine: MemeEngineService;
  let selection: ImageSelectionService;
  let model: any;
  const created: string[] = [];
  const online: Record<string, Buffer> = {};
  const ta = (f: string) => path.join(TEST_ASSETS_ROOT, f);
  const asset = (f: string, i: number) => ({ id: `t${i}`, originalName: f, filename: f, path: ta(f), mimeType: 'image/jpeg', role: (i === 99 ? 'reaction_punchline' : 'subject_item') as any, orderIndex: i, label: i === 99 ? undefined : `LABEL ${i + 1}`, sha256: `orig-sha-${i}`, provider: i === 99 ? undefined : 'wikimedia-commons', sourceType: i === 99 ? undefined : ('ai_discovery' as any), selectedBy: i === 99 ? undefined : ('ai' as any), focalX: 0.5, focalY: 0.3 });

  before(async () => {
    Logger.overrideLogger(false);
    await mongoose.connect(URI as string);
    model = mongoose.models[Meme.name] || mongoose.model(Meme.name, MemeSchema);
    const offlineRunner = new VisionCliRunner().useConfig({ ...loadConfig({}).vision, cliPath: null });
    const renderer = new CanvasRendererService();
    renderer.registerFonts();
    selection = new ImageSelectionService(stubDiscovery(online));
    engine = new MemeEngineService(model, new LayoutEngineService(), renderer, new RegenerationService(offlineRunner), undefined, selection);
    engine.onModuleInit();
  });
  after(async () => {
    for (const id of created) await engine.deleteMeme(id).catch(() => undefined);
    await mongoose.disconnect();
  });

  const PUNCH = 'ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు';
  async function make() {
    const m = await engine.generateMeme({
      content: { topic: 'replace test', headline: 'NET WORTH OF CHIEF MINISTERS', punchline: PUNCH, reactionContext: '* TELUGU PEOPLE' },
      assets: { subjectImages: [0, 1, 2].map(i => asset(['compare_col1.jpg', 'compare_col2.jpg', 'compare_col3.jpg'][i], i)), reactionImage: asset('compare_reaction.jpg', 99) },
      layout: { memeType: 'comparison' }
    });
    created.push(m.memeId);
    return m;
  }
  const px = async (file: string) => {
    const img = await loadImage(fs.readFileSync(file));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
  };
  const region = (a: any, b: any, x0: number, y0: number, x1: number, y1: number) => {
    let diff = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
    }
    return diff;
  };
  const stageUpload = (name: string, seed: number) => selection.stageUpload(picture(name, 700, 900, seed), name);

  it('replaces one image: only that slot changes; text, layout, design, reaction and other images stay identical; a new version records it', async () => {
    const m = await make();
    const v1 = clone(m.toObject());
    const st = await stageUpload('mine.png', 11);
    const updated = await engine.applyImageReplacement(m.memeId, [{ slot: 2, token: st.token }], 1);
    const u = updated.toObject() as any;
    assert.equal(u.currentVersion, 2);
    assert.equal(u.versions.length, 2);
    // unaffected parts
    assert.deepEqual(u.content, v1.content, 'content (punchline) identical');
    assert.equal(u.content.punchline, PUNCH);
    assert.deepEqual(u.layout, v1.layout, 'layout identical');
    assert.deepEqual(u.design, v1.design, 'design/typography/style identical');
    assert.deepEqual(u.assets.reactionImage, v1.assets.reactionImage, 'reaction image identical');
    assert.deepEqual(u.assets.subjectImages[0], v1.assets.subjectImages[0]);
    assert.deepEqual(u.assets.subjectImages[2], v1.assets.subjectImages[2]);
    // the replaced slot
    const n = u.assets.subjectImages[1];
    assert.equal(n.sourceType, 'user_upload');
    assert.equal(n.selectedBy, 'user');
    assert.equal(n.aiVerified, false);
    assert.equal(n.label, 'LABEL 2', 'the slot keeps its label');
    assert.equal(n.focalX, undefined, 'no stale focal point from the previous picture');
    assert.ok(fs.existsSync(n.path));
    assert.equal(sha(fs.readFileSync(n.path)), st.sha256, 'the original file is stored unchanged');
    // version record
    const ver = u.versions[1];
    assert.equal(ver.interpreter, 'image_replace');
    assert.equal(ver.imageChanges.length, 1);
    const ch = ver.imageChanges[0];
    assert.equal(ch.slot, 2);
    assert.equal(ch.sourceType, 'user_upload');
    assert.equal(ch.previous.sha256, 'orig-sha-1');
    assert.equal(ch.previous.provider, 'wikimedia-commons');
    assert.equal(ch.replacement.assetId, n.id);
    assert.ok(Date.parse(ch.at) > Date.now() - 60000);
    // history never overwritten
    // (empty objects such as textScales {} are not stored by MongoDB: compare without them)
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length ? undefined : v)) || 'null');
    for (const k of Object.keys(v1.versions[0])) assert.deepEqual(norm(u.versions[0][k]), norm(v1.versions[0][k]), `version 1 untouched: ${k}`);
    // pixels: header strip, reaction panel and the neighbouring images are identical; the replaced one differs
    const a = await px(v1.outputPaths.png);
    const b = await px(u.outputPaths.png);
    const headerH = Math.round(u.layout.headerHeightRatio * a.h);
    const reactionY = a.h - Math.round(u.layout.reactionHeightRatio * a.h);
    assert.equal(region(a, b, 0, 0, a.w, headerH), 0, 'header text unchanged');
    assert.equal(region(a, b, 0, reactionY, a.w, a.h), 0, 'reaction image and punchline unchanged');
    assert.equal(region(a, b, 0, headerH, 355, reactionY), 0, 'image 1 unchanged');
    assert.equal(region(a, b, 725, headerH, a.w, reactionY), 0, 'image 3 unchanged');
    assert.ok(region(a, b, 365, headerH + 5, 715, reactionY - 5) > 1000, 'image 2 changed');
  });

  it('replaces several images at once, from different sources, as one version', async () => {
    const m = await make();
    const cand = fs.readFileSync(picture('cand.png', 800, 800, 12));
    online['https://img.example/cand.png'] = cand;
    selection.toString();
    const found = await selection.stageDiscovered({ sourceUrl: 'https://img.example/cand.png', sha256: sha(cand), title: 'Earlier candidate', provider: 'wikimedia-commons', license: 'CC BY 4.0', focus: { x: 0.4, y: 0.3 } });
    assert.ok(found, 'the discovered candidate is re-downloaded and checked against its hash');
    const mine = await stageUpload('mine2.png', 13);
    const updated = await engine.applyImageReplacement(m.memeId, [{ slot: 1, token: found!.token }, { slot: 3, token: mine.token }]);
    const u = updated.toObject() as any;
    assert.equal(u.versions.length, 2);
    assert.equal(u.versions[1].imageChanges.length, 2);
    assert.deepEqual(u.versions[1].imageChanges.map((c: any) => c.sourceType).sort(), ['ai_discovery', 'user_upload']);
    assert.equal(u.assets.subjectImages[0].focalX, 0.4, 'a verified candidate keeps the focal point found when it was verified');
    assert.equal(u.assets.subjectImages[0].aiVerified, true);
    assert.equal(u.assets.subjectImages[1].sha256, 'orig-sha-1', 'image 2 untouched');
    assert.equal(u.assets.subjectImages[2].sourceType, 'user_upload');
  });

  it('a hash mismatch (picture changed at its source) is not offered', async () => {
    online['https://img.example/changed.png'] = fs.readFileSync(picture('chg.png', 700, 700, 14));
    const r = await selection.stageDiscovered({ sourceUrl: 'https://img.example/changed.png', sha256: 'f'.repeat(64) });
    assert.equal(r, null);
  });

  it('cancel changes nothing; expired choices, bad slots, duplicates and stale versions are refused', async () => {
    const m = await make();
    const st = await stageUpload('cancel.png', 15);
    selection.discard(st.token);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 1, token: st.token }]), /expired/);
    let fresh = (await model.findOne({ memeId: m.memeId }).lean()) as any;
    assert.equal(fresh.versions.length, 1, 'no version created');
    const a = await stageUpload('a.png', 16);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 9, token: a.token }]), /slot must be a number from 1 to 3/);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 1, token: a.token }, { slot: 1, token: a.token }]), /appears twice/);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [], 1), /Provide 1-3/);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 1, token: a.token }], 7), /changed since you opened/);
    const same = await selection.stageUpload(picture('same.png', 700, 900, 17), 'same.png');
    await engine.applyImageReplacement(m.memeId, [{ slot: 1, token: same.token }]);
    const dup = await selection.stageUpload(picture('same.png', 700, 900, 17), 'same.png');
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 2, token: dup.token }]), /already used as image 1/);
    await assert.rejects(() => engine.applyImageReplacement(m.memeId, [{ slot: 1, token: dup.token }]), /already is this picture/);
    fresh = (await model.findOne({ memeId: m.memeId }).lean()) as any;
    assert.equal(fresh.versions.length, 2, 'refused requests created no versions');
  });

  it('previews the whole meme in memory without saving anything', async () => {
    const m = await make();
    const st = await stageUpload('prev.png', 18);
    const before = fs.readdirSync(path.dirname(m.outputPaths.png)).length;
    const r = await engine.previewImageReplacement(m.memeId, [{ slot: 2, token: st.token }], 1);
    assert.match(r.image, /^data:image\/jpeg;base64,/);
    assert.equal(r.width, 1080);
    assert.equal(fs.readdirSync(path.dirname(m.outputPaths.png)).length, before, 'no output file written');
    const fresh = (await model.findOne({ memeId: m.memeId }).lean()) as any;
    assert.equal(fresh.versions.length, 1);
    assert.doesNotThrow(() => selection.get(st.token), 'the choice is still available to apply');
  });

  it('restores an earlier version, then a new replacement continues the numbering; nothing is overwritten', async () => {
    const m = await make();
    const s1 = await stageUpload('r1.png', 19);
    await engine.applyImageReplacement(m.memeId, [{ slot: 1, token: s1.token }]);
    const restored = (await engine.restoreVersion(m.memeId, 1)).toObject() as any;
    assert.equal(restored.currentVersion, 1);
    assert.equal(restored.assets.subjectImages[0].sha256, 'orig-sha-0', 'the original image is back');
    assert.equal(restored.outputUrls.png.endsWith('_v1.png'), true);
    const s2 = await stageUpload('r2.png', 20);
    const again = (await engine.applyImageReplacement(m.memeId, [{ slot: 3, token: s2.token }], 1)).toObject() as any;
    assert.equal(again.currentVersion, 3, 'numbering continues after the highest version');
    assert.deepEqual(again.versions.map((v: any) => v.versionNumber), [1, 2, 3]);
    assert.ok(again.versions.every((v: any) => fs.existsSync(v.outputPaths.png)), 'every version still has its image');
    assert.equal(again.versions[1].assets.subjectImages[0].sourceType, 'user_upload', 'version 2 still shows its own replacement');
    assert.equal(again.assets.subjectImages[0].sha256, 'orig-sha-0');
  });

  it('the replacement is stored in the database (survives a fresh read, i.e. a restart)', async () => {
    const m = await make();
    const st = await stageUpload('persist.png', 21);
    await engine.applyImageReplacement(m.memeId, [{ slot: 2, token: st.token }]);
    const fresh = (await model.findOne({ memeId: m.memeId }).lean()) as any;
    assert.equal(fresh.currentVersion, 2);
    assert.equal(fresh.assets.subjectImages[1].sha256, st.sha256);
    assert.equal(fresh.versions[1].imageChanges[0].replacement.sha256, st.sha256);
    const re = await engine.getMemeById(m.memeId);
    assert.ok(fs.existsSync((re.assets.subjectImages[1] as any).path));
  });

  it('the AI regeneration will not silently replace a picture the user chose', async () => {
    const m = await make();
    const st = await stageUpload('user.png', 22);
    const u = await engine.applyImageReplacement(m.memeId, [{ slot: 2, token: st.token }]);
    await assert.rejects(() => (engine as any).replaceSlotImage(u, clone(u.toObject().assets), 2), /chose the image in slot 2 yourself/);
  });
});

function sha(b: Buffer): string {
  return require('crypto').createHash('sha256').update(b).digest('hex');
}
