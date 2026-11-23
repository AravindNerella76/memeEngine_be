/**
 * Settings: data model, validation, persistence logic, version 1 profile compatibility, pipeline
 * overrides (which can only make checks stricter), style snapshots, and the real renderer/layout
 * honouring the settings (offline: real canvas, no network, no database).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { applyRuntimeOverrides, getConfig, loadConfig, setConfigForTests, setRuntimeOverrides } from '../config/app-config';
import {
  defaultSettings,
  mergeSettingsPatch,
  normalizeStoredSettings,
  resetSection,
  runtimeOverridesFromSettings,
  settingsDelta,
  AppSettings
} from '../design/settings';
import { applyLegacyProfile, KANYARAASI_DEFAULT_PROFILE, mergeProfileUpdate, profileFromSettings, profileToDesignSpecs, settingsFromLegacyProfile } from '../design/design-profile';
import { designFromSettings, layoutStyleFromDesign, resolveRenderStyle } from '../design/render-style';
import { DesignProfileService } from '../design/design-profile.service';
import { discoveryLimits } from '../discovery/discovery-engine';
import { isVisuallyAccepted } from '../discovery/visual-verifier';
import { LayoutEngineService } from '../services/layout-engine.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { layoutAndRender } from '../services/render-pipeline';
import { SettingsPreviewService } from '../services/settings-preview.service';
import { DesignSpecifications, MemeAssets, MemeContent } from '../types/meme.types';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const withPatch = (patch: unknown): AppSettings => mergeSettingsPatch(defaultSettings(), patch);

describe('settings model', () => {
  it('defaults reproduce the house style and the version 1 profile exactly', () => {
    const s = defaultSettings();
    assert.equal(s.canvas.aspect, 'portrait_4_5');
    assert.deepEqual(
      { h: s.typography.roles.heading.size, l: s.typography.roles.labels.size, s: s.typography.roles.supporting.size, p: s.typography.roles.punchline.size, c: s.typography.roles.caption.size },
      { h: 48, l: 33, s: 42, p: 64, c: 34 }
    );
    assert.deepEqual(KANYARAASI_DEFAULT_PROFILE, {
      profileId: 'kanyaraasi-default',
      name: '@kanyaraasi_memes house style',
      canvas: { preset: 'portrait_4_5', width: 1080, height: 1350 },
      // the house style since 2026-11-24 (matched to the owner's own PixelLab memes)
      typography: { englishFont: 'Intrepid ExtraBold', teluguFont: 'Ramabhadra', fontSizeScale: 1, textScales: {} },
      colors: { primary: '#FAE944', secondary: '#FFFFFF', headerBackground: '#000000', headerText: '#FAE944', outline: '#000000', shadow: 'rgba(0,0,0,0.9)' },
      effects: { outlineThickness: 5, shadowBlur: 3, shadowOffsetX: 3, shadowOffsetY: 3 },
      imagery: { subjectAspectPreference: [0.75, 0.667], reactionAspect: 16 / 9, gaps: 0, dividerLines: false, borders: false },
      layout: { headerHeightRatio: 0.082 }
    });
  });

  it('applies a valid update and refuses invalid values and unknown keys without changing anything', () => {
    const s = withPatch({ typography: { roles: { punchline: { size: 52, teluguFont: 'Mandali' } } }, effects: { roles: { heading: { stroke: { width: 10 } } } } });
    assert.equal(s.typography.roles.punchline.size, 52);
    assert.equal(s.typography.roles.punchline.teluguFont, 'Mandali');
    assert.equal(s.effects.roles.heading.stroke.width, 10);
    assert.equal(s.typography.roles.heading.size, 48, 'other values untouched');
    const bad: [unknown, RegExp][] = [
      [{ typography: { roles: { punchline: { englishFont: 'Comic Sans' } } } }, /installed English font/],
      [{ effects: { roles: { labels: { stroke: { width: -2 } } } } }, /stroke\.width/],
      [{ canvas: { imageGap: -1 } }, /imageGap/],
      [{ canvas: { cornerRadius: 1e9 } }, /cornerRadius/],
      [{ typography: { roles: { caption: { size: 20, minSize: 30 } } } }, /minimum size/],
      [{ effects: { roles: { caption: { fill: { color: 'red' } } } } }, /colour/],
      [{ discovery: { identityMinConfidence: 0.5 } }, /identityMinConfidence/],
      [{ imageProcessing: { maxUpscale: 3 } }, /maxUpscale/],
      [{ discovery: { braveMonthlyLimit: 5000 } }, /not a setting/],
      [{ advanced: { maxUploadMB: 21 } }, /maxUploadMB/],
      ['nope', /object/]
    ];
    for (const [patch, re] of bad) {
      assert.throws(() => withPatch(patch), (e: any) => re.test(JSON.stringify(e.getResponse?.() ?? e.message)), JSON.stringify(patch));
    }
  });

  it('stored settings merge with the defaults; invalid stored values fall back; only changes are stored', () => {
    const d = defaultSettings();
    const s = normalizeStoredSettings({ typography: { roles: { punchline: { size: 60 } } }, canvas: { imageGap: 'x' } }, d);
    assert.equal(s.typography.roles.punchline.size, 60);
    assert.equal(s.canvas.imageGap, 0, 'invalid stored value falls back to the default');
    const changed = withPatch({ canvas: { imageGap: 8 }, discovery: { visualMinConfidence: 0.7 } });
    const delta = settingsDelta(changed, d);
    assert.deepEqual(delta, { canvas: { imageGap: 8 }, discovery: { visualMinConfidence: 0.7 } });
    const back = normalizeStoredSettings(delta, d);
    assert.deepEqual({ ...back, updatedAt: undefined }, { ...changed, updatedAt: undefined });
  });

  it('resets one section or everything', () => {
    const d = defaultSettings();
    const s = withPatch({ typography: { fontSizeScale: 1.2 }, canvas: { imageGap: 6 } });
    const r = resetSection(s, 'canvas', d);
    assert.equal(r.canvas.imageGap, 0);
    assert.equal(r.typography.fontSizeScale, 1.2);
    assert.equal(resetSection(s, 'all', d).typography.fontSizeScale, 1);
    assert.throws(() => resetSection(s, 'colours' as any, d), /Unknown settings section/);
  });

  it('migrates a version 1 profile and maps version 1 updates onto the roles they changed only', () => {
    const v1 = { ...clone(KANYARAASI_DEFAULT_PROFILE), colors: { ...KANYARAASI_DEFAULT_PROFILE.colors, primary: '#00FF00', shadow: 'rgba(0,0,0,0.5)' }, effects: { ...KANYARAASI_DEFAULT_PROFILE.effects, outlineThickness: 12 } };
    const s = settingsFromLegacyProfile(v1, defaultSettings());
    assert.equal(s.effects.roles.punchline.highlight.color, '#00FF00');
    assert.equal(s.effects.roles.heading.highlight.color, '#FAE944', 'the heading has its own highlight (headerText)');
    assert.ok(Object.values(s.effects.roles).every(fx => fx.stroke.width === 12 && fx.shadow.opacity === 0.5));
    const view = profileFromSettings(s);
    assert.equal(view.colors.primary, '#00FF00');
    assert.equal(view.effects.outlineThickness, 12);
    assert.equal(view.colors.shadow, 'rgba(0,0,0,0.5)');
    // a version 1 update keeps per-role choices it did not touch
    const custom = withPatch({ typography: { roles: { caption: { size: 30 } } }, effects: { roles: { labels: { fill: { color: '#ABCDEF' } } } } });
    const prev = profileFromSettings(custom);
    const next = applyLegacyProfile(custom, mergeProfileUpdate(prev, { typography: { englishFont: 'Anton' } }), prev);
    assert.ok(Object.values(next.typography.roles).every(t => t.englishFont === 'Anton'));
    assert.equal(next.typography.roles.caption.size, 30);
    assert.equal(next.effects.roles.labels.fill.color, '#ABCDEF');
  });
});

describe('pipeline settings never weaken checks or raise limits', () => {
  after(() => {
    setRuntimeOverrides(null);
    setConfigForTests(null);
  });

  it('can only switch providers off, raise thresholds and lower limits; caps and keys are untouched', () => {
    const base = loadConfig({ DISCOVERY_PROVIDERS: 'wikimedia-commons,wikipedia', IDENTITY_AI_MIN_CONFIDENCE: '0.9', BRAVE_MONTHLY_REQUEST_LIMIT: '50' });
    const cfg = applyRuntimeOverrides(base, {
      discovery: { disabledProviders: ['wikipedia'], visualMinConfidence: 0.3, minImageSide: 100, maxUpscale: 9, maxDownloadsPerSlot: 999 },
      identity: { aiMinConfidence: 0.81 },
      limits: { maxUploadBytes: 999 * 1024 * 1024 }
    });
    assert.deepEqual(cfg.discovery.enabledProviders, ['wikimedia-commons']);
    assert.equal(cfg.discovery.visualMinConfidence, 0.6, 'never below the built-in 0.6');
    assert.equal(cfg.identity.aiMinConfidence, 0.9, 'the stricter .env value wins');
    assert.equal(cfg.discovery.minImageSide, 250);
    assert.equal(cfg.discovery.maxUpscale, 2.5);
    assert.equal(cfg.discovery.maxDownloadsPerSlot, 30);
    assert.equal(cfg.limits.maxUploadBytes, 20 * 1024 * 1024);
    assert.equal(cfg.discovery.braveMonthlyLimit, 50, 'monthly caps come from .env only');
    // switching a provider ON cannot enable one that .env does not allow
    const s = withPatch({ discovery: { providers: { brave: true, openverse: true } } });
    const cfg2 = applyRuntimeOverrides(base, runtimeOverridesFromSettings(s));
    assert.ok(!cfg2.discovery.enabledProviders.includes('brave-images') && !cfg2.discovery.enabledProviders.includes('openverse'));
    const stricter = applyRuntimeOverrides(base, runtimeOverridesFromSettings(withPatch({ discovery: { visualMinConfidence: 0.8 }, imageProcessing: { minImageSide: 400, maxUpscale: 1.5 }, advanced: { maxUploadMB: 5 } })));
    assert.equal(stricter.discovery.visualMinConfidence, 0.8);
    assert.equal(stricter.discovery.minImageSide, 400);
    assert.equal(stricter.discovery.maxUpscale, 1.5);
    assert.equal(stricter.limits.maxUploadBytes, 5 * 1024 * 1024);
  });

  it('getConfig applies saved pipeline settings and clears them', () => {
    setConfigForTests(loadConfig({}));
    setRuntimeOverrides(runtimeOverridesFromSettings(withPatch({ discovery: { maxRounds: 1, providers: { openverse: false } } })));
    assert.equal(getConfig().discovery.maxRounds, 1);
    assert.ok(!getConfig().discovery.enabledProviders.includes('openverse'));
    setRuntimeOverrides(null);
    assert.equal(getConfig().discovery.maxRounds, 3);
  });

  it('discovery limits and the visual threshold are bounded', () => {
    assert.deepEqual(discoveryLimits({ maxDownloadsPerSlot: 1000, minImageSide: 10, maxUpscale: 10, duplicateHamming: 0, visualMinConfidence: 0.1 }), {
      maxDownloads: 30,
      minSide: 250,
      maxUpscale: 2.5,
      duplicateHamming: 4,
      visualMinConfidence: 0.6,
      rejectWatermarked: false
    });
    const plan: any = { desiredImageType: 'portrait', context: {} };
    const verdict: any = { verdict: 'accept', confidence: 0.65, showsIntendedSubject: 'yes', matchesReferencePerson: 'unknown', isCollageOrMeme: false, matchesRequestedType: 'yes', matchesContext: 'unknown', reason: 'ok' };
    assert.equal(isVisuallyAccepted(verdict, plan, false).ok, true);
    assert.equal(isVisuallyAccepted(verdict, plan, false, 0.7).ok, false, 'a stricter threshold rejects');
    assert.equal(isVisuallyAccepted({ ...verdict, confidence: 0.55 }, plan, false, 0.1).ok, false, 'never below 0.6');
  });
});

describe('render style', () => {
  it('memes without a snapshot keep the original renderer constants', () => {
    const st = resolveRenderStyle(profileToDesignSpecs(KANYARAASI_DEFAULT_PROFILE));
    assert.equal(st.legacy, true);
    assert.equal(st.elements.punchline.size, 46);
    assert.equal(st.elements.bullets.shadowCss, 'rgba(0,0,0,0.92)');
    assert.equal(layoutStyleFromDesign(profileToDesignSpecs(KANYARAASI_DEFAULT_PROFILE)), undefined);
  });

  it('new memes use their snapshot; values changed by regeneration apply to every role', () => {
    const design = designFromSettings(withPatch({ effects: { roles: { caption: { stroke: { width: 2 } } } } }));
    const st = resolveRenderStyle(design);
    assert.equal(st.legacy, false);
    assert.equal(st.elements.reactionContext.strokeWidth, 2);
    const regen = resolveRenderStyle({ ...design, fontFamily: 'Anton', outlineThickness: 10, primaryTextColor: '#00FF00', shadowColor: 'rgba(255,0,0,0.5)' });
    assert.ok(Object.values(regen.elements).every(e => e.englishFont === 'Anton'));
    assert.equal(regen.elements.punchline.strokeWidth, 10, 'outline doubled (5 -> 10)');
    assert.equal(regen.elements.reactionContext.strokeWidth, 4, 'proportional: the caption 2 -> 4');
    assert.equal(regen.elements.punchline.highlightCss, '#00FF00');
    assert.equal(regen.elements.headline.highlightCss, '#FAE944', 'the heading keeps its own highlight colour');
    assert.equal(regen.elements.punchline.shadowCss, 'rgba(255,0,0,0.5)');
  });
});

describe('renderer and layout follow the settings', () => {
  const layoutEngine = new LayoutEngineService();
  const renderer = new CanvasRendererService();
  renderer.registerFonts();
  let tmp: string;
  const file = (name: string) => path.join(tmp, name);

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
    const write = (name: string, w: number, h: number, draw: (ctx: any) => void) => {
      const c = createCanvas(w, h);
      draw(c.getContext('2d'));
      fs.writeFileSync(file(name), c.toBuffer('image/png'));
    };
    const noise = (ctx: any, w: number, h: number) => {
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `rgb(${(i * 37) % 200 + 30},${(i * 91) % 200 + 30},${(i * 53) % 200 + 30})`;
        ctx.fillRect((i * 97) % w, (i * 61) % h, 60, 60);
      }
    };
    write('portrait.png', 600, 800, ctx => noise(ctx, 600, 800));
    write('wide.png', 800, 400, ctx => noise(ctx, 800, 400));
    // reaction: busy top half, black bottom half (text there is easy to locate)
    write('reaction.png', 1280, 720, ctx => {
      noise(ctx, 1280, 360);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 360, 1280, 360);
    });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const asset = (p: string, i: number): any => ({ id: `a${i}`, originalName: p, filename: p, path: file(p), mimeType: 'image/png', role: i === 99 ? 'reaction_punchline' : 'subject_item', orderIndex: i });
  async function render(settings: AppSettings, opts: { subjects?: string[]; content?: Partial<MemeContent>; design?: Partial<DesignSpecifications> } = {}) {
    const design = { ...designFromSettings(settings), ...(opts.design || {}) };
    const subjects = (opts.subjects || ['portrait.png', 'portrait.png']).map(asset);
    const assets: MemeAssets = { subjectImages: subjects, reactionImage: asset('reaction.png', 99) };
    const imgs = await Promise.all(subjects.map(s => loadImage(s.path)));
    const content: MemeContent = { topic: 't', punchline: 'OK LEFT', ...(opts.content || {}) };
    const { computed, render: r } = await layoutAndRender(layoutEngine, renderer, design, { memeType: 'trending_news' }, content, assets, { subjectAspectRatios: imgs.map(i => i.width / i.height), reactionAspectRatio: 16 / 9 });
    const img = await loadImage(r.pngBuffer);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { r, computed, px, ctx };
  }

  it('image gaps show the background colour; corner radius rounds the pictures', async () => {
    const { computed, px } = await render(withPatch({ canvas: { imageGap: 10, cornerRadius: 30, background: '#FF00FF' } }));
    const [a, b] = computed.subjectSlots.map(s => s.box);
    assert.equal(b.x - (a.x + a.width), 10, 'slots are 10 px apart');
    const midY = Math.round(a.y + a.height / 2);
    assert.deepEqual(px(a.x + a.width + 5, midY), [255, 0, 255], 'gap pixel is the background colour');
    assert.deepEqual(px(a.x + 1, a.y + 1), [255, 0, 255], 'rounded corner shows the background');
  });

  it('"whole picture" fit keeps proportions and shows the background instead of stretching', async () => {
    const { computed, px } = await render(withPatch({ imageProcessing: { subjectFit: 'contain' }, canvas: { background: '#00FF00' } }), { subjects: ['wide.png', 'wide.png'] });
    const a = computed.subjectSlots[0].box;
    assert.deepEqual(px(a.x + Math.round(a.width / 2), a.y + 3), [0, 255, 0], 'above the contained 2:1 picture is background');
  });

  it('output scale 2 doubles the resolution; 9:16 is 1080 x 1920', async () => {
    const big = await render(withPatch({ canvas: { outputScale: 2 } }));
    assert.equal(big.r.width, 2160);
    assert.equal(big.r.height, 2700);
    const story = await render(withPatch({ canvas: { aspect: 'story_9_16' } }));
    assert.equal(story.r.height, 1920);
  });

  it('sizes follow the role settings, capped at the maximum; text that cannot fit is an error, not cut', async () => {
    const a = await render(withPatch({ typography: { roles: { punchline: { size: 60 } } } }));
    assert.equal(a.r.textFit.punchline.size, 60);
    const capped = await render(withPatch({ typography: { fontSizeScale: 1.6, roles: { punchline: { size: 60, maxSize: 70 } } } }));
    assert.equal(capped.r.textFit.punchline.size, 70);
    const long = 'మీరు ఒప్పుకున్నా ఒప్పుకోకపోయినా 19 ఇయర్స్ కే ఈ రేంజ్ ఫ్యాన్స్ ఇండియా లో ఏ హీరో కి లేరు '.repeat(3);
    await assert.rejects(() => render(withPatch({ typography: { roles: { punchline: { size: 120, minSize: 110 } } } }), { content: { punchline: long } }), /punchline/);
  });

  it('left alignment starts the text at the left edge of its area', async () => {
    const firstBright = async (align: string) => {
      const { computed, ctx } = await render(withPatch({ typography: { roles: { punchline: { align } } }, effects: { roles: { punchline: { shadow: { enabled: false } } } } }));
      const box = computed.punchlineBox!;
      const y = Math.round(box.y + box.height / 2);
      const row = ctx.getImageData(0, y - 6, 1080, 12).data;
      let minX = Infinity;
      for (let i = 0; i < row.length; i += 4) if (row[i] > 200 && row[i + 1] > 200) minX = Math.min(minX, (i / 4) % 1080);
      return { minX, box };
    };
    const left = await firstBright('left');
    const center = await firstBright('center');
    assert.ok(left.minX >= left.box.x && left.minX < left.box.x + 30, `left-aligned text starts at ${left.minX}`);
    assert.ok(center.minX > left.minX + 200, `centred text starts further right (${center.minX})`);
  });

  it('Telugu text is shaped with every Telugu font; letter spacing never splits a conjunct', () => {
    const c = createCanvas(10, 10);
    const ctx = c.getContext('2d');
    for (const font of CanvasRendererService.TELUGU_FONTS) {
      assert.ok(GlobalFonts.has(font), `${font} is registered`);
      ctx.font = `bold 44px "${font}"`;
      ctx.letterSpacing = '0px';
      const conjunct = ctx.measureText('క్క').width;
      const parts = ctx.measureText('క').width * 2 + ctx.measureText('్').width;
      assert.ok(conjunct < parts * 0.8, `${font}: క్క is one shaped cluster (${conjunct.toFixed(0)} < ${parts.toFixed(0)})`);
      const word = ctx.measureText('ఎక్కేసారు').width;
      ctx.letterSpacing = '10px';
      const spaced = ctx.measureText('ఎక్కేసారు').width;
      ctx.letterSpacing = '0px';
      assert.ok(Math.abs(spaced - word - 40) < 1, `${font}: spacing added once per cluster (4 clusters), got +${(spaced - word).toFixed(1)}`);
    }
  });

  it('without a style the layout keeps its original numbers', () => {
    const l = layoutEngine.calculateLayout({ memeType: 'trending_news', subjectCount: 2, hasHeader: true, hasPunchline: true, hasReactionContext: true, reactionAspectRatio: 16 / 9 });
    assert.deepEqual(l.headerTextBox, { x: 20, y: 8, width: 1040, height: Math.round(1350 * 0.082) - 16 });
    assert.equal(l.punchlineBox!.x, 30);
    assert.equal(l.punchlineBox!.height, Math.min(145, Math.round(l.reactionBox!.height * 0.38)));
    assert.equal(l.reactionTagBox!.x, 40);
    assert.equal(l.subjectSlots[1].box.x, l.subjectSlots[0].box.width, 'no gap');
    const styled = layoutEngine.calculateLayout({ memeType: 'trending_news', subjectCount: 2, hasHeader: true, hasPunchline: true, reactionAspectRatio: 16 / 9, style: { safeMargin: 60, imageGap: 0, sectionGap: 12, minSlotSize: 140, punchlineRatio: 0.3, defaultHeaderRatio: 0.1 } });
    assert.equal(styled.headerBox!.height, 135);
    assert.equal(styled.headerTextBox!.x, 60);
    assert.equal(styled.punchlineBox!.x, 60);
    assert.equal(styled.subjectSectionBox.y, 135 + 12);
  });
});

class FakeProfileModel {
  doc: any = null;
  writes = 0;
  findOne() {
    return { lean: () => ({ exec: async () => (this.doc ? clone(this.doc) : null) }) };
  }
  updateOne(q: any, update: any) {
    return {
      exec: async () => {
        this.writes++;
        this.doc = { ...(this.doc || { profileId: q.profileId }), ...clone(update.$set) };
      }
    };
  }
  deleteOne() {
    return {
      exec: async () => {
        this.writes++;
        this.doc = null;
      }
    };
  }
}

describe('settings service (persistence logic)', () => {
  after(() => {
    setRuntimeOverrides(null);
    setConfigForTests(null);
  });

  it('migrates a stored version 1 profile without writing, stores only changes, resets by deleting', async () => {
    setConfigForTests(loadConfig({}));
    const model = new FakeProfileModel();
    model.doc = { profileId: 'kanyaraasi-default', profile: { ...clone(KANYARAASI_DEFAULT_PROFILE), typography: { ...KANYARAASI_DEFAULT_PROFILE.typography, teluguFont: 'Mandali' } } };
    const svc = new DesignProfileService(model as any);
    const s = await svc.getSettings();
    assert.ok(Object.values(s.typography.roles).every(t => t.teluguFont === 'Mandali'), 'version 1 profile migrated');
    assert.equal(model.writes, 0, 'reading never writes');
    await svc.updateSettings({ canvas: { imageGap: 6 } });
    assert.deepEqual(Object.keys(model.doc.settings).sort(), ['canvas', 'typography', 'updatedAt', 'version']);
    assert.equal(model.doc.settings.canvas.imageGap, 6);
    assert.equal(model.doc.profile.typography.teluguFont, 'Mandali', 'the version 1 view is kept in sync');
    await assert.rejects(() => svc.updateSettings({ canvas: { imageGap: -6 } }), /Invalid settings/);
    assert.equal(model.doc.settings.canvas.imageGap, 6, 'a refused update stores nothing');
    const fresh = new DesignProfileService(model as any);
    assert.equal((await fresh.getSettings()).canvas.imageGap, 6, 'a new service instance (restart) reads the saved settings');
    await fresh.resetSettings('all');
    assert.equal(model.doc, null);
    assert.equal((await fresh.getSettings()).typography.roles.punchline.teluguFont, 'Ramabhadra');
  });

  it('saved pipeline settings are applied to the process configuration', async () => {
    setConfigForTests(loadConfig({}));
    const svc = new DesignProfileService(new FakeProfileModel() as any);
    await svc.updateSettings({ discovery: { visualMinConfidence: 0.75, providers: { wikipedia: false } } });
    assert.equal(getConfig().discovery.visualMinConfidence, 0.75);
    assert.ok(!getConfig().discovery.enabledProviders.includes('wikipedia'));
    await svc.resetSettings('discovery');
    assert.equal(getConfig().discovery.visualMinConfidence, 0.6);
    assert.ok(getConfig().discovery.enabledProviders.includes('wikipedia'));
  });
});

describe('settings preview', () => {
  const renderer = new CanvasRendererService();
  renderer.registerFonts();
  const profiles: any = { getSettings: async () => defaultSettings() };
  const preview = new SettingsPreviewService(profiles, new LayoutEngineService(), renderer);

  it('renders every sample in memory with unsaved settings', async () => {
    for (const sample of ['comparison', 'news', 'review', 'long']) {
      const r = await preview.render({ sample, settings: { typography: { roles: { punchline: { size: 50 } } } } });
      assert.match(r.image, /^data:image\/jpeg;base64,/);
      assert.equal(r.width, 1080);
      assert.equal(r.height, 1350);
      assert.ok(r.textFit.punchline, `${sample}: punchline drawn`);
    }
  });

  it('refuses invalid unsaved settings, unknown samples and options', async () => {
    await assert.rejects(() => preview.render({ settings: { effects: { roles: { punchline: { stroke: { width: -1 } } } } } }), /Invalid settings/);
    await assert.rejects(() => preview.render({ sample: 'constructor' }), /sample must be one of/);
    await assert.rejects(() => preview.render({ path: '/etc/passwd' }), /not a preview option/);
    await assert.rejects(() => preview.render({ text: { punchline: 'x'.repeat(601) } }), /at most 600/);
  });
});
