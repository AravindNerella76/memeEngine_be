/**
 * Turns the analysed reference structure into a deterministic layout request. The AI only
 * describes relative structure (rows, relative sizes); the layout engine computes every pixel.
 */
import { GridSpec } from '../types/meme.types';
import { ReferenceAnalysis } from './reference-analysis.types';

const SNAP = 0.12; // relative differences below 12% are treated as "equal" (AI box noise)

function snapWeights(values: number[]): number[] {
  if (!values.length) return values;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return values.map(() => 1);
  const rel = values.map(v => v / mean);
  if (rel.every(r => Math.abs(r - 1) <= SNAP)) return values.map(() => 1);
  return rel.map(r => Math.round(Math.min(4, Math.max(0.25, r)) * 100) / 100);
}

/** Relative grid from the slot boxes; undefined when all slots are equal (standard layouts apply). */
export function deriveGridFromAnalysis(a: ReferenceAnalysis): GridSpec | undefined {
  if (a.slots.length < 2) return undefined;
  const rows: { heights: number[]; widths: number[] }[] = [];
  for (const s of a.slots) {
    rows[s.row] = rows[s.row] || { heights: [], widths: [] };
    rows[s.row].heights.push(s.bbox.height);
    rows[s.row].widths.push(s.bbox.width);
  }
  const compact = rows.filter(Boolean);
  const rowHeights = snapWeights(compact.map(r => r.heights.reduce((x, y) => x + y, 0) / r.heights.length));
  const grid: GridSpec = {
    rows: compact.map((r, i) => ({ heightWeight: rowHeights[i], slots: snapWeights(r.widths).map(w => ({ widthWeight: w })) }))
  };
  const uniform = grid.rows.every(r => r.heightWeight === 1 && r.slots.every(sl => sl.widthWeight === 1));
  const standard = compact.length === 1 || (compact.length === 2 && compact.every(r => r.widths.length === 2)) || compact.every(r => r.widths.length === 1);
  return uniform && standard ? undefined : grid;
}

/** Header height preference from the reference (bounded); the renderer can still grow it to fit text. */
export function headerRatioFromAnalysis(a: ReferenceAnalysis, profileRatio: number): number {
  if (!a.header.present) return profileRatio;
  const ref = a.header.heightFraction;
  return Math.round(Math.max(profileRatio, Math.min(0.16, ref || 0)) * 1000) / 1000;
}

/** Reaction panel height preference from the reference (bounded), or undefined for the default. */
export function reactionRatioFromAnalysis(a: ReferenceAnalysis): number | undefined {
  if (!a.reactionPanel.present) return undefined;
  const f = a.reactionPanel.heightFraction;
  if (!(f >= 0.25 && f <= 0.55)) return undefined;
  return Math.round(Math.min(0.46, Math.max(0.3, f)) * 1000) / 1000;
}
