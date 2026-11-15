/**
 * Framing of the reaction image inside the (wide) reaction panel.
 *
 * Reaction pictures are often TWO or THREE movie frames stacked on top of each other (speaker above, listener below).
 * A plain "cover" crop of a square stack keeps a middle band of it: one face cut off at the chin, the next at the eyes.
 * This module finds the frames of such a stack so the renderer can show them side by side, each cropped around its
 * face, and it turns any framing choice (automatic or the owner's own) into plain draw rectangles.
 *
 * Everything here is pure (pixels in, rectangles out), so the renderer and the live preview of the studio use the very
 * same decisions.
 */
import { createCanvas } from '@napi-rs/canvas';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point inside a picture, 0..1 from its top-left corner. */
export interface Focus {
  x: number;
  y: number;
}

/**
 * The owner's choice for one meme. Everything is optional: nothing set means "decide from the picture".
 *  - split:  false = use the picture as one scene even if it is a stack; true/undefined = show a detected stack side by side.
 *  - frame:  show only this frame (0 is the top one) of a stack, filling the whole panel.
 *  - fit:    "whole" = the entire picture inside the panel, on a softened copy of itself (nothing is cropped).
 *  - focus:  where to centre each shown part: one entry for a single scene or a chosen frame, one per frame when side by side.
 */
export interface ReactionFraming {
  split?: boolean;
  frame?: number;
  fit?: 'whole';
  focus?: Focus[];
}

export interface ReactionAnalysis {
  width: number;
  height: number;
  /** In source pixels. One entry (the whole picture) when it is a single scene. */
  frames: Rect[];
  stacked: boolean;
  /** A suggested centre for each frame (faces found by colour); 0.5/0.5 when nothing was found. */
  autoFocus: Focus[];
}

export interface PanelPart {
  /** What to cut out of the source picture. */
  src: Rect;
  /** Where it goes, relative to the panel's top-left corner. */
  dest: Rect;
}

export type PanelKind = 'split' | 'frame' | 'whole' | 'single';

export interface PanelPlan {
  parts: PanelPart[];
  /** split: frames side by side | frame: one chosen frame | whole: everything, uncropped | single: one cover crop */
  kind: PanelKind;
  split: boolean;
  /** Drawn first, filling the panel (the softened copy behind a whole picture). */
  background?: PanelPart;
  /** How much the most enlarged part is magnified (1 = pixel for pixel). Above about 2 the picture looks soft. */
  enlargement: number;
}

/** Pictures are looked at on a copy this wide: enough to see a seam or a face, fast enough to do on every render. */
const SAMPLE_WIDTH = 160;
/** A frame shorter than this share of the picture is not a frame (a stripe, a caption bar). */
const MIN_FRAME_SHARE = 0.18;
const MAX_FRAMES = 3;
/** Gap between side-by-side frames, in panel pixels at the 1080 px canvas. */
export const FRAME_GAP = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: unknown, fallback = 0.5) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : fallback);

interface Sample {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  /** source pixels per sample pixel */
  scale: number;
}

function sampleOf(img: any): Sample {
  const w = Math.min(SAMPLE_WIDTH, img.width);
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  return { w, h, data: x.getImageData(0, 0, w, h).data as Uint8ClampedArray, scale: img.width / w };
}

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

type SeamCandidate = { row: number; strength: number };

/**
 * Picks the seams that make sense together. A frame must be a real share of the picture, and stacks are almost always
 * two or three frames of equal height, so: seams near 1/3 and 2/3 mean three frames, one near the middle means two, and
 * only when nothing sits near an even split are unmistakable seams elsewhere used. Edge stripes (captions, bars) never count.
 */
function chooseSeams(all: SeamCandidate[], h: number): number[] {
  const edge = h * MIN_FRAME_SHARE;
  const inner = all.filter(c => c.row >= edge && c.row <= h - edge);
  const nearest = (target: number, tolerance: number) =>
    inner.filter(c => Math.abs(c.row / h - target) <= tolerance).sort((a, b) => b.strength - a.strength)[0];
  const t1 = nearest(1 / 3, 0.08);
  const t2 = nearest(2 / 3, 0.08);
  if (t1 && t2) return [t1.row, t2.row];
  const half = nearest(1 / 2, 0.12);
  if (half) return [half.row];
  const out: SeamCandidate[] = [];
  for (const c of inner.filter(c => c.strength >= 1000 || c.strength >= 25).sort((a, b) => b.strength - a.strength)) {
    const rows = [...out, c].map(x => x.row).sort((a, b) => a - b);
    const bounds = [0, ...rows, h];
    if (bounds.every((v, i) => i === 0 || v - bounds[i - 1] >= edge) && out.length < MAX_FRAMES - 1) out.push(c);
  }
  return out.map(c => c.row).sort((a, b) => a - b);
}

