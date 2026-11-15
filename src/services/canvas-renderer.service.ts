import { Injectable, OnModuleInit } from '@nestjs/common';
import { createCanvas, GlobalFonts, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'path';
import * as fs from 'fs';
import {
  MemeContent,
  MemeAssets,
  DesignSpecifications,
  BoundingBox,
  TextScales
} from '../types/meme.types';
import { ComputedMemeLayout } from './layout-engine.service';
import { analyzeReactionImage, drawReactionPlan, planReactionPanel } from './reaction-framing';
import { ENGLISH_FONTS, FONT_FILES, TELUGU_FONTS } from '../design/fonts';
import { ElementStyle, RenderStyle, resolveRenderStyle } from '../design/render-style';

export interface RenderResult {
  pngBuffer: Buffer;
  jpegBuffer: Buffer;
  width: number;
  height: number;
  /** Final font size used per text element (for the generation report). */
  textFit: Record<string, { size: number; lines: number }>;
}

export interface RenderOptions {
  /** Encodings to produce (default both). The settings preview only needs a JPEG. */
  formats?: ('png' | 'jpeg')[];
  /** Image loader (default: decode the file at the asset path). */
  loadImage?: (path: string) => Promise<any>;
}

export interface CropOptions {
  isReaction?: boolean;
  isPortraitSubject?: boolean;
  anchorX?: number; // 0.0 (left) to 1.0 (right), default 0.5 (center)
  anchorY?: number; // 0.0 (top) to 1.0 (bottom)
  /** Subject focus (fractions of the image): the crop is centred on it (face kept in the upper part). */
  focus?: { x: number; y: number };
  /** Rounded image corners (px). */
  cornerRadius?: number;
}

/** A text block cannot be fitted legibly. `element` tells the caller what to enlarge. */
export class TextFitError extends Error {
  constructor(public readonly element: 'headline' | 'statement' | 'bullets' | 'label' | 'reactionContext' | 'punchline', message: string) {
    super(message);
    this.name = 'TextFitError';
  }
}

/** The rendered output failed a structural check (wrong size, blank image area, unreadable image). */
export class RenderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderValidationError';
  }
}

interface FitResult {
  size: number;
  lines: string[];
  lineH: number;
}

/**
 * Deterministic meme renderer (Skia via @napi-rs/canvas).
 *
 * All visual choices come from a RenderStyle (design/render-style.ts): the settings snapshot stored
 * with each new meme, or the original constants for memes made before settings existed. Text is
 * never truncated or rewritten; images are never stretched.
 */
@Injectable()
export class CanvasRendererService implements OnModuleInit {
  onModuleInit() {
    this.registerFonts();
  }

  registerFonts() {
    const fontsDir = path.join(__dirname, '..', '..', 'fonts');
    for (const font of FONT_FILES) {
      const fullPath = path.join(fontsDir, font.file);
      if (fs.existsSync(fullPath)) {
        try {
          GlobalFonts.registerFromPath(fullPath, font.family);
        } catch (e: any) {
          console.warn(`Notice registering font ${font.family}:`, e.message);
        }
      }
    }
  }

  /** Font families the renderer can actually draw (registered from the fonts/ folder). */
  static readonly ENGLISH_FONTS = ENGLISH_FONTS;
  static readonly TELUGU_FONTS = TELUGU_FONTS;

