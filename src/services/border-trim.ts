import { createCanvas } from '@napi-rs/canvas';

/**
 * Finds the picture inside black or white bars: movie letterboxing (bars above and below a cinemascope frame, often
 * with a studio logo in them), pillarboxing, and plain screenshot borders. Placed as they are, those bars become dark
 * bands between the meme's panels and a strip along its bottom edge.
 *
 * A bar is a run of rows (or columns) from the picture's edge that are almost entirely near-black or near-white, and
 * that ends at a clear edge. It is deliberately strict, so real picture content is never cut:
 *  - "almost entirely": at least 92% of a row (a small logo or subtitle in the bar is allowed);
 *  - at most 25% of the picture on each side (a dark night sky taking a third of the frame is content, not a bar);
 *  - it is solid right up to its edge and ends sharply (a dark area that fades in gradually is content).
 */

export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DARK_MAX = 30; // a channel value at or below this everywhere = black bar (JPEG noise included)
const LIGHT_MIN = 238; // every channel at or above this = white border
const BAR_SHARE = 0.92;
const EDGE_JUMP = 40; // average distance from the bar colour where the picture starts
const MAX_SIDE = 0.25;
const SOLID_MAX = 16; // average distance from pure black/white of a bar's own lines near its edge (a logo is averaged in)
const ANALYSIS_MAX = 960; // analysed at this size at most: fast, and precise to a pixel or two

type Kind = 'dark' | 'light';

/** The part of `img` that is picture, not bars; null when there is nothing to trim. */
export function findContentRect(img: { width: number; height: number }): ContentRect | null {
  const W = img.width;
  const H = img.height;
  if (!W || !H || W < 40 || H < 40) return null;
  const k = Math.min(1, ANALYSIS_MAX / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img as any, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const kindOf = (i: number): Kind | null => {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r <= DARK_MAX && g <= DARK_MAX && b <= DARK_MAX) return 'dark';
    if (r >= LIGHT_MIN && g >= LIGHT_MIN && b >= LIGHT_MIN) return 'light';
    return null;
  };
  /** Share of row y (or column x) that is of `kind`. */
  const rowShare = (y: number, kind: Kind) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (kindOf((y * w + x) * 4) === kind) n++;
    return n / w;
  };
  const colShare = (x: number, kind: Kind, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (kindOf((y * w + x) * 4) === kind) n++;
    return n / Math.max(1, y1 - y0);
  };

  /** How far a pixel is from pure black (its brightest channel) or pure white (255 minus its darkest channel). */
  const off = (i: number, kind: Kind) => (kind === 'dark' ? Math.max(data[i], data[i + 1], data[i + 2]) : 255 - Math.min(data[i], data[i + 1], data[i + 2]));
  const rowOff = (y: number, kind: Kind) => {
    let s = 0;
    for (let x = 0; x < w; x++) s += off((y * w + x) * 4, kind);
    return s / w;
  };
  const colOff = (x: number, kind: Kind, y0: number, y1: number) => {
    let s = 0;
    for (let y = y0; y < y1; y++) s += off((y * w + x) * 4, kind);
    return s / Math.max(1, y1 - y0);
  };

  /**
   * Length of the bar starting at the edge (0 when there is none). `share(i)` = bar-coloured share of line i counted
   * from that edge, `solid(i)` = how far line i is from pure black/white on average.
   */
  const barLength = (len: number, share: (i: number, kind: Kind) => number, solid: (i: number, kind: Kind) => number): number => {
    for (const kind of ['dark', 'light'] as Kind[]) {
      if (share(0, kind) < BAR_SHARE) continue;
      let i = 1;
      const limit = Math.floor(len * MAX_SIDE);
      while (i <= limit && share(i, kind) >= BAR_SHARE) i++;
      if (i > limit) return 0; // too much of the picture: content, not a bar
      if (i < Math.max(3, len * 0.012)) return 0; // a hairline: not worth cutting (and maybe the picture's own edge)
      // a real bar is solid right up to its edge; a dark area that fades in is already greying a few lines before it
      if (solid(Math.max(0, i - 3), kind) > SOLID_MAX) return 0;
      // it must end sharply: within two lines the picture is clearly brighter (or darker) on average. One blended line
      // (JPEG smears the edge of a bar) is allowed and cut with the bar. The picture may still be dark in places: a
      // dark film frame under a black bar has half its pixels near-black, but its average jumps all the same.
      if (solid(i, kind) >= EDGE_JUMP) return i;
      if (i + 1 < len && solid(i + 1, kind) >= EDGE_JUMP) return i + 1;
      return 0; // fades in gradually: content
    }
    return 0;
  };

  const top = barLength(h, (i, kind) => rowShare(i, kind), (i, kind) => rowOff(i, kind));
  const bottom = barLength(h, (i, kind) => rowShare(h - 1 - i, kind), (i, kind) => rowOff(h - 1 - i, kind));
  const y0 = top;
  const y1 = h - bottom;
  if (y1 - y0 < h * 0.3) return null;
  const left = barLength(w, (i, kind) => colShare(i, kind, y0, y1), (i, kind) => colOff(i, kind, y0, y1));
  const right = barLength(w, (i, kind) => colShare(w - 1 - i, kind, y0, y1), (i, kind) => colOff(w - 1 - i, kind, y0, y1));
  if (!top && !bottom && !left && !right) return null;

  // back to full size, cutting one more analysis pixel so no thin line of the bar survives the rounding
  const pad = (n: number) => (n ? Math.ceil((n + 1) / k) : 0);
  const x = pad(left);
  const y = pad(top);
  const width = W - x - pad(right);
  const height = H - y - pad(bottom);
  if (width < W * 0.4 || height < H * 0.4) return null;
  return { x, y, width, height };
}

/** The picture without its bars (a new canvas), or the picture itself when it has none. */
export function trimImageBorders<T extends { width: number; height: number }>(img: T): T {
  const r = findContentRect(img);
  if (!r) return img;
  const c = createCanvas(r.width, r.height);
  c.getContext('2d').drawImage(img as any, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return c as unknown as T;
}
