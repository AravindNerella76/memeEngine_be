import { Injectable } from '@nestjs/common';
import {
  MemeType,
  ImageArrangementMode,
  LayoutConfiguration,
  BoundingBox,
  CanvasDimensionPreset
} from '../types/meme.types';

export interface CalculatedSlot {
  index: number;
  role: string;
  box: BoundingBox;
  labelBox?: BoundingBox;
  targetAspectRatio: number; // width / height
}

export interface ComputedMemeLayout {
  canvasWidth: number;
  canvasHeight: number;
  memeType: MemeType;
  arrangement: ImageArrangementMode;

  headerBox: BoundingBox | null;
  headerTextBox: BoundingBox | null;

  subjectSectionBox: BoundingBox;
  subjectSlots: CalculatedSlot[];

  statementOverlayBox: BoundingBox | null;
  bulletOverlayBox: BoundingBox | null;

  reactionBox: BoundingBox | null;
  reactionTagBox: BoundingBox | null;
  punchlineBox: BoundingBox | null;
}

export interface LayoutCalculationParams {
  memeType: MemeType;
  canvasPreset?: CanvasDimensionPreset;
  width?: number;
  height?: number;
  subjectCount: number;
  hasHeader?: boolean;
  hasStatement?: boolean;
  hasBulletPoints?: boolean;
  hasReactionContext?: boolean;
  hasPunchline?: boolean;
  arrangementPreference?: ImageArrangementMode;
  reactionHeightRatio?: number;
  headerHeightRatio?: number;
  subjectAspectRatios?: number[];  // Detected width / height of subject images (e.g. 0.75 for 3:4, 0.67 for 2:3)
  reactionAspectRatio?: number;    // Detected width / height of reaction image (e.g. 1.78 for 16:9)
}