/**
 * Seams between stacked frames, as sample-row positions (the first row of the next frame).
 *  - a thin dark divider drawn between the frames: decisive wherever it is;
 *  - a hard cut with no divider: the picture stops being continuous from one row to the next, across most of the width
 *    and far more than anywhere around it. Frames are almost always stacked in equal heights, so a cut near an even split
 *    is believed on lighter evidence than one in an odd place (which could be a horizon or a table edge).
 */
function findSeams(s: Sample): number[] {
  const { w, h, data } = s;
  if (h < 12) return [];
  const rowMean = new Float32Array(h);
  const rowStd = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    let sq = 0;
    for (let x = 0; x < w; x++) {
      const l = luma(data, (y * w + x) * 4);
      sum += l;
      sq += l * l;
    }
    rowMean[y] = sum / w;
    rowStd[y] = Math.sqrt(Math.max(0, sq / w - (sum / w) ** 2));
  }

  // how far each row is from the next: average colour difference, and the share of columns that changed a lot
  const meanD = new Float32Array(h);
  const frac = new Float32Array(h);
  for (let y = 0; y < h - 1; y++) {
    let sum = 0;
    let big = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = ((y + 1) * w + x) * 4;
      const d = (Math.abs(data[j] - data[i]) + Math.abs(data[j + 1] - data[i + 1]) + Math.abs(data[j + 2] - data[i + 2])) / 3;
      sum += d;
      if (d > 22) big++;
    }
    meanD[y] = sum / w;
    frac[y] = big / w;
  }

  const seams: SeamCandidate[] = [];
  // dark dividers that do not touch the picture's edge (a black bar at the very top or bottom is letterboxing)
  let y = 0;
  while (y < h) {
    if (rowMean[y] < 30 && rowStd[y] < 18) {
      let end = y;
      while (end + 1 < h && rowMean[end + 1] < 30 && rowStd[end + 1] < 18) end++;
      const touchesEdge = y === 0 || end === h - 1;
      if (!touchesEdge && end - y + 1 <= Math.max(10, Math.round(h * 0.12))) seams.push({ row: Math.round((y + end + 1) / 2), strength: 1000 });
      y = end + 1;
    } else y++;
  }

  // hard cuts
  const near = (row: number) => {
    const even = [1 / 2, 1 / 3, 2 / 3];
    return even.some(f => Math.abs(row / h - f) <= 0.09);
  };
  for (let i = 2; i < h - 3; i++) {
    if (frac[i] < 0.3 || meanD[i] < 5) continue;
    // a spike: much larger than the row-to-row change around it
    const around: number[] = [];
    for (let j = Math.max(0, i - 10); j <= Math.min(h - 2, i + 10); j++) if (Math.abs(j - i) > 1) around.push(meanD[j]);
    around.sort((p, q) => p - q);
    const spike = meanD[i] / Math.max(around[Math.floor(around.length / 2)] || 0, 1.5);
    let strongest = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(h - 2, i + 4); j++) if (meanD[j] > meanD[i] || (meanD[j] === meanD[i] && j < i)) strongest = false;
    if (!strongest) continue;
    const row = i + 1;
    const evidence = frac[i] * Math.min(1, meanD[i] / 40);
    // near an even split a clear spike is enough; elsewhere it has to be unmistakable
    if ((near(row) && spike >= 4) || (spike >= 3 && frac[i] >= 0.45 && meanD[i] >= 12 && evidence >= 0.75)) seams.push({ row, strength: meanD[i] * frac[i] });
  }

  return chooseSeams(seams, h);
}

/** Skin-coloured pixels (a classic YCbCr range, widened for darker skin tones). */
function skinAt(d: Uint8ClampedArray, i: number): boolean {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 40 || y > 235) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 70 && cb <= 128 && cr >= 133 && cr <= 178;
}

/**
 * Where the main face probably is inside `rect` (sample coordinates): the biggest, compact patch of skin colour that
 * sits high in the frame. It is only a starting point, the owner can move it.
 */
