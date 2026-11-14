/**
 * Prepares images before they are shown to the vision model:
 *  - re-encodes them (drops EXIF/metadata and any non-image payload),
 *  - limits their size (bounded tokens and time),
 *  - appends a strip with a random verification code.
 *
 * The verification code proves the model actually looked at the image: in live probes the CLI
 * produced a plausible but invented "analysis" when it could not open the file. Every answer must
 * echo the code of each image it describes, otherwise it is rejected.
 */
import { randomInt } from 'crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const CODE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479'; // no look-alikes (0/O, 1/I/L, 5/S, 8/B, 2/Z, 6/G)

export function makeVerificationCode(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Compares a code echoed by the model, tolerating case, spaces and dashes. */
export function codesMatch(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(got) === norm(expected) || norm(got).endsWith(norm(expected));
}

export interface PreparedVisionImage {
  buffer: Buffer;
  width: number;
  /** Total height including the verification strip. */
  height: number;
  /** Height of the original picture area (above the strip). */
  contentHeight: number;
  code: string;
}

export interface PrepareOptions {
  code: string;
  /** Longest side of the picture area, in pixels. */
  maxSide?: number;
  /** Optional caption shown before the code, e.g. "CANDIDATE B". */
  caption?: string;
  /** Optional crop (fractions of the source image) applied before resizing. */
  crop?: { x: number; y: number; width: number; height: number };
}

/**
 * Clean JPEG crop of one region (fractions of the image), without any strip or caption. Used for
 * reverse image search of a reference slot and for picture-hash comparison. Returns null when the
 * crop would be smaller than `minSide` pixels in the source (too small to search with).
 */
export async function cropRegionToJpeg(
  input: Buffer | string,
  crop: { x: number; y: number; width: number; height: number },
  opts: { maxSide?: number; minSide?: number } = {}
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const img = await loadImage(input);
  const sx = Math.max(0, Math.floor(crop.x * img.width));
  const sy = Math.max(0, Math.floor(crop.y * img.height));
  const sw = Math.min(img.width - sx, Math.round(crop.width * img.width));
  const sh = Math.min(img.height - sy, Math.round(crop.height * img.height));
  if (sw < (opts.minSide ?? 16) || sh < (opts.minSide ?? 16)) return null;
  const scale = Math.min(1, (opts.maxSide ?? 1024) / Math.max(sw, sh));
  const w = Math.max(16, Math.round(sw * scale));
  const h = Math.max(16, Math.round(sh * scale));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return { buffer: canvas.toBuffer('image/jpeg', 92), width: w, height: h };
}

export async function prepareImageForVision(input: Buffer | string, opts: PrepareOptions): Promise<PreparedVisionImage> {
  const img = await loadImage(input);
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (opts.crop) {
    const c = opts.crop;
    sx = Math.max(0, Math.floor(c.x * img.width));
    sy = Math.max(0, Math.floor(c.y * img.height));
    sw = Math.max(16, Math.min(img.width - sx, Math.round(c.width * img.width)));
    sh = Math.max(16, Math.min(img.height - sy, Math.round(c.height * img.height)));
  }
  const maxSide = opts.maxSide ?? 1600;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(64, Math.round(sw * scale));
  const h = Math.max(64, Math.round(sh * scale));
  const strip = Math.min(120, Math.max(48, Math.round(w * 0.07)));

  const canvas = createCanvas(w, h + strip);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h + strip);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

  const label = `${opts.caption ? opts.caption + '   ' : ''}IMAGE CODE: ${opts.code}`;
  let size = Math.round(strip * 0.55);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFE500';
  ctx.font = `bold ${size}px sans-serif`;
  while (size > 12 && ctx.measureText(label).width > w - 16) {
    size -= 2;
    ctx.font = `bold ${size}px sans-serif`;
  }
  ctx.fillText(label, w / 2, h + strip / 2);

  return { buffer: canvas.toBuffer('image/jpeg', 90), width: w, height: h + strip, contentHeight: h, code: opts.code };
}
