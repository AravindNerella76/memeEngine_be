/**
 * Turns raw vision-model JSON into a trusted ReferenceAnalysis.
 * Everything is type-checked, length-capped and clamped; inconsistent structure is rebuilt from
 * the slot boxes; watermarks/handles are removed from text that may be rendered or searched.
 */
import { ImageArrangementMode, MemeType } from '../types/meme.types';
import { codesMatch } from '../vision/vision-image-prep';
import { VisionOutputError } from '../vision/vision-cli.runner';
import {
  AnalysisBox,
  CONTEXT_EVIDENCE,
  ContextEvidence,
  EVIDENCE_KINDS,
  IdentificationEvidence,
  IMAGE_TYPES,
  LegacyViralAnalysis,
  MEME_FORMATS,
  MemeFormat,
  Orientation,
  ReferenceAnalysis,
  ReferenceImageType,
  ReferenceSlot,
  SUBJECT_KINDS,
  SubjectKind
} from './reference-analysis.types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const LEGACY_TYPES: MemeType[] = ['movie_update', 'facts_collage', 'comparison', 'trending_news', 'custom'];
const MAX_SLOTS = 8;

/** Removes control characters, normalises whitespace per line, caps length. Keeps ZWNJ/ZWJ (Telugu). */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const lines = v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
  let s = lines.join('\n').trim();
  if (!s) return null;
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    s = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
  }
  return s || null;
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

const HANDLE_RE = /(^|\s)@[\w.]{2,40}/g;
const URLISH_RE = /(https?:\/\/|www\.|\.com\b|\.in\b|instagram|facebook|youtube\.com|t\.me\/)/i;

function foldForCompare(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function makeWatermarkFilter(watermarks: string[]) {
  const marks = watermarks.map(foldForCompare).filter(m => m.length >= 3);
  return (s: string | null): string | null => {
    if (!s) return null;
    const stripped = cleanText(s.replace(HANDLE_RE, ' '), 400);
    if (!stripped) return null;
    if (URLISH_RE.test(stripped)) return null;
    const f = foldForCompare(stripped);
    if (marks.some(m => f === m || (f.length <= m.length + 4 && f.includes(m)))) return null;
    return stripped;
  };
}

function normBox(v: unknown): AnalysisBox | null {
  if (!isObj(v)) return null;
  const rawVals = [v.x, v.y, v.width, v.height].map(n => (typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN));
  if (!rawVals.every(Number.isFinite) || rawVals.some(n => n < 0)) return null;
  // Some answers use percentages (0-100) instead of fractions: rescale when clearly not fractions.
  const max = Math.max(...rawVals);
  const scale = max > 1.0001 && max <= 100 ? 0.01 : 1;
  if (max > 100) return null;
  let [x, y, w, h] = rawVals.map(n => Math.min(1, n * scale));
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < 0.03 || h < 0.03) return null;
  x = Math.round(x * 1000) / 1000;
  y = Math.round(y * 1000) / 1000;
  return { x, y, width: Math.round(w * 1000) / 1000, height: Math.round(h * 1000) / 1000 };
}

function orientationOf(box: AnalysisBox, contentAspect: number): Orientation {
  const a = (box.width * contentAspect) / box.height;
  if (a > 1.15) return 'landscape';
  if (a < 0.87) return 'portrait';
  return 'square';
}

function legacyFromFormat(f: MemeFormat): MemeType {
  switch (f) {
    case 'comparison':
    case 'celebrity_comparison':
    case 'stacked_comparison':
      return 'comparison';
    case 'movie_update':
      return 'movie_update';
    case 'news_update':
      return 'trending_news';
    case 'facts_collage':
      return 'facts_collage';
    default:
      return 'custom';
  }
}