function faceFocus(s: Sample, rect: Rect): Focus {
  const { w, data } = s;
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  const rw = Math.max(1, Math.floor(rect.width));
  const rh = Math.max(1, Math.floor(rect.height));
  const mask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mask[y * rw + x] = skinAt(data, ((y0 + y) * w + x0 + x) * 4) ? 1 : 0;

  const seen = new Uint8Array(rw * rh);
  let best: { score: number; cx: number; cy: number } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0;
    let minX = rw, maxX = 0, minY = rh, maxY = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      const px = p % rw;
      const py = (p - px) / rw;
      area++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const q = ny * rw + nx;
        if (mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (area < rw * rh * 0.008) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fill = area / (bw * bh); // a face is a solid blob; an arm or a crowd is stringy
    const cy = (minY + maxY) / 2 / rh;
    const score = area * (0.4 + fill) * (1.5 - cy);
    if (!best || score > best.score) best = { score, cx: (minX + maxX) / 2 / rw, cy };
  }
  return best ? { x: clamp(best.cx, 0.08, 0.92), y: clamp(best.cy, 0.1, 0.9) } : { x: 0.5, y: 0.5 };
}

/** Looks at a decoded picture: is it a stack of frames, where are they, and where are the faces. */
export function analyzeReactionImage(img: any): ReactionAnalysis {
  const width: number = img.width;
  const height: number = img.height;
  const s = sampleOf(img);
  const seams = findSeams(s);

  // frames between the seams; a divider band is not part of either frame
  const bounds = [0, ...seams, s.h];
  let frames: Rect[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    frames.push({ x: 0, y: bounds[i], width: s.w, height: bounds[i + 1] - bounds[i] });
  }
  // trim the dark divider rows off the frames' edges
  frames = frames.map(f => {
    let top = f.y;
    let bottom = f.y + f.height;
    const dark = (row: number) => {
      let sum = 0;
      for (let x = 0; x < s.w; x++) sum += luma(s.data, (row * s.w + x) * 4);
      return sum / s.w < 30;
    };
    while (top < bottom - 1 && dark(top)) top++;
    while (bottom - 1 > top && dark(bottom - 1)) bottom--;
    return { x: 0, y: top, width: s.w, height: bottom - top };
  });
  const tooShort = frames.some(f => f.height < s.h * MIN_FRAME_SHARE);
  if (frames.length < 2 || frames.length > MAX_FRAMES || tooShort) frames = [{ x: 0, y: 0, width: s.w, height: s.h }];

  const autoFocus = frames.map(f => (frames.length > 1 ? faceFocus(s, f) : { x: 0.5, y: 0.5 }));
  const toSource = (f: Rect): Rect => ({ x: 0, y: Math.round(f.y * s.scale), width, height: Math.min(height - Math.round(f.y * s.scale), Math.round(f.height * s.scale)) });
  return { width, height, frames: frames.map(toSource), stacked: frames.length > 1, autoFocus };
}

/** The window of `frame` that fills `aspect` (width / height), as large as possible, centred on `focus` and kept inside. */
function cropWindow(frame: Rect, aspect: number, focus: Focus): Rect {
  const frameAspect = frame.width / frame.height;
  const width = frameAspect > aspect ? frame.height * aspect : frame.width;
  const height = frameAspect > aspect ? frame.height : frame.width / aspect;
  return {
    x: clamp(frame.x + focus.x * frame.width - width / 2, frame.x, frame.x + frame.width - width),
    y: clamp(frame.y + focus.y * frame.height - height / 2, frame.y, frame.y + frame.height - height),
    width,
    height
  };
}

/**
 * Turns the picture, the choice and the panel size into draw rectangles.
 *  - a stack (and split not switched off): the frames side by side, each cropped around its focus;
 *  - anything else: one cover crop of the whole picture. With no choice it is the long-standing crop (centred sideways,
 *    `anchorY` from the Settings from top to bottom); with a choice it is centred on the chosen point.
 */