  /**
   * Intelligent Cover Crop with Zero Aspect Distortion:
   * 1. Preserves the exact aspect ratio of the source image.
   * 2. Scales equally in X and Y (never stretches or squishes pixels).
   * 3. For 3:4 / 2:3 portrait subject images: anchors near top-center (eyeline ~28-32%) to preserve faces, heads and eyes.
   * 4. For 16:9 / widescreen reaction images: anchors at ~36-38% to preserve actors in cinematic wide composition.
   */
  drawIntelligentCoverImage(
    ctx: SKRSContext2D,
    img: any,
    dest: BoundingBox,
    options: CropOptions = {}
  ) {
    const imgW = img.width;
    const imgH = img.height;
    const imgAspect = imgW / imgH;
    const destAspect = dest.width / dest.height;

    let anchorX = options.anchorX !== undefined ? options.anchorX : 0.5;
    let anchorY = options.anchorY !== undefined ? options.anchorY : 0.5;

    if (options.isPortraitSubject) {
      anchorY = options.anchorY !== undefined ? options.anchorY : 0.28;
    } else if (options.isReaction) {
      anchorY = options.anchorY !== undefined ? options.anchorY : 0.36;
    }

    let sx = 0, sy = 0, sWidth = imgW, sHeight = imgH;

    if (imgAspect > destAspect) {
      sHeight = imgH;
      sWidth = imgH * destAspect;
      const excessW = imgW - sWidth;
      sx = options.focus
        ? Math.max(0, Math.min(imgW - sWidth, options.focus.x * imgW - sWidth / 2))
        : Math.max(0, Math.min(imgW - sWidth, excessW * anchorX));
      sy = 0;
    } else {
      sWidth = imgW;
      sHeight = imgW / destAspect;
      const excessH = imgH - sHeight;
      sx = 0;
      sy = options.focus
        ? Math.max(0, Math.min(imgH - sHeight, options.focus.y * imgH - sHeight * 0.38))
        : Math.max(0, Math.min(imgH - sHeight, excessH * anchorY));
    }

    ctx.save();
    ctx.beginPath();
    if (options.cornerRadius && options.cornerRadius > 0) ctx.roundRect(dest.x, dest.y, dest.width, dest.height, options.cornerRadius);
    else ctx.rect(dest.x, dest.y, dest.width, dest.height);
    ctx.clip();
    // Zero distortion: sWidth/sHeight === dest.width/dest.height
    ctx.drawImage(img, sx, sy, sWidth, sHeight, dest.x, dest.y, dest.width, dest.height);
    ctx.restore();
  }