/** Groups slots into rows by vertical position and orders them left-to-right. */
function rebuildRows(slots: ReferenceSlot[]): ReferenceSlot[] {
  if (slots.length === 0) return slots;
  const sorted = [...slots].sort((a, b) => a.bbox.y + a.bbox.height / 2 - (b.bbox.y + b.bbox.height / 2));
  const heights = sorted.map(s => s.bbox.height).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];
  const rows: ReferenceSlot[][] = [];
  for (const s of sorted) {
    const cy = s.bbox.y + s.bbox.height / 2;
    const row = rows.find(r => {
      const rcy = r.reduce((acc, x) => acc + x.bbox.y + x.bbox.height / 2, 0) / r.length;
      return Math.abs(rcy - cy) < medianH * 0.5;
    });
    if (row) row.push(s);
    else rows.push([s]);
  }
  rows.sort((a, b) => a[0].bbox.y - b[0].bbox.y);
  const out: ReferenceSlot[] = [];
  rows.forEach((r, ri) => {
    r.sort((a, b) => a.bbox.x - b.bbox.x);
    r.forEach((s, ci) => out.push({ ...s, row: ri, column: ci }));
  });
  return out.map((s, i) => ({ ...s, index: i, slotId: `s${i + 1}` }));
}

export interface NormalizeOptions {
  expectedCode: string;
  /** Pixel aspect (width / height) of the meme area that was shown to the model. */
  contentAspect: number;
}

export function normalizeReferenceAnalysis(raw: unknown, opts: NormalizeOptions): ReferenceAnalysis {
  if (!isObj(raw)) throw new VisionOutputError('Reference analysis is not a JSON object');
  if (!codesMatch(opts.expectedCode, raw.imageCode)) {
    throw new VisionOutputError(
      'The vision model did not report the verification code drawn on the image, so it may not have seen the image. The answer was discarded.',
      'UNSEEN_IMAGE'
    );
  }

  const warnings = strList(raw.warnings, 10, 220);
  const watermarks = strList(raw.watermarks, 8, 80);
  const wm = makeWatermarkFilter(watermarks);

  const memeFormat = oneOf(raw.memeFormat, MEME_FORMATS, 'other');
  const legacyMemeType = oneOf(raw.legacyMemeType, LEGACY_TYPES, legacyFromFormat(memeFormat));

  const headerRaw = isObj(raw.header) ? raw.header : {};
  const headerText = wm(cleanText(headerRaw.text, 240));
  const header = {
    present: Boolean(headerText) && headerRaw.present !== false,
    text: headerText,
    heightFraction: clamp(headerRaw.heightFraction, 0, 0.35, 0)
  };
  if (!header.present) header.text = null;

  const ov = isObj(raw.overlayText) ? raw.overlayText : {};
  const overlayText = {
    statement: wm(cleanText(ov.statement, 700)),
    bulletPoints: strList(ov.bulletPoints, 8, 140).map(b => wm(b)).filter((b): b is string => Boolean(b)),
    attribution: wm(cleanText(ov.attribution, 140))
  };

  const rawSlots = Array.isArray(raw.slots) ? raw.slots.slice(0, 16) : [];
  let slots: ReferenceSlot[] = [];
  rawSlots.forEach((s, i) => {
    if (!isObj(s)) return;
    const bbox = normBox(s.bbox);
    if (!bbox) return;
    const ctx = isObj(s.context) ? s.context : {};
    const identifiedName = wm(cleanText(s.identifiedName, 80));
    const orientation = oneOf<Orientation>(s.orientation, ['portrait', 'landscape', 'square'], orientationOf(bbox, opts.contentAspect));
    slots.push({
      slotId: `s${i + 1}`,
      index: i,
      row: Number.isInteger(s.row) ? (s.row as number) : 0,
      column: Number.isInteger(s.column) ? (s.column as number) : 0,
      bbox,
      subjectKind: oneOf<SubjectKind>(s.subjectKind, SUBJECT_KINDS, 'other'),
      nameAsWritten: wm(cleanText(s.nameAsWritten, 80)),
      identifiedName,
      characterName: wm(cleanText(s.characterName, 80)),
      identificationEvidence: oneOf<IdentificationEvidence>(s.identificationEvidence, EVIDENCE_KINDS, 'none'),
      identityConfidence: identifiedName ? clamp(s.identityConfidence, 0, 1, 0) : 0,
      context: {
        movieTitle: wm(cleanText(ctx.movieTitle, 100)),
        eventName: wm(cleanText(ctx.eventName, 100)),
        otherContext: wm(cleanText(ctx.otherContext, 140)),
        evidence: oneOf<ContextEvidence>(ctx.evidence, CONTEXT_EVIDENCE, 'none')
      },
      imageType: oneOf<ReferenceImageType>(s.imageType, IMAGE_TYPES, 'other'),
      visualPurpose: cleanText(s.visualPurpose, 120) || `subject ${i + 1}`,
      orientation,
      label: wm(cleanText(s.label, 160)),
      visualCharacteristics: strList(s.visualCharacteristics, 6, 60),
      searchTerms: strList(s.searchTerms, 4, 80).filter(t => !URLISH_RE.test(t) && !t.includes('@'))
    });
  });

  // Drop near-duplicate boxes (models sometimes repeat a slot), keep reading order, cap count.
  slots = slots.filter((s, i) => !slots.slice(0, i).some(o => Math.abs(o.bbox.x - s.bbox.x) < 0.02 && Math.abs(o.bbox.y - s.bbox.y) < 0.02 && Math.abs(o.bbox.width - s.bbox.width) < 0.03));
  if (slots.length > MAX_SLOTS) {
    warnings.push(`Reference had ${slots.length} image sections; only the first ${MAX_SLOTS} are used.`);
    slots = slots.slice(0, MAX_SLOTS);
  }
  slots = rebuildRows(slots);

  const columnsPerRow: number[] = [];
  const rowHeights: number[] = [];
  for (const s of slots) {
    columnsPerRow[s.row] = (columnsPerRow[s.row] || 0) + 1;
    rowHeights[s.row] = Math.max(rowHeights[s.row] || 0, s.bbox.height);
  }

  const rp = isObj(raw.reactionPanel) ? raw.reactionPanel : {};
  const pal = isObj(raw.palette) ? raw.palette : {};
  const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v.trim()) ? v.trim().toUpperCase() : null);

  const injection = warnings.some(w => /instruction|ignore (all )?previous|prompt|read (a|the) file|use (a|your) tool|search for/i.test(w));

  return {
    schemaVersion: 2,
    memeFormat,
    legacyMemeType,
    summary: cleanText(raw.summary, 300) || '',
    header,
    overlayText,
    grid: { rows: columnsPerRow.length, columnsPerRow, rowHeightFractions: rowHeights.map(h => Math.round(h * 1000) / 1000) },
    slots,
    reactionPanel: { present: rp.present !== false, heightFraction: clamp(rp.heightFraction, 0, 0.65, 0.35) },
    palette: {
      background: hex(pal.background),
      accents: (Array.isArray(pal.accents) ? pal.accents : []).map(hex).filter((c): c is string => Boolean(c)).slice(0, 5)
    },
    watermarks,
    warnings,
    suspectedPromptInjection: injection,
    imageCodeVerified: true
  };
}

