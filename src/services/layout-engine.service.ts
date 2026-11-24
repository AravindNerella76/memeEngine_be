import { Injectable } from '@nestjs/common';
import {
  MemeType,
  ImageArrangementMode,
  LayoutConfiguration,
  BoundingBox,
  CanvasDimensionPreset,
  GridSpec
} from '../types/meme.types';
import type { LayoutStyle } from '../design/render-style';
import { reactionPanelHeight } from './reaction-framing';

const MIN_SLOT_PX = 140;
const clampW = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1);

/**
 * Validates a relative grid against the number of images: 1-4 rows, 1-4 slots per row, weights
 * clamped to [0.25, 4]. Returns null when it cannot describe `subjectCount` slots.
 */
export function sanitizeGrid(grid: GridSpec | undefined | null, subjectCount: number): GridSpec | null {
  if (!grid || !Array.isArray(grid.rows) || grid.rows.length < 1 || grid.rows.length > 4) return null;
  const rows = grid.rows.map(r => ({
    heightWeight: clampW(r?.heightWeight),
    slots: Array.isArray(r?.slots) ? r.slots.slice(0, 4).map(sl => ({ widthWeight: clampW(sl?.widthWeight) })) : []
  }));
  if (rows.some(r => r.slots.length < 1)) return null;
  const total = rows.reduce((a, r) => a + r.slots.length, 0);
  if (total !== subjectCount || total > 8) return null;
  return { rows };
}

/** Same structure with equal sizes. */
export function equalizeGrid(grid: GridSpec): GridSpec {
  return { rows: grid.rows.map(r => ({ heightWeight: 1, slots: r.slots.map(() => ({ widthWeight: 1 })) })) };
}