@Injectable()
export class LayoutEngineService {
  /**
   * Dynamically calculates layout bounding boxes adapting to source aspect ratios:
   * - Subject images: optimized for 3:4 or 2:3 portrait assets
   * - Reaction images: optimized for 16:9 or wider landscape cinematic frames
   */
  calculateLayout(params: LayoutCalculationParams): ComputedMemeLayout {
    const width = params.width || 1080;
    const height = params.height || (params.canvasPreset === 'square_1_1' ? 1080 : 1350);
    const {
      memeType,
      subjectCount,
      hasHeader = true,
      hasStatement = false,
      hasBulletPoints = false,
      hasReactionContext = false,
      hasPunchline = true,
      reactionAspectRatio = 16 / 9 // Default to 16:9 landscape cinematic
    } = params;

    // 1. Calculate Header Box
    let currentY = 0;
    let headerBox: BoundingBox | null = null;
    let headerTextBox: BoundingBox | null = null;

    if (hasHeader) {
      const headerRatio = params.headerHeightRatio || (height >= 1350 ? 0.082 : 0.092);
      const headerH = Math.round(height * headerRatio);
      headerBox = { x: 0, y: 0, width, height: headerH };
      headerTextBox = { x: 20, y: 8, width: width - 40, height: headerH - 16 };
      currentY += headerH;
    }

    // 2. Calculate Reaction Box (Adaptive to 16:9 / Landscape Aspect Ratio)
    let reactionBox: BoundingBox | null = null;
    let reactionTagBox: BoundingBox | null = null;
    let punchlineBox: BoundingBox | null = null;

    // Determine reaction height based on detected cinematic aspect ratio
    // For 16:9 on 1080px canvas: 1080 / 1.778 = 607px.
    // We clamp between 460px and 560px on a 1350px canvas to leave ample space for subjects
    let computedReactionH: number;
    if (params.reactionHeightRatio) {
      computedReactionH = Math.round(height * params.reactionHeightRatio);
    } else {
      // Natural cinematic adaptation
      const naturalReactionH = Math.round(width / Math.max(1.33, reactionAspectRatio));
      // Clamp between 34% and 42% of canvas height
      const minReactionH = Math.round(height * 0.34);
      const maxReactionH = Math.round(height * 0.42);
      computedReactionH = Math.min(maxReactionH, Math.max(minReactionH, naturalReactionH));
    }

    const reactionY = height - computedReactionH;
    reactionBox = { x: 0, y: reactionY, width, height: computedReactionH };

    if (hasReactionContext) {
      reactionTagBox = {
        x: 40,
        y: reactionY + 14,
        width: width - 80,
        height: 48
      };
    }

    if (hasPunchline) {
      const punchlineH = Math.min(145, Math.round(computedReactionH * 0.38));
      punchlineBox = {
        x: 30,
        y: reactionY + computedReactionH - punchlineH - 8,
        width: width - 60,
        height: punchlineH
      };
    }

    // 3. Subject Section (Remaining height between header and reaction)
    const subjectSectionH = reactionY - currentY;
    const subjectSectionBox: BoundingBox = {
      x: 0,
      y: currentY,
      width,
      height: subjectSectionH
    };

    // 4. Resolve Dynamic Image Arrangement
    let arrangement = params.arrangementPreference || 'auto';
    if (arrangement === 'auto') {
      if (memeType === 'facts_collage') {
        if (subjectCount >= 4) arrangement = 'grid_2x2';
        else if (subjectCount === 3) arrangement = 'columns_3';
        else if (subjectCount === 2) arrangement = 'side_by_side';
        else arrangement = 'single_hero';
      } else if (memeType === 'comparison') {
        if (subjectCount === 3) arrangement = 'columns_3';
        else if (subjectCount === 4) arrangement = 'columns_4';
        else if (subjectCount === 2) arrangement = 'side_by_side';
        else arrangement = 'stacked_rows';
      } else if (memeType === 'trending_news') {
        arrangement = subjectCount === 1 ? 'single_hero' : 'side_by_side';
      } else if (memeType === 'movie_update') {
        arrangement = subjectCount === 1 ? 'single_hero' : 'side_by_side';
      } else {
        arrangement = subjectCount === 1 ? 'single_hero' : (subjectCount === 2 ? 'side_by_side' : 'grid_2x2');
      }
    }

    // 5. Calculate Subject Slots with Seamless Joining (0 gaps, zero divider lines)
    const subjectSlots: CalculatedSlot[] = [];
    const gap = 0;

    if (arrangement === 'stacked_rows') {
      const rowCount = Math.max(subjectCount, 2);
      const rowH = Math.floor(subjectSectionBox.height / rowCount);
      for (let i = 0; i < rowCount; i++) {
        const y = subjectSectionBox.y + (i * rowH);
        const h = (i === rowCount - 1) ? (subjectSectionBox.y + subjectSectionBox.height - y) : rowH;
        subjectSlots.push({
          index: i,
          role: `subject_row_${i + 1}`,
          box: { x: 0, y, width: subjectSectionBox.width, height: h },
          labelBox: {
            x: 20,
            y: y + h - 65,
            width: subjectSectionBox.width - 40,
            height: 55
          },
          targetAspectRatio: subjectSectionBox.width / h
        });
      }
    } else if (arrangement === 'single_hero' || subjectCount === 1) {
      subjectSlots.push({
        index: 0,
        role: 'subject_primary',
        box: {
          x: 0,
          y: subjectSectionBox.y,
          width: subjectSectionBox.width,
          height: subjectSectionBox.height
        },
        labelBox: {
          x: 20,
          y: subjectSectionBox.y + subjectSectionBox.height - 65,
          width: subjectSectionBox.width - 40,
          height: 55
        },
        targetAspectRatio: subjectSectionBox.width / subjectSectionBox.height
      });
    } else if (arrangement === 'grid_2x2') {
      const colW = Math.floor(subjectSectionBox.width / 2);
      const rowH = Math.floor(subjectSectionBox.height / 2);
      const colW2 = subjectSectionBox.width - colW;
      const rowH2 = subjectSectionBox.height - rowH;
      const positions = [
        { x: 0, y: subjectSectionBox.y, w: colW, h: rowH },
        { x: colW, y: subjectSectionBox.y, w: colW2, h: rowH },
        { x: 0, y: subjectSectionBox.y + rowH, w: colW, h: rowH2 },
        { x: colW, y: subjectSectionBox.y + rowH, w: colW2, h: rowH2 }
      ];

      for (let i = 0; i < Math.min(subjectCount, 4); i++) {
        const p = positions[i];
        subjectSlots.push({
          index: i,
          role: `subject_item_${i + 1}`,
          box: { x: p.x, y: p.y, width: p.w, height: p.h },
          labelBox: {
            x: p.x + 10,
            y: p.y + p.h - 58,
            width: p.w - 20,
            height: 50
          },
          targetAspectRatio: p.w / p.h
        });
      }
    } else if (arrangement === 'columns_3' || subjectCount === 3) {
      const colW = Math.floor(subjectSectionBox.width / 3);
      for (let i = 0; i < 3; i++) {
        const x = i * colW;
        const w = (i === 2) ? (subjectSectionBox.width - (2 * colW)) : colW;
        subjectSlots.push({
          index: i,
          role: `subject_column_${i + 1}`,
          box: { x, y: subjectSectionBox.y, width: w, height: subjectSectionBox.height },
          labelBox: {
            x: x + 6,
            y: subjectSectionBox.y + subjectSectionBox.height - 100,
            width: w - 12,
            height: 90
          },
          targetAspectRatio: w / subjectSectionBox.height
        });
      }
    } else if (arrangement === 'columns_4' || subjectCount === 4) {
      const colW = Math.floor(subjectSectionBox.width / 4);
      for (let i = 0; i < 4; i++) {
        const x = i * colW;
        const w = (i === 3) ? (subjectSectionBox.width - (3 * colW)) : colW;
        subjectSlots.push({
          index: i,
          role: `subject_column_${i + 1}`,
          box: { x, y: subjectSectionBox.y, width: w, height: subjectSectionBox.height },
          labelBox: {
            x: x + 4,
            y: subjectSectionBox.y + subjectSectionBox.height - 85,
            width: w - 8,
            height: 75
          },
          targetAspectRatio: w / subjectSectionBox.height
        });
      }
    } else {
      // Default: side_by_side (2 portrait subjects: 3:4 or 2:3)
      // On 1080px canvas, colW = 540px. If subjectSectionH = 720px, slot aspect = 540/720 = 0.75 (~3:4 portrait)
      // Images join seamlessly in the center with 0 gap
      const colW = Math.floor(subjectSectionBox.width / 2);
      const colW2 = subjectSectionBox.width - colW;
      for (let i = 0; i < 2; i++) {
        const x = i === 0 ? 0 : colW;
        const w = i === 0 ? colW : colW2;
        subjectSlots.push({
          index: i,
          role: i === 0 ? 'subject_primary' : 'subject_secondary',
          box: { x, y: subjectSectionBox.y, width: w, height: subjectSectionBox.height },
          labelBox: {
            x: x + 15,
            y: subjectSectionBox.y + subjectSectionBox.height - 80,
            width: w - 30,
            height: 70
          },
          targetAspectRatio: w / subjectSectionBox.height
        });
      }
    }

    // 6. Statement and Bullet Point Overlays
    let statementOverlayBox: BoundingBox | null = null;
    let bulletOverlayBox: BoundingBox | null = null;

    if (hasStatement) {
      const overlayH = Math.min(230, Math.round(subjectSectionBox.height * 0.42));
      statementOverlayBox = {
        x: 40,
        y: subjectSectionBox.y + subjectSectionBox.height - overlayH - 15,
        width: width - 80,
        height: overlayH
      };
    }

    if (hasBulletPoints) {
      const bulletH = Math.min(240, Math.round(subjectSectionBox.height * 0.44));
      bulletOverlayBox = {
        x: 40,
        y: subjectSectionBox.y + subjectSectionBox.height - bulletH - 15,
        width: width - 80,
        height: bulletH
      };
    }

    return {
      canvasWidth: width,
      canvasHeight: height,
      memeType,
      arrangement,
      headerBox,
      headerTextBox,
      subjectSectionBox,
      subjectSlots,
      statementOverlayBox,
      bulletOverlayBox,
      reactionBox,
      reactionTagBox,
      punchlineBox
    };
  }
}