export function arrangementFromAnalysis(a: Pick<ReferenceAnalysis, 'slots' | 'grid'>): ImageArrangementMode {
  const n = a.slots.length;
  const cols = a.grid.columnsPerRow;
  if (n <= 1) return 'single_hero';
  if (cols.length === 1) {
    if (n === 2) return 'side_by_side';
    if (n === 3) return 'columns_3';
    if (n === 4) return 'columns_4';
    return 'custom_grid';
  }
  if (cols.length === 2 && cols[0] === 2 && cols[1] === 2) return 'grid_2x2';
  if (cols.every(c => c === 1)) return 'stacked_rows';
  return 'custom_grid';
}

/** Projection to the original analysis shape, so older code paths keep working. */
export function toLegacyAnalysis(a: ReferenceAnalysis): LegacyViralAnalysis {
  const labels = a.slots.map(s => s.label || '');
  return {
    memeType: a.legacyMemeType,
    arrangement: arrangementFromAnalysis(a),
    subjectCount: a.slots.length,
    subjects: a.slots.map((s, i) => s.identifiedName || s.nameAsWritten || s.characterName || `Subject ${i + 1}`),
    headline: a.header.present && a.header.text ? a.header.text : undefined,
    bulletPoints: a.overlayText.bulletPoints.length ? a.overlayText.bulletPoints : undefined,
    statement: a.overlayText.statement || undefined,
    itemLabels: labels.some(Boolean) ? labels : undefined
  };
}