export function gridIsUniform(grid: GridSpec): boolean {
  const hs = grid.rows.map(r => r.heightWeight);
  return hs.every(h => Math.abs(h - hs[0]) < 1e-6) && grid.rows.every(r => r.slots.every(sl => Math.abs(sl.widthWeight - r.slots[0].widthWeight) < 1e-6));
}

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
  grid?: GridSpec;                 // Relative row/slot sizes for 'custom_grid' or unequal standard layouts
  reactionAspectRatio?: number;    // Detected width / height of reaction image (e.g. 1.78 for 16:9)
  /**
   * Geometry from the meme's settings snapshot (safe margin, gaps, punchline share, minimum slot
   * size, default header share). Omitted for memes made before Settings: the original values apply.
   */
  style?: LayoutStyle;
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
    const height = params.height || (params.canvasPreset === 'square_1_1' ? 1080 : params.canvasPreset === 'story_9_16' ? 1920 : 1350);
    const st = params.style;
    const safe = Math.max(0, st?.safeMargin ?? 0);
    const sectionGap = Math.max(0, Math.round(st?.sectionGap ?? 0));
    const imageGap = Math.max(0, Math.round(st?.imageGap ?? 0));
    const minSlot = st?.minSlotSize ?? MIN_SLOT_PX;
    /** Horizontal text inset: the layout's own inset, or the safe margin when that is larger. */
    const inset = (own: number) => Math.max(own, safe);
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
      const headerRatio = params.headerHeightRatio || st?.defaultHeaderRatio || (height >= 1350 ? 0.082 : 0.092);
      const headerH = Math.round(height * headerRatio);
      headerBox = { x: 0, y: 0, width, height: headerH };
      const hx = inset(20);
      headerTextBox = { x: hx, y: 8, width: width - 2 * hx, height: headerH - 16 };
      currentY += headerH + sectionGap;
    }

    // 2. Calculate Reaction Box (Adaptive to 16:9 / Landscape Aspect Ratio)
    let reactionBox: BoundingBox | null = null;
    let reactionTagBox: BoundingBox | null = null;
    let punchlineBox: BoundingBox | null = null;

    // Determine reaction height based on detected cinematic aspect ratio
    // For 16:9 on 1080px canvas: 1080 / 1.778 = 607px.
    // We clamp between 460px and 560px on a 1350px canvas to leave ample space for subjects
    // from the plan's ratio, else the picture's own shape clamped to 34-42% of the canvas height (shared with the studio's live preview)
    const computedReactionH = reactionPanelHeight(width, height, reactionAspectRatio, params.reactionHeightRatio);

    const reactionY = height - computedReactionH;
    reactionBox = { x: 0, y: reactionY, width, height: computedReactionH };

    if (hasReactionContext) {
      const tx = inset(40);
      reactionTagBox = {
        x: tx,
        y: reactionY + 14,
        width: width - 2 * tx,
        height: 48
      };
    }

    if (hasPunchline) {
      // Share of the reaction panel (0.38 originally); the 145 px cap scales with it.
      const share = st?.punchlineRatio ?? 0.38;
      const punchlineH = Math.min(Math.round((145 * share) / 0.38), Math.round(computedReactionH * share));
      const px = inset(30);
      punchlineBox = {
        x: px,
        y: reactionY + computedReactionH - punchlineH - 8,
        width: width - 2 * px,
        height: punchlineH
      };
    }

    // 3. Subject Section (Remaining height between header and reaction)
    const subjectSectionH = reactionY - sectionGap - currentY;
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
      } else if (memeType === 'trending_news' || memeType === 'movie_update') {
        // 3 pictures side by side, 4 in a 2 x 2 grid (four thin columns crop every picture to a sliver)
        arrangement = subjectCount === 1 ? 'single_hero' : subjectCount === 2 ? 'side_by_side' : subjectCount === 3 ? 'columns_3' : subjectCount === 4 ? 'grid_2x2' : 'stacked_rows';
      } else {
        arrangement = subjectCount === 1 ? 'single_hero' : (subjectCount === 2 ? 'side_by_side' : 'grid_2x2');
      }
    }

    // 5. Calculate Subject Slots with Seamless Joining (0 gaps, zero divider lines)
    let subjectSlots: CalculatedSlot[] = [];
    const gap = 0;

    const grid = sanitizeGrid(params.grid, subjectCount);
    if (arrangement === 'custom_grid' && !grid) {
      // No usable grid: fall back to the closest standard arrangement
      arrangement = subjectCount <= 1 ? 'single_hero' : subjectCount === 2 ? 'side_by_side' : subjectCount === 3 ? 'columns_3' : subjectCount === 4 ? 'grid_2x2' : 'stacked_rows';
    }

    if (grid && (arrangement === 'custom_grid' || !gridIsUniform(grid))) {
      subjectSlots = this.gridSlots(subjectSectionBox, grid);
      if (subjectSlots.some(sl => sl.box.width < minSlot || sl.box.height < minSlot)) {
        subjectSlots = this.gridSlots(subjectSectionBox, equalizeGrid(grid));
      }
      if (arrangement !== 'custom_grid' && !gridIsUniform(grid)) arrangement = 'custom_grid';
    } else if (arrangement === 'stacked_rows') {
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

      // captions in the house style (rev 3) are big, like the page's own: give them the room (older memes keep 50 px)
      const capH = (st?.rev ?? 0) >= 3 ? 78 : 50;
      for (let i = 0; i < Math.min(subjectCount, 4); i++) {
        const p = positions[i];
        subjectSlots.push({
          index: i,
          role: `subject_item_${i + 1}`,
          box: { x: p.x, y: p.y, width: p.w, height: p.h },
          labelBox: {
            x: p.x + 10,
            y: p.y + p.h - capH - 8,
            width: p.w - 20,
            height: capH
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

    // Gaps between subject images (the background colour shows through) and the safe margin
    if (imageGap > 0 || safe > 0) subjectSlots = subjectSlots.map(sl => this.applySlotSpacing(sl, subjectSectionBox, imageGap, safe, width));

    // 6. Statement and Bullet Point Overlays
    let statementOverlayBox: BoundingBox | null = null;
    let bulletOverlayBox: BoundingBox | null = null;

    if (hasStatement) {
      const overlayH = Math.min(230, Math.round(subjectSectionBox.height * 0.42));
      const ox = inset(40);
      statementOverlayBox = {
        x: ox,
        y: subjectSectionBox.y + subjectSectionBox.height - overlayH - 15,
        width: width - 2 * ox,
        height: overlayH
      };
    }

    if (hasBulletPoints) {
      const bulletH = Math.min(240, Math.round(subjectSectionBox.height * 0.44));
      const bx = inset(40);
      bulletOverlayBox = {
        x: bx,
        y: subjectSectionBox.y + subjectSectionBox.height - bulletH - 15,
        width: width - 2 * bx,
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

  /**
   * Shrinks a slot at its inner edges so neighbouring images are `gap` px apart (outer edges stay
   * flush with the section), and keeps its label at least `safe` px from the canvas sides.
   */
  private applySlotSpacing(sl: CalculatedSlot, section: BoundingBox, gap: number, safe: number, canvasWidth: number): CalculatedSlot {
    const b = sl.box;
    const half = Math.floor(gap / 2);
    const left = b.x > section.x ? half : 0;
    const right = b.x + b.width < section.x + section.width ? gap - half : 0;
    const top = b.y > section.y ? half : 0;
    const bottom = b.y + b.height < section.y + section.height ? gap - half : 0;
    const box = { x: b.x + left, y: b.y + top, width: Math.max(1, b.width - left - right), height: Math.max(1, b.height - top - bottom) };
    let labelBox = sl.labelBox;
    if (labelBox) {
      labelBox = { x: labelBox.x + left, y: labelBox.y - bottom, width: labelBox.width - left - right, height: labelBox.height };
      if (labelBox.x < safe) {
        labelBox.width -= safe - labelBox.x;
        labelBox.x = safe;
      }
      if (labelBox.x + labelBox.width > canvasWidth - safe) labelBox.width = canvasWidth - safe - labelBox.x;
      labelBox.width = Math.max(40, labelBox.width);
    }
    return { ...sl, box, labelBox, targetAspectRatio: box.width / box.height };
  }

  /** Deterministic tiling of the subject section from relative weights (exact, no gaps, no overlaps). */
  gridSlots(section: BoundingBox, grid: GridSpec): CalculatedSlot[] {
    const slots: CalculatedSlot[] = [];
    const totalH = grid.rows.reduce((a, r) => a + r.heightWeight, 0);
    let y = section.y;
    let index = 0;
    grid.rows.forEach((row, ri) => {
      const h = ri === grid.rows.length - 1 ? section.y + section.height - y : Math.round((section.height * row.heightWeight) / totalH);
      const totalW = row.slots.reduce((a, sl) => a + sl.widthWeight, 0);
      let x = section.x;
      row.slots.forEach((sl, ci) => {
        const w = ci === row.slots.length - 1 ? section.x + section.width - x : Math.round((section.width * sl.widthWeight) / totalW);
        const lh = Math.min(110, Math.max(50, Math.round(h * 0.2)));
        slots.push({
          index: index++,
          role: `subject_r${ri + 1}c${ci + 1}`,
          box: { x, y, width: w, height: h },
          labelBox: { x: x + 8, y: y + h - lh - 8, width: Math.max(40, w - 16), height: lh },
          targetAspectRatio: w / h
        });
        x += w;
      });
      y += h;
    });
    return slots;
  }
}
