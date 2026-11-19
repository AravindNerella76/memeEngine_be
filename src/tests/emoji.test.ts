/**
 * Emoji in meme text. The server draws the text, so it must not depend on the machine having an emoji font: flags and
 * recent emoji came out as letters ("IN") or empty boxes, and a Linux host with no emoji font drew none at all.
 * These tests draw real emoji through the real renderer and look for colours only a genuine emoji glyph can produce.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { EMOJI_FONT, FONT_FILES } from '../design/fonts';

const FONTS_DIR = path.join(__dirname, '..', '..', 'fonts');

// the house style of the meme text: yellow fill, black outline, soft shadow (so any other colour is the emoji's)
const STYLE: any = { align: 'center', strokeCss: '#000000', strokeWidth: 8, shadowCss: 'rgba(0,0,0,0.6)', shadowBlur: 6, shadowOffsetX: 3, shadowOffsetY: 3, letterSpacing: 0, weight: 'bold', englishFont: 'Arial Black', teluguFont: 'Ramabhadra' };

describe('emoji in meme text', () => {
  const renderer = new CanvasRendererService();
  before(() => renderer.registerFonts());

  /** Draws one line like the renderer does and returns the pixels. */
  function draw(text: string, size = 90) {
    const c = createCanvas(900, 220);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = renderer.fontFor(text, STYLE, size);
    (renderer as any).drawStyledText(ctx, text, 450, 110, STYLE, '#FFE500'); // private: it is the exact routine that draws meme text
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const count = (test: (r: number, g: number, b: number) => boolean) => {
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && test(data[i], data[i + 1], data[i + 2])) n++;
      return n;
    };
    return { count, width: ctx.measureText(text).width };
  }
  const blue = (r: number, g: number, b: number) => b > r + 60 && b > g + 20;
  const green = (r: number, g: number, b: number) => g > r + 40 && g > b + 40;
  const red = (r: number, g: number, b: number) => r > 180 && g < 90 && b < 90;

  it('the emoji font ships with the project and is registered', () => {
    const file = FONT_FILES.find(f => f.family === EMOJI_FONT);
    assert.ok(file, 'listed with the other fonts');
    assert.ok(fs.existsSync(path.join(FONTS_DIR, file!.file)), `${file!.file} is in the fonts folder (it is what makes emoji work on every host)`);
    assert.ok(GlobalFonts.families.some(f => f.family === EMOJI_FONT), 'registered with the renderer');
    assert.ok(fs.existsSync(path.join(FONTS_DIR, 'NotoColorEmoji.NOTICE.txt')), 'its license notice travels with it');
  });

  it('is last in both font stacks, so it only draws what the meme fonts cannot', () => {
    for (const text of ['SOCIAL MEDIA SHAKE 🔥', 'సూపర్ 🔥']) {
      const stack = renderer.fontFor(text, STYLE, 60);
      assert.match(stack, new RegExp(`"${EMOJI_FONT}", sans-serif$`), stack);
    }
    assert.ok(renderer.fontFor('సూపర్', STYLE, 60).indexOf('Ramabhadra') < renderer.fontFor('సూపర్', STYLE, 60).indexOf(EMOJI_FONT), 'the Telugu font still comes first');
  });

  it('draws a recent emoji (🥹) as a real picture, not an empty box (older systems lack it)', () => {
    const { count } = draw('A 🥹');
    assert.ok(count(blue) > 40, `the blue tears are there (${count(blue)} pixels)`);
  });

  it('draws a flag (🇮🇳) as a flag, not the letters "IN"', () => {
    const { count } = draw('FLAG 🇮🇳');
    assert.ok(count(green) > 60, `the green stripe is there (${count(green)} pixels)`);
  });

  it('draws a heart with skin-tone and joined emoji (❤️ 👍🏽) in colour', () => {
    const { count } = draw('సూపర్ ❤️ 👍🏽');
    assert.ok(count(red) > 60, `the red heart is there (${count(red)} pixels)`);
  });

  it('works inside Telugu text too', () => {
    const { count } = draw('ఇది సూపర్ 🥹 నిజంగా');
    assert.ok(count(blue) > 40, 'an emoji between Telugu words is drawn');
  });

  it('emoji take room in the text fit: a line with them is wider than without', () => {
    assert.ok(draw('WOW 😍😭🙏').width > draw('WOW').width + 100);
  });

  it('ordinary text is drawn exactly as before: no blue, green or red appears from a line of letters, digits and symbols', () => {
    const { count } = draw('DIGITS 0123456789 #*@ © ® 100% — “q”', 56);
    assert.equal(count(blue), 0);
    assert.equal(count(green), 0);
    assert.equal(count(red), 0);
  });
});
