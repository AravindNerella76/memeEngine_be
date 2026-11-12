import { Injectable, OnModuleInit } from '@nestjs/common';
import { createCanvas, GlobalFonts, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'path';
import * as fs from 'fs';
import {
  MemeContent,
  MemeAssets,
  DesignSpecifications,
  BoundingBox
} from '../types/meme.types';
import { ComputedMemeLayout } from './layout-engine.service';

export interface RenderResult {
  pngBuffer: Buffer;
  jpegBuffer: Buffer;
  width: number;
  height: number;
}

export interface CropOptions {
  isReaction?: boolean;
  isPortraitSubject?: boolean;
  anchorX?: number; // 0.0 (left) to 1.0 (right), default 0.5 (center)
  anchorY?: number; // 0.0 (top) to 1.0 (bottom)
}

@Injectable()
export class CanvasRendererService implements OnModuleInit {
  onModuleInit() {
    this.registerFonts();
  }

  registerFonts() {
    const fontsDir = path.join(__dirname, '..', '..', 'fonts');
    const fontsToRegister = [
      { file: 'Ramabhadra-Regular.ttf', family: 'Ramabhadra' },
      { file: 'Mandali-Regular.ttf', family: 'Mandali' },
      { file: 'NotoSansTelugu-Bold.ttf', family: 'Noto Sans Telugu' },
      { file: 'Anton-Regular.ttf', family: 'Anton' },
      { file: 'Arial-Black.ttf', family: 'Arial Black' },
      { file: 'Impact.ttf', family: 'Impact' },
      { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid ExtraBold' },
      { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid' },
    ];

    for (const font of fontsToRegister) {
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

    // Determine intelligent anchors
    let anchorX = options.anchorX !== undefined ? options.anchorX : 0.5;
    let anchorY = options.anchorY !== undefined ? options.anchorY : 0.5;

    if (options.isPortraitSubject) {
      // Faces and heads in 2:3 or 3:4 portrait photos are in the upper 25-35%
      anchorY = options.anchorY !== undefined ? options.anchorY : 0.28;
    } else if (options.isReaction) {
      // Cinematic 16:9 widescreen frames have eyeline around 35-38%
      anchorY = options.anchorY !== undefined ? options.anchorY : 0.36;
    }

    let sx = 0, sy = 0, sWidth = imgW, sHeight = imgH;

    if (imgAspect > destAspect) {
      // Image is wider than slot: scale by height, crop horizontal edges using anchorX
      sHeight = imgH;
      sWidth = imgH * destAspect;
      const excessW = imgW - sWidth;
      sx = Math.max(0, Math.min(imgW - sWidth, excessW * anchorX));
      sy = 0;
    } else {
      // Image is taller than slot: scale by width, crop vertical edges using anchorY
      sWidth = imgW;
      sHeight = imgW / destAspect;
      const excessH = imgH - sHeight;
      sx = 0;
      sy = Math.max(0, Math.min(imgH - sHeight, excessH * anchorY));
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(dest.x, dest.y, dest.width, dest.height);
    ctx.clip();
    // Zero distortion: sWidth/sHeight === dest.width/dest.height
    ctx.drawImage(img, sx, sy, sWidth, sHeight, dest.x, dest.y, dest.width, dest.height);
    ctx.restore();
  }

  /**
   * Automatic Word-Wrap algorithm measuring lines against max width
   */
  private wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
    if (!text) return [];
    const rawParagraphs = text.split('\n');
    const resultLines: string[] = [];

    for (const paragraph of rawParagraphs) {
      const words = paragraph.split(/\s+/).filter(w => w.length > 0);
      if (words.length === 0) continue;

      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && currentLine) {
          resultLines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) {
        resultLines.push(currentLine);
      }
    }

    return resultLines;
  }

  /**
   * High-contrast meme text with rounded black outline and deep drop shadow
   */
  private drawMemeText(
    ctx: SKRSContext2D,
    text: string,
    x: number,
    y: number,
    options: {
      fillColor?: string;
      strokeColor?: string;
      strokeWidth?: number;
      shadowColor?: string;
      shadowBlur?: number;
      align?: 'center' | 'left' | 'right';
      baseline?: 'top' | 'middle' | 'bottom';
    } = {}
  ) {
    const {
      fillColor = '#FFE500',
      strokeColor = '#000000',
      strokeWidth = 7,
      shadowColor = 'rgba(0,0,0,0.92)',
      shadowBlur = 8,
      align = 'center',
      baseline = 'middle'
    } = options;

    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.strokeText(text, x, y);

    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);

    ctx.restore();
  }

  private isTeluguScript(text: string): boolean {
    return /[\u0C00-\u0C7F]/.test(text);
  }

  private getFontForText(text: string, specs: DesignSpecifications, baseSize: number): string {
    const scale = specs.fontSizeScale || 1.0;
    const finalSize = Math.round(baseSize * scale);
    if (this.isTeluguScript(text)) {
      const teluguFont = specs.teluguFontFamily || 'Ramabhadra';
      return `bold ${finalSize}px "${teluguFont}", "Noto Sans Telugu", sans-serif`;
    }
    const engFont = specs.fontFamily || 'Arial Black';
    return `bold ${finalSize}px "${engFont}", "Intrepid ExtraBold", "Anton", sans-serif`;
  }

  /**
   * Full Programmatic Meme Render Pipeline with Aspect Ratio Preservation
   */
  async renderMeme(
    layout: ComputedMemeLayout,
    content: MemeContent,
    assets: MemeAssets,
    specs: DesignSpecifications
  ): Promise<RenderResult> {
    const width = layout.canvasWidth;
    const height = layout.canvasHeight;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Black Canvas Background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // 2. Draw Subject Images (Intelligent Portrait Framing)
    const subjectImages = assets.subjectImages || [];
    for (let i = 0; i < layout.subjectSlots.length; i++) {
      const slot = layout.subjectSlots[i];
      const asset = subjectImages[i];

      if (asset && asset.path && fs.existsSync(asset.path)) {
        try {
          const img = await loadImage(asset.path);
          // Detect whether image is portrait
          const isPortrait = (img.width / img.height) < 0.95;
          this.drawIntelligentCoverImage(ctx, img, slot.box, {
            isPortraitSubject: isPortrait,
            anchorX: 0.5,
            anchorY: isPortrait ? 0.28 : 0.40
          });
        } catch (err: any) {
          console.warn(`Could not load subject image ${i}:`, err.message);
        }
      }

      // Draw slot label (subcaption) if present
      const labelText = (asset && asset.label) || (content.itemLabels && content.itemLabels[i]);
      if (labelText && slot.labelBox) {
        ctx.font = this.getFontForText(labelText, specs, layout.memeType === 'comparison' ? 36 : 33);
        const lines = this.wrapText(ctx, labelText, slot.labelBox.width);
        const lineH = layout.memeType === 'comparison' ? 44 : 38;
        const totalTextH = lines.length * lineH;
        const startY = slot.labelBox.y + (slot.labelBox.height - totalTextH) / 2 + (lineH / 2);

        lines.forEach((line, lineIdx) => {
          ctx.font = this.getFontForText(line, specs, layout.memeType === 'comparison' ? 36 : 33);
          let color = specs.secondaryTextColor || '#FFFFFF';
          if (lineIdx === 0 && (layout.memeType === 'comparison' || /\d+/.test(line))) {
            color = specs.primaryTextColor || '#FFE500';
          }
          this.drawMemeText(ctx, line, slot.labelBox!.x + (slot.labelBox!.width / 2), startY + (lineIdx * lineH), {
            fillColor: color,
            strokeWidth: specs.outlineThickness || 8,
            align: 'center'
          });
        });
      }
    }

    // 3. Draw Header Banner if present
    if (layout.headerBox && content.headline) {
      ctx.fillStyle = specs.headerBgColor || '#000000';
      ctx.fillRect(layout.headerBox.x, layout.headerBox.y, layout.headerBox.width, layout.headerBox.height);

      const headerText = content.headline.trim();
      const headerBox = layout.headerTextBox || layout.headerBox;

      ctx.font = this.getFontForText(headerText, specs, 48);
      const headerLines = this.wrapText(ctx, headerText, headerBox.width);

      const lineSpacing = 52;
      const totalH = headerLines.length * lineSpacing;
      const startY = headerBox.y + (headerBox.height - totalH) / 2 + (lineSpacing / 2);

      headerLines.forEach((line, idx) => {
        ctx.font = this.getFontForText(line, specs, 48);
        const color = idx === 0 ? (specs.headerTextColor || specs.primaryTextColor || '#FFE500') : (specs.secondaryTextColor || '#FFFFFF');
        this.drawMemeText(ctx, line, width / 2, startY + (idx * lineSpacing), {
          fillColor: color,
          strokeWidth: specs.outlineThickness || 8,
          align: 'center'
        });
      });
      // Thin black divider line removed: images join cleanly without borders
    }

    // 4. Draw Overlaid Statement / Quote
    if (layout.statementOverlayBox && content.statement) {
      const stmtText = content.statement.trim();
      ctx.font = this.getFontForText(stmtText, specs, 38);
      const maxW = layout.statementOverlayBox.width;
      const stmtLines = this.wrapText(ctx, stmtText, maxW);

      const lineH = 46;
      const startY = layout.statementOverlayBox.y + (layout.statementOverlayBox.height - (stmtLines.length * lineH)) / 2 + (lineH / 2);

      stmtLines.forEach((line, idx) => {
        ctx.font = this.getFontForText(line, specs, 38);
        const isAttribution = line.startsWith('-') || line.includes('PRODUCER') || idx === 0;
        const color = isAttribution ? (specs.primaryTextColor || '#FFE500') : (specs.secondaryTextColor || '#FFFFFF');
        this.drawMemeText(ctx, line, width / 2, startY + (idx * lineH), {
          fillColor: color,
          strokeWidth: specs.outlineThickness || 8,
          align: 'center'
        });
      });
    }

    // 5. Draw Overlaid Bullet Points (Movie Review / Censor Report text)
    if (layout.bulletOverlayBox && content.bulletPoints && content.bulletPoints.length > 0) {
      const bullets = content.bulletPoints;
      const bulletBox = layout.bulletOverlayBox;

      const lineH = bullets.length <= 4 ? 54 : Math.min(50, Math.floor(bulletBox.height / bullets.length));
      const totalH = bullets.length * lineH;
      const startY = bulletBox.y + (bulletBox.height - totalH) / 2 + (lineH / 2);

      bullets.forEach((pt, idx) => {
        const text = pt.trim();
        // Consistently apply user selected font for each review line
        ctx.font = this.getFontForText(text, specs, 42);

        // Alternating bold yellow (#FFE500) and crisp white (#FFFFFF)
        const color = idx % 2 === 0
          ? (specs.primaryTextColor || '#FFE500')
          : (specs.secondaryTextColor || '#FFFFFF');

        this.drawMemeText(ctx, text, width / 2, startY + (idx * lineH), {
          fillColor: color,
          strokeWidth: specs.outlineThickness || 8,
          align: 'center'
        });
      });
    }

    // 6. Draw Reaction Image (Intelligent Cinematic 16:9 Landscape Framing)
    if (layout.reactionBox && assets.reactionImage && assets.reactionImage.path && fs.existsSync(assets.reactionImage.path)) {
      try {
        const reactionImg = await loadImage(assets.reactionImage.path);
        this.drawIntelligentCoverImage(ctx, reactionImg, layout.reactionBox, {
          isReaction: true,
          anchorX: 0.5,
          anchorY: 0.36 // Eyeline level for movie scene
        });
      } catch (err: any) {
        console.warn('Could not load reaction image:', err.message);
      }
      // Thin black divider line removed: reaction joins cleanly with subject images
    }

    // 7. Draw Reaction Context Tag
    if (layout.reactionTagBox && content.reactionContext) {
      const tagText = content.reactionContext.trim();
      ctx.font = this.getFontForText(tagText, specs, 34);
      this.drawMemeText(ctx, tagText, width / 2, layout.reactionTagBox.y + (layout.reactionTagBox.height / 2), {
        fillColor: specs.primaryTextColor || '#FFE500',
        strokeWidth: specs.outlineThickness || 7,
        strokeColor: specs.outlineColor || '#000000',
        shadowColor: 'rgba(0, 0, 0, 0.95)',
        shadowBlur: specs.shadowBlur !== undefined ? specs.shadowBlur : 8,
        align: 'center'
      });
    }

    // 8. Draw Telugu Punchline
    if (layout.punchlineBox && content.punchline) {
      const punchText = content.punchline.trim();
      ctx.font = this.getFontForText(punchText, specs, 46);
      const punchLines = this.wrapText(ctx, punchText, layout.punchlineBox.width);

      const lineH = 54;
      const totalH = punchLines.length * lineH;
      const startY = layout.punchlineBox.y + (layout.punchlineBox.height - totalH) / 2 + (lineH / 2);

      punchLines.forEach((line, idx) => {
        ctx.font = this.getFontForText(line, specs, 46);
        const color = idx === 0 ? (specs.primaryTextColor || '#FFE500') : (specs.secondaryTextColor || '#FFFFFF');
        this.drawMemeText(ctx, line, width / 2, startY + (idx * lineH), {
          fillColor: color,
          strokeWidth: specs.outlineThickness || 8,
          strokeColor: specs.outlineColor || '#000000',
          shadowColor: 'rgba(0, 0, 0, 0.95)',
          shadowBlur: specs.shadowBlur !== undefined ? specs.shadowBlur : 8,
          align: 'center'
        });
      });
    }

    return {
      pngBuffer: canvas.toBuffer('image/png'),
      jpegBuffer: canvas.toBuffer('image/jpeg'),
      width,
      height
    };
  }
}