export function planReactionPanel(a: ReactionAnalysis, framing: ReactionFraming | undefined, panel: { width: number; height: number }, anchorY = 0.36): PanelPlan {
  const aspect = panel.width / panel.height;
  const fullPanel: Rect = { x: 0, y: 0, width: panel.width, height: panel.height };

  // the whole picture, nothing cropped, on a softened copy of itself
  if (framing?.fit === 'whole') {
    const whole: Rect = { x: 0, y: 0, width: a.width, height: a.height };
    const scale = Math.min(panel.width / a.width, panel.height / a.height);
    const w = a.width * scale;
    const h = a.height * scale;
    const dest: Rect = { x: (panel.width - w) / 2, y: (panel.height - h) / 2, width: w, height: h };
    return { parts: [{ src: whole, dest }], kind: 'whole', split: false, background: { src: cropWindow(whole, aspect, { x: 0.5, y: 0.5 }), dest: fullPanel }, enlargement: scale };
  }

  // one chosen frame of a stack, filling the panel
  const chosen = framing?.frame;
  if (a.stacked && typeof chosen === 'number' && Number.isInteger(chosen) && chosen >= 0 && chosen < a.frames.length) {
    const frame = a.frames[chosen];
    const f = framing?.focus?.[0] ? { x: clamp01(framing.focus[0].x), y: clamp01(framing.focus[0].y) } : a.autoFocus[chosen] || { x: 0.5, y: 0.5 };
    const src = cropWindow(frame, aspect, f);
    return { parts: [{ src, dest: fullPanel }], kind: 'frame', split: false, enlargement: panel.width / src.width };
  }

  const split = a.stacked && framing?.split !== false;
  const parts: PanelPart[] = [];
  if (split) {
    const n = a.frames.length;
    const gap = Math.round((FRAME_GAP * panel.width) / 1080);
    const colW = (panel.width - gap * (n - 1)) / n;
    a.frames.forEach((frame, i) => {
      const focus = framing?.focus?.[i] ? { x: clamp01(framing.focus[i].x), y: clamp01(framing.focus[i].y) } : a.autoFocus[i] || { x: 0.5, y: 0.5 };
      const dest: Rect = { x: Math.round(i * (colW + gap)), y: 0, width: Math.round(colW), height: panel.height };
      parts.push({ src: cropWindow(frame, dest.width / dest.height, focus), dest });
    });
  } else {
    const whole: Rect = { x: 0, y: 0, width: a.width, height: a.height };
    const point = framing?.focus?.[0];
    let src: Rect;
    if (point) src = cropWindow(whole, aspect, { x: clamp01(point.x), y: clamp01(point.y) });
    else {
      const imgAspect = a.width / a.height;
      if (imgAspect > aspect) {
        const w = a.height * aspect;
        src = { x: (a.width - w) * 0.5, y: 0, width: w, height: a.height };
      } else {
        const h = a.width / aspect;
        src = { x: 0, y: (a.height - h) * anchorY, width: a.width, height: h };
      }
      src = { x: Math.max(0, src.x), y: Math.max(0, src.y), width: src.width, height: src.height };
    }
    parts.push({ src, dest: { x: 0, y: 0, width: panel.width, height: panel.height } });
  }
  const enlargement = Math.max(...parts.map(p => p.dest.width / p.src.width));
  return { parts, kind: split ? 'split' : 'single', split, enlargement };
}

/** The height of the reaction panel on a canvas: from the layout plan when it has one, else from the picture's own shape. */
export function reactionPanelHeight(canvasWidth: number, canvasHeight: number, aspect: number, heightRatio?: number): number {
  if (heightRatio) return Math.round(canvasHeight * heightRatio);
  const natural = Math.round(canvasWidth / Math.max(1.33, aspect));
  return Math.min(Math.round(canvasHeight * 0.42), Math.max(Math.round(canvasHeight * 0.34), natural));
}

/**
 * Reads a framing choice from a request: a JSON string or an object { split?: boolean, focus?: [{ x, y }] }.
 * Returns undefined when there is none; throws a readable Error when it is malformed.
 */
export function parseReactionFraming(input: unknown): ReactionFraming | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  let raw: unknown = input;
  if (typeof raw === 'string') {
    if (raw.length > 2000) throw new Error('reactionFraming is too long');
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('reactionFraming must be JSON');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('reactionFraming must be an object');
  const o = raw as Record<string, unknown>;
  const out: ReactionFraming = {};
  if (o.split !== undefined) {
    if (typeof o.split !== 'boolean') throw new Error('reactionFraming.split must be true or false');
    out.split = o.split;
  }
  if (o.frame !== undefined) {
    if (typeof o.frame !== 'number' || !Number.isInteger(o.frame) || o.frame < 0 || o.frame >= MAX_FRAMES) throw new Error(`reactionFraming.frame must be a whole number from 0 to ${MAX_FRAMES - 1}`);
    out.frame = o.frame;
  }
  if (o.fit !== undefined) {
    if (o.fit !== 'whole') throw new Error('reactionFraming.fit can only be "whole"');
    out.fit = 'whole';
  }
  if (out.frame !== undefined && out.fit !== undefined) throw new Error('reactionFraming: choose either one frame or the whole picture');
  if (o.focus !== undefined) {
    if (!Array.isArray(o.focus) || o.focus.length > MAX_FRAMES) throw new Error(`reactionFraming.focus must be a list of at most ${MAX_FRAMES} points`);
    out.focus = o.focus.map(p => {
      const pt = p as Record<string, unknown>;
      if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number' || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('each focus point needs numbers x and y between 0 and 1');
      return { x: clamp(pt.x, 0, 1), y: clamp(pt.y, 0, 1) };
    });
  }
  return Object.keys(out).length ? out : undefined;
}
