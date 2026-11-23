/**
 * The house style of 2026-11-24, matched to the owner's own PixelLab memes: black/white bars trimmed from pictures,
 * a dark shade behind text on pictures, numbers kept with their word, and older memes rendering exactly as before.
 */
import { describe, it, before, after } from 'node:test';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { findContentRect, trimImageBorders } from '../services/border-trim';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { LayoutEngineService } from '../services/layout-engine.service';
import { layoutAndRender } from '../services/render-pipeline';
import { defaultSettings } from '../design/settings';
import { designFromSettings, resolveRenderStyle } from '../design/render-style';
import { profileToDesignSpecs, KANYARAASI_DEFAULT_PROFILE } from '../design/design-profile';

/** A busy picture (no flat areas anywhere) inside x, y, w, h (nothing drawn outside it). */
function busy(ctx: any, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgb(${((i * 37) % 160) + 60},${((i * 91) % 160) + 60},${((i * 53) % 160) + 60})`;
    ctx.fillRect(x + ((i * 97) % w), y + ((i * 61) % h), 70, 70);
  }
  ctx.restore();
}

function picture(w: number, h: number, draw: (ctx: any) => void) {
  const c = createCanvas(w, h);
  draw(c.getContext('2d'));
  return c;
}

/** A movie still: picture in the middle, black bars above and below, a small studio logo in the bottom bar. */
const letterboxed = () =>
  picture(1350, 640, ctx => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1350, 640);
    ctx.fillStyle = '#556677';
    ctx.fillRect(0, 70, 1350, 500);
    busy(ctx, 0, 70, 1280, 430);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1250, 590, 60, 20); // the logo
  });

describe('trimming bars from pictures', () => {
  it('finds the picture inside letterbox bars (a logo in the bar does not stop it)', () => {
    const r = findContentRect(letterboxed());
    assert.ok(r, 'bars found');
    assert.ok(Math.abs(r!.y - 70) <= 4, `top ${r!.y}`);
    assert.ok(Math.abs(r!.y + r!.height - 570) <= 4, `bottom ${r!.y + r!.height}`);
    assert.equal(r!.x, 0);
    assert.equal(r!.width, 1350);
    const t = trimImageBorders(letterboxed());
    assert.ok(t.height <= 500 && t.height >= 492);
  });

  it('cuts white screenshot borders and pillarbox bars', () => {
    const r = findContentRect(
      picture(800, 600, ctx => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 800, 600);
        ctx.fillStyle = '#556677';
        ctx.fillRect(100, 0, 600, 600);
        busy(ctx, 100, 0, 600, 600);
      })
    );
    assert.ok(r && Math.abs(r.x - 100) <= 3 && Math.abs(r.x + r.width - 700) <= 3, JSON.stringify(r));
  });

  it('leaves real pictures alone: no bars, a dark sky taking a third, a dark area that fades in', () => {
    assert.equal(findContentRect(picture(800, 600, ctx => busy(ctx, 0, 0, 800, 600))), null);
    const sky = picture(800, 600, ctx => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = '#556677';
      ctx.fillRect(0, 200, 800, 400);
      busy(ctx, 0, 200, 800, 400);
    });
    assert.equal(findContentRect(sky), null, 'a third of the frame is content, not a bar');
    const fade = picture(800, 600, ctx => {
      ctx.fillStyle = '#556677';
      ctx.fillRect(0, 0, 800, 600);
      busy(ctx, 0, 0, 800, 600);
      const g = ctx.createLinearGradient(0, 0, 0, 120);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.5, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 800, 120);
    });
    assert.equal(findContentRect(fade), null, 'fades in: content');
  });
});

describe('text rules', () => {
  const renderer = new CanvasRendererService();
  renderer.registerFonts();
  const ctx = createCanvas(10, 10).getContext('2d');

  it('a number moves down with the word it counts, and no character changes', () => {
    ctx.font = '44px "Poppins Black"';
    const text = 'AS C.E.O. US STOCK MARKET GAINS OVER 4 TRILLION IN MINUTES';
    const width = ctx.measureText('AS C.E.O. US STOCK MARKET GAINS OVER 4').width + 2;
    const plain = renderer.wrapText(ctx as any, text, width);
    const kept = renderer.wrapText(ctx as any, text, width, true);
    assert.match(plain[0], / 4$/, 'without the rule the number is stranded');
    assert.deepEqual(kept, ['AS C.E.O. US STOCK MARKET GAINS OVER', '4 TRILLION IN MINUTES']);
    assert.equal(kept.join(' '), text);
    assert.deepEqual(renderer.wrapText(ctx as any, 'GAINS ₹1,200', 1000, true), ['GAINS ₹1,200'], 'a number at the very end stays');
  });

  it('new memes get the new rules; older memes and snapshots keep exactly what they had', () => {
    const now = resolveRenderStyle(designFromSettings(defaultSettings()));
    assert.equal(now.image.trimBorders, true);
    assert.equal(now.elements.punchline.shadeAlpha, 1, 'the punchline fades to solid black at the bottom edge');
    assert.equal(now.elements.statement.shadeAlpha, 0.65);
    assert.equal(now.elements.statement.highlightPattern, 'alternate');
    assert.equal(now.elements.statement.keepNumbersWithWords, true);
    assert.equal(now.canvas.punchlineSetupScale, 0.82);
    assert.equal(now.elements.punchline.englishFont, 'Intrepid ExtraBold');

    const legacy = resolveRenderStyle(profileToDesignSpecs(KANYARAASI_DEFAULT_PROFILE));
    assert.equal(legacy.legacy, true);
    assert.deepEqual(
      [legacy.image.trimBorders, legacy.elements.punchline.shadeAlpha, legacy.elements.statement.highlightPattern, legacy.elements.statement.keepNumbersWithWords, legacy.canvas.punchlineSetupScale],
      [false, 0, 'first', false, 0.74]
    );

    // a snapshot taken before 2026-11-24 has none of the new fields
    const old = designFromSettings(defaultSettings()) as any;
    delete old.style.rev;
    delete old.style.image.trimBorders;
    delete old.style.canvas.punchlineSetupScale;
    for (const r of Object.values(old.style.roles) as any[]) {
      delete r.effects.shade;
      delete r.effects.highlight.pattern;
    }
    const o = resolveRenderStyle(old);
    assert.deepEqual(
      [o.image.trimBorders, o.elements.punchline.shadeAlpha, o.elements.statement.highlightPattern, o.elements.statement.keepNumbersWithWords, o.canvas.punchlineSetupScale],
      [false, 0, 'first', false, 0.74]
    );
  });
});

describe('rendering in the house style', () => {
  const layoutEngine = new LayoutEngineService();
  const renderer = new CanvasRendererService();
  renderer.registerFonts();
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'house-style-'));
    fs.writeFileSync(path.join(tmp, 'rx.png'), letterboxed().toBuffer('image/png'));
    fs.writeFileSync(path.join(tmp, 's.png'), picture(600, 800, ctx => busy(ctx, 0, 0, 600, 800)).toBuffer('image/png'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function render(design: any, punchline = '') {
    const asset = (f: string, i: number, role: string): any => ({ id: `a${i}`, originalName: f, filename: f, path: path.join(tmp, f), mimeType: 'image/png', role, orderIndex: i });
    const { render: r } = await layoutAndRender(
      layoutEngine,
      renderer,
      design,
      { memeType: 'trending_news' },
      { topic: 't', punchline: punchline || 'X' },
      { subjectImages: [asset('s.png', 0, 'subject_item'), asset('s.png', 1, 'subject_item')], reactionImage: asset('rx.png', 99, 'reaction_punchline') },
      { subjectAspectRatios: [0.75, 0.75], reactionAspectRatio: 1350 / 640 }
    );
    const img = await loadImage(r.pngBuffer);
    const c = createCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    /** Share of near-black pixels in row y. */
    const blackRow = (y: number) => {
      const d = g.getImageData(0, y, img.width, 1).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 20 && d[i + 1] < 20 && d[i + 2] < 20) n++;
      return n / img.width;
    };
    return { blackRow, height: img.height };
  }

  it('a letterboxed reaction picture fills its panel: no black bands at its top and bottom', async () => {
    // the punchline's fade darkens the bottom edge on purpose: switched off here so only the picture is measured
    const s = defaultSettings();
    s.effects.roles.punchline.shade.enabled = false;
    const { blackRow, height } = await render(designFromSettings(s), ' ');
    assert.ok(blackRow(height - 3) < 0.5, `bottom row is ${Math.round(blackRow(height - 3) * 100)}% black`);
  });

  it('the punchline fades the picture to black at its bottom edge, and leaves it untouched higher up', async () => {
    const { blackRow, height } = await render(designFromSettings(defaultSettings()), 'THE KING IS\nBACK TO DEN');
    assert.ok(blackRow(height - 1) > 0.95, 'solid black at the very bottom');
    const s = defaultSettings();
    s.effects.roles.punchline.shade.enabled = false;
    const plain = await render(designFromSettings(s), 'THE KING IS\nBACK TO DEN');
    const y = height - 200; // above the punchline
    assert.equal(blackRow(y), plain.blackRow(y), 'no shade above the words');
  });

  it('with trimming off the bars stay, as they always did', async () => {
    const s = defaultSettings();
    s.imageProcessing.trimBorders = false;
    s.effects.roles.punchline.shade.enabled = false;
    const { blackRow, height } = await render(designFromSettings(s), ' ');
    assert.ok(blackRow(height - 3) > 0.9);
  });
});