  /** Whole image inside the area, centred, aspect ratio kept (the background shows around it). */
  drawContainImage(ctx: SKRSContext2D, img: any, dest: BoundingBox, cornerRadius = 0) {
    const scale = Math.min(dest.width / img.width, dest.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = dest.x + (dest.width - w) / 2;
    const y = dest.y + (dest.height - h) / 2;
    ctx.save();
    ctx.beginPath();
    if (cornerRadius > 0) ctx.roundRect(x, y, w, h, cornerRadius);
    else ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
    ctx.restore();
  }

  /** Word wrap against a maximum width. Explicit newlines are kept. Never drops or changes characters. */
  wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
    if (!text) return [];
    const resultLines: string[] = [];
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(/\s+/).filter(w => w.length > 0);
      if (words.length === 0) continue;
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          resultLines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) resultLines.push(currentLine);
    }
    return resultLines;
  }

  /** One line of meme text: outline (with shadow) then fill, as the house style always drew it. */
  private drawStyledText(ctx: SKRSContext2D, text: string, x: number, y: number, el: ElementStyle, fillCss: string) {
    ctx.save();
    ctx.textAlign = el.align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    if (el.letterSpacing) ctx.letterSpacing = `${el.letterSpacing}px`;
    const setShadow = () => {
      if (!el.shadowCss) return;
      ctx.shadowColor = el.shadowCss;
      ctx.shadowBlur = el.shadowBlur;
      ctx.shadowOffsetX = el.shadowOffsetX;
      ctx.shadowOffsetY = el.shadowOffsetY;
    };
    if (el.strokeCss) {
      setShadow();
      ctx.strokeStyle = el.strokeCss;
      ctx.lineWidth = el.strokeWidth;
      ctx.strokeText(text, x, y);
      ctx.shadowColor = 'transparent';
    } else {
      setShadow(); // no outline: the fill carries the shadow
    }
    ctx.fillStyle = fillCss;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  isTeluguScript(text: string): boolean {
    return /[ఀ-౿]/.test(text);
  }

  /** Font string for a final pixel size. Accepts an element style or (older callers) flat design specs. */
  fontFor(text: string, style: ElementStyle | DesignSpecifications, sizePx: number): string {
    const size = Math.max(8, Math.round(sizePx));
    const el = style as ElementStyle;
    const weight = el.weight || 'bold';
    if (this.isTeluguScript(text)) {
      const teluguFont = el.teluguFont || (style as DesignSpecifications).teluguFontFamily || 'Ramabhadra';
      return `${weight} ${size}px "${teluguFont}", "Noto Sans Telugu", sans-serif`;
    }
    const engFont = el.englishFont || (style as DesignSpecifications).fontFamily || 'Arial Black';
    return `${weight} ${size}px "${engFont}", "Intrepid ExtraBold", "Anton", sans-serif`;
  }

  /** Kept for compatibility: applies the global scale to a base size. */
  getFontForText(text: string, specs: DesignSpecifications, baseSize: number): string {
    return this.fontFor(text, specs, baseSize * (specs.fontSizeScale || 1.0));
  }

  /** Starting size: base x global scale x element scale, capped at the element's maximum. */
  private startSize(specs: DesignSpecifications, element: keyof TextScales, el: ElementStyle, base = el.size): number {
    const global = Number(specs.fontSizeScale) || 1;
    const per = Number(specs.textScales?.[element]) || 1;
    return Math.min(el.maxSize, base * global * per);
  }

  private setSpacing(ctx: SKRSContext2D, el: ElementStyle) {
    ctx.letterSpacing = el.letterSpacing ? `${el.letterSpacing}px` : '0px';
  }

  /**
   * Largest font size (from `startSize` down to `minSize`) at which `text` wraps inside `box`
   * without any line wider than the box. Returns null when even `minSize` does not fit.
   */
  fitText(ctx: SKRSContext2D, text: string, box: BoundingBox, el: ElementStyle, startSize: number, minSize = el.minSize, lineHeight = el.lineHeight): FitResult | null {
    const start = Math.max(minSize, Math.round(startSize));
    this.setSpacing(ctx, el);
    for (let size = start; size >= minSize; size -= 2) {
      ctx.font = this.fontFor(text, el, size);
      const lines = this.wrapText(ctx, text, box.width);
      if (lines.some(l => ctx.measureText(l).width > box.width)) continue;
      const lineH = Math.round(size * lineHeight);
      if (lines.length * lineH <= box.height) return { size, lines, lineH };
    }
    return null;
  }

  private anchorX(box: BoundingBox, el: ElementStyle): number {
    return el.align === 'left' ? box.x : el.align === 'right' ? box.x + box.width : box.x + box.width / 2;
  }

  private firstLineY(box: BoundingBox, totalH: number, lineH: number, el: ElementStyle): number {
    if (el.position === 'top') return box.y + lineH / 2;
    if (el.position === 'bottom') return box.y + box.height - totalH + lineH / 2;
    return box.y + (box.height - totalH) / 2 + lineH / 2;
  }

  private drawFitted(ctx: SKRSContext2D, fit: FitResult, box: BoundingBox, el: ElementStyle, highlightLine: (lineIdx: number, line: string) => boolean) {
    const startY = this.firstLineY(box, fit.lines.length * fit.lineH, fit.lineH, el);
    const x = this.anchorX(box, el);
    fit.lines.forEach((line, idx) => {
      ctx.font = this.fontFor(line, el, fit.size);
      const color = el.highlightCss && highlightLine(idx, line) ? el.highlightCss : el.fillCss;
      this.drawStyledText(ctx, line, x, startY + idx * fit.lineH, el, color);
    });
  }

  private async loadAssetImage(p: string, what: string, loader?: (path: string) => Promise<any>) {
    try {
      return await (loader ? loader(p) : loadImage(p));
    } catch (err: any) {
      throw new RenderValidationError(`${what} could not be decoded: ${err.message}`);
    }
  }

  /**
   * Full render. Never leaves an image slot silently empty and never truncates text: if text
   * cannot fit legibly a TextFitError is thrown so the caller can enlarge the area or report it.
   */
  async renderMeme(
    layout: ComputedMemeLayout,
    content: MemeContent,
    assets: MemeAssets,
    specs: DesignSpecifications,
    options: RenderOptions = {}
  ): Promise<RenderResult> {
    const style: RenderStyle = resolveRenderStyle(specs);
    const E = style.elements;
    const width = layout.canvasWidth;
    const height = layout.canvasHeight;
    const scale = style.canvas.outputScale > 0 ? style.canvas.outputScale : 1;
    const outW = Math.round(width * scale);
    const outH = Math.round(height * scale);
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    // Everything is drawn in layout units (1080 px wide); a larger output is scaled, not resampled.
    if (scale !== 1) ctx.scale(scale, scale);
    const textFit: Record<string, { size: number; lines: number }> = {};
    const radius = style.canvas.cornerRadius;

    ctx.fillStyle = style.canvas.background;
    ctx.fillRect(0, 0, width, height);

    // 1. Subject images
    const subjectImages = assets.subjectImages || [];
    for (let i = 0; i < layout.subjectSlots.length; i++) {
      const slot = layout.subjectSlots[i];
      const asset = subjectImages[i];
      if (asset && asset.path) {
        const img = await this.loadAssetImage(asset.path, `Subject image ${i + 1}`, options.loadImage);
        if (style.image.subjectFit === 'contain') {
          this.drawContainImage(ctx, img, slot.box, radius);
          continue;
        }
        const isPortrait = (img.width / img.height) < 0.95;
        const focus = style.image.useFocalPoint && typeof asset.focalX === 'number' && typeof asset.focalY === 'number' ? { x: asset.focalX, y: asset.focalY } : undefined;
        this.drawIntelligentCoverImage(ctx, img, slot.box, {
          isPortraitSubject: isPortrait,
          anchorX: 0.5,
          anchorY: isPortrait ? style.image.portraitAnchorY : style.image.landscapeAnchorY,
          focus,
          cornerRadius: radius
        });
      }
    }

    // 2. Slot labels (fit inside the label box; grow the box upward within the slot if needed)
    const isComparison = layout.memeType === 'comparison';
    for (let i = 0; i < layout.subjectSlots.length; i++) {
      const slot = layout.subjectSlots[i];
      const asset = subjectImages[i];
      const labelText = (asset && asset.label) || (content.itemLabels && content.itemLabels[i]);
      if (!labelText || !slot.labelBox) continue;
      const el = E.labels;
      const base = this.startSize(specs, 'labels', el, isComparison ? (el.comparisonSize ?? el.size) : el.size);
      let box = { ...slot.labelBox };
      let fit = this.fitText(ctx, labelText, box, el, base);
      for (let grow = 0; !fit && grow < 4; grow++) {
        const extra = Math.round(slot.box.height * 0.08);
        const newH = Math.min(Math.round(slot.box.height * 0.45), box.height + extra);
        box = { ...box, y: box.y - (newH - box.height), height: newH };
        fit = this.fitText(ctx, labelText, box, el, base);
      }
      if (!fit) throw new TextFitError('label', `The label "${labelText.slice(0, 40)}" does not fit in its image section.`);
      textFit[`label${i + 1}`] = { size: fit.size, lines: fit.lines.length };
      this.drawFitted(ctx, fit, box, el, (idx, line) => idx === 0 && (isComparison || /\d+/.test(line)));
    }

    // 3. Header banner
    if (layout.headerBox && content.headline) {
      ctx.fillStyle = style.canvas.headerBackground;
      ctx.fillRect(layout.headerBox.x, layout.headerBox.y, layout.headerBox.width, layout.headerBox.height);
      const headerText = content.headline.trim();
      const headerBox = layout.headerTextBox || layout.headerBox;
      const el = E.headline;
      const fit = this.fitText(ctx, headerText, headerBox, el, this.startSize(specs, 'headline', el));
      if (!fit) throw new TextFitError('headline', 'The headline does not fit in the header banner.');
      textFit.headline = { size: fit.size, lines: fit.lines.length };
      this.drawFitted(ctx, fit, headerBox, el, idx => idx === 0);
    }

    // 4. Statement / quote overlay (grows upward within the subject section if needed)
    if (layout.statementOverlayBox && content.statement) {
      const stmtText = content.statement.trim();
      const el = E.statement;
      let box = { ...layout.statementOverlayBox };
      const base = this.startSize(specs, 'statement', el);
      let fit = this.fitText(ctx, stmtText, box, el, base);
      const maxH = Math.round(layout.subjectSectionBox.height * 0.7);
      while (!fit && box.height < maxH) {
        const newH = Math.min(maxH, box.height + 60);
        box = { ...box, y: box.y - (newH - box.height), height: newH };
        fit = this.fitText(ctx, stmtText, box, el, base);
      }
      if (!fit) throw new TextFitError('statement', 'The statement text is too long for the image area.');
      textFit.statement = { size: fit.size, lines: fit.lines.length };
      this.drawFitted(ctx, fit, box, el, (idx, line) => line.startsWith('-') || line.includes('PRODUCER') || idx === 0);
    }

    // 5. Bullet points: one size for all bullets, each bullet may wrap
    if (layout.bulletOverlayBox && content.bulletPoints && content.bulletPoints.length > 0) {
      const bullets = content.bulletPoints.map(b => b.trim()).filter(Boolean);
      const el = E.bullets;
      let box = { ...layout.bulletOverlayBox };
      const base = this.startSize(specs, 'bullets', el);
      const tryFit = (b: BoundingBox) => {
        this.setSpacing(ctx, el);
        for (let size = Math.round(base); size >= el.minSize; size -= 2) {
          const lineH = Math.round(size * el.lineHeight);
          const blocks = bullets.map(t => {
            ctx.font = this.fontFor(t, el, size);
            return this.wrapText(ctx, t, b.width);
          });
          const tooWide = bullets.some((t, i) => {
            ctx.font = this.fontFor(t, el, size);
            return blocks[i].some(l => ctx.measureText(l).width > b.width);
          });
          const lines = blocks.reduce((a, bl) => a + bl.length, 0);
          if (!tooWide && lines * lineH <= b.height) return { size, lineH, blocks };
        }
        return null;
      };
      let fit = tryFit(box);
      const maxH = Math.round(layout.subjectSectionBox.height * 0.7);
      while (!fit && box.height < maxH) {
        const newH = Math.min(maxH, box.height + 60);
        box = { ...box, y: box.y - (newH - box.height), height: newH };
        fit = tryFit(box);
      }
      if (!fit) throw new TextFitError('bullets', 'The bullet points do not fit in the image area.');
      textFit.bullets = { size: fit.size, lines: fit.blocks.reduce((a, b) => a + b.length, 0) };
      const totalLines = fit.blocks.reduce((a, b) => a + b.length, 0);
      let y = this.firstLineY(box, totalLines * fit.lineH, fit.lineH, el);
      const x = el.align === 'center' ? width / 2 : this.anchorX(box, el);
      fit.blocks.forEach((block, idx) => {
        const color = el.highlightCss && idx % 2 === 0 ? el.highlightCss : el.fillCss;
        for (const line of block) {
          ctx.font = this.fontFor(line, el, fit!.size);
          this.drawStyledText(ctx, line, x, y, el, color);
          y += fit!.lineH;
        }
      });
    }

    // 6. Reaction image (the user's own image, used as supplied)
    if (layout.reactionBox && assets.reactionImage && assets.reactionImage.path) {
      const reactionImg = await this.loadAssetImage(assets.reactionImage.path, 'Reaction image', options.loadImage);
      if (style.image.reactionFit === 'contain') this.drawContainImage(ctx, reactionImg, layout.reactionBox, radius);
      else {
        const framing = specs.reactionFraming;
        const plan = planReactionPanel(analyzeReactionImage(reactionImg), framing, layout.reactionBox, style.image.reactionAnchorY);
        if (plan.kind === 'single' && !framing?.focus?.length) {
          // one picture, no choice made: the long-standing crop, unchanged
          this.drawIntelligentCoverImage(ctx, reactionImg, layout.reactionBox, {
            isReaction: true,
            anchorX: 0.5,
            anchorY: style.image.reactionAnchorY,
            cornerRadius: radius
          });
        } else {
          // a stack shown side by side, one frame of it, the whole picture, or a framing the owner chose
          drawReactionPlan(ctx, reactionImg, plan, { x: layout.reactionBox.x, y: layout.reactionBox.y }, radius);
        }
      }
    }

    // 7. Reaction context tag
    if (layout.reactionTagBox && content.reactionContext) {
      const tagText = content.reactionContext.trim();
      const el = E.reactionContext;
      const fit = this.fitText(ctx, tagText, layout.reactionTagBox, el, this.startSize(specs, 'reactionContext', el));
      if (!fit) throw new TextFitError('reactionContext', 'The reaction context tag is too long.');
      textFit.reactionContext = { size: fit.size, lines: fit.lines.length };
      this.drawFitted(ctx, fit, layout.reactionTagBox, el, () => true);
    }

    // 8. Punchline: exactly as entered. The box grows upward (up to a share of the reaction panel)
    //    and the font shrinks to a legible minimum; it is never cut or rewritten.
    if (layout.punchlineBox && content.punchline) {
      const punchText = content.punchline.trim();
      const el = E.punchline;
      let box = { ...layout.punchlineBox };
      const base = this.startSize(specs, 'punchline', el);
      let fit = this.fitText(ctx, punchText, box, el, base);
      const reactionH = layout.reactionBox ? layout.reactionBox.height : box.height;
      const maxH = Math.round(reactionH * style.canvas.punchlineMaxGrowRatio);
      while (!fit && box.height < maxH) {
        const newH = Math.min(maxH, box.height + 50);
        box = { ...box, y: box.y - (newH - box.height), height: newH };
        fit = this.fitText(ctx, punchText, box, el, base);
      }
      if (!fit) {
        throw new TextFitError('punchline', `The punchline (${punchText.length} characters) is too long to render legibly in the reaction panel. It is never shortened automatically; please use a shorter punchline.`);
      }
      textFit.punchline = { size: fit.size, lines: fit.lines.length };
      this.drawFitted(ctx, fit, box, el, idx => idx === 0);
    }

    this.validateOutput(ctx, layout, assets, scale);

    const formats = options.formats && options.formats.length ? options.formats : ['png', 'jpeg'];
    const empty = Buffer.alloc(0);
    return {
      pngBuffer: formats.includes('png') ? canvas.toBuffer('image/png') : empty,
      jpegBuffer: !formats.includes('jpeg') ? empty : style.image.jpegQuality ? canvas.toBuffer('image/jpeg', style.image.jpegQuality) : canvas.toBuffer('image/jpeg'),
      width: outW,
      height: outH,
      textFit
    };
  }

  /**
   * Structural output check: every image region that should contain a picture must not be blank
   * (uniform colour), and the canvas must have the expected size.
   */
  validateOutput(ctx: SKRSContext2D, layout: ComputedMemeLayout, assets: MemeAssets, scale = 1) {
    const expW = Math.round(layout.canvasWidth * scale);
    const expH = Math.round(layout.canvasHeight * scale);
    if (ctx.canvas.width !== expW || ctx.canvas.height !== expH) {
      throw new RenderValidationError(`Rendered canvas is ${ctx.canvas.width}x${ctx.canvas.height}, expected ${expW}x${expH}`);
    }
    const regions: { name: string; box: BoundingBox }[] = [];
    layout.subjectSlots.forEach((slot, i) => {
      if (assets.subjectImages && assets.subjectImages[i]) regions.push({ name: `subject image ${i + 1}`, box: slot.box });
    });
    if (layout.reactionBox && assets.reactionImage) regions.push({ name: 'reaction image', box: layout.reactionBox });
    for (const r of regions) {
      const w = Math.max(1, Math.floor(r.box.width * scale));
      const h = Math.max(1, Math.floor(r.box.height * scale));
      const data = ctx.getImageData(Math.floor(r.box.x * scale), Math.floor(r.box.y * scale), w, h).data;
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      const step = 4 * 7;
      for (let p = 0; p < data.length; p += step) {
        const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        sum += lum;
        sumSq += lum * lum;
        n++;
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      if (sd < 1.5) throw new RenderValidationError(`The ${r.name} area is blank in the rendered meme.`);
    }
  }
}
