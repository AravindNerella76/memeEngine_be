/**
 * Image fingerprints for duplicate detection:
 *  - sha256: exact byte identity (also used to re-verify an alternate image when re-downloaded);
 *  - dHash (64-bit difference hash): the same picture at another size/compression.
 */
import { createHash } from 'crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function dHash(input: Buffer | string): Promise<string> {
  const img = await loadImage(input);
  const canvas = createCanvas(9, 8);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const lum = (x: number, y: number) => {
    const i = (y * 9 + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += lum(x, y) > lum(x + 1, y) ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

/** Same picture (allowing re-encoding / resizing). */
export const DUPLICATE_HAMMING = 6;
