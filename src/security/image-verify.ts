/**
 * Image content verification. File names and client MIME types are never trusted: the bytes must
 * actually be a JPEG, PNG or WebP image, with sane dimensions, that decodes successfully.
 * HTML, SVG, GIF, scripts and anything else are rejected regardless of extension.
 */
import * as fs from 'fs';
import { loadImage } from '@napi-rs/canvas';

export type ImageType = 'jpeg' | 'png' | 'webp';

export const MIME_BY_TYPE: Record<ImageType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};
export const EXT_BY_TYPE: Record<ImageType, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };
export const ACCEPTED_EXTS_BY_TYPE: Record<ImageType, string[]> = {
  jpeg: ['.jpg', '.jpeg'],
  png: ['.png'],
  webp: ['.webp']
};

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;   // 20 MB per file
export const MAX_IMAGE_PIXELS = 60_000_000;         // 60 MP (decoded RGBA is ~4 bytes/pixel)
export const MAX_IMAGE_DIMENSION = 20_000;
const HEADER_SCAN_BYTES = 4 * 1024 * 1024;

export class ImageValidationError extends Error {}

export interface ImageHeader { type: ImageType; width: number; height: number; }
export interface VerifiedImage extends ImageHeader { mime: string; ext: string; }

function pngHeader(b: Buffer): ImageHeader | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegHeader(b: Buffer): ImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; }          // fill bytes
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }  // standalone markers
    if (m === 0xd9 || m === 0xda) return null;                             // EOI / SOS before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return { type: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpHeader(b: Buffer): ImageHeader | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('ascii', 12, 16);
  const d = 20; // chunk data offset
  if (fourcc === 'VP8 ') {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    return { type: 'webp', width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (b[d] !== 0x2f) return null;
    const bits = b.readUInt32LE(d + 1);
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    const w = (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16)) + 1;
    const h = (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16)) + 1;
    return { type: 'webp', width: w, height: h };
  }
  return null;
}

/** Identifies the image type from magic bytes and reads its declared dimensions. Null if not JPEG/PNG/WebP. */
export function sniffImageHeader(buf: Buffer): ImageHeader | null {
  try {
    return pngHeader(buf) || jpegHeader(buf) || webpHeader(buf);
  } catch {
    return null;
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new ImageValidationError('Image has invalid dimensions');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageValidationError(`Image is too large (${width}x${height}); the limit is ${MAX_IMAGE_PIXELS / 1_000_000} megapixels`);
  }
}

/** Full verification: magic bytes, sane declared size (checked BEFORE decoding), and a real decode. */
export async function verifyImageBuffer(buf: Buffer): Promise<VerifiedImage> {
  const header = sniffImageHeader(buf);
  if (!header) throw new ImageValidationError('File content is not a JPEG, PNG or WebP image');
  assertDimensions(header.width, header.height);

  let decoded: { width: number; height: number };
  try {
    decoded = await loadImage(buf);
  } catch {
    throw new ImageValidationError('Image data is corrupt or cannot be decoded');
  }
  assertDimensions(decoded.width, decoded.height);

  return { ...header, width: decoded.width, height: decoded.height, mime: MIME_BY_TYPE[header.type], ext: EXT_BY_TYPE[header.type] };
}

/** Full verification of a file on disk (size-capped). */
export async function verifyImageFile(filePath: string): Promise<VerifiedImage> {
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new ImageValidationError('File is empty');
  if (size > MAX_UPLOAD_BYTES) throw new ImageValidationError(`File is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  return verifyImageBuffer(await fs.promises.readFile(filePath));
}

/** Cheap check for files already stored by the application: magic bytes + declared dimensions, no decode. */
export function inspectImageFileHeader(filePath: string): ImageHeader {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) throw new ImageValidationError('File is empty');
    const buf = Buffer.alloc(Math.min(size, HEADER_SCAN_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const header = sniffImageHeader(buf);
    if (!header) throw new ImageValidationError('File content is not a JPEG, PNG or WebP image');
    assertDimensions(header.width, header.height);
    return header;
  } finally {
    fs.closeSync(fd);
  }
}
