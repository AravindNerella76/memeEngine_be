/**
 * Turns whatever the user sends (JPEG, PNG, WebP, HEIC/HEIF, PDF) into an image the rest of the
 * pipeline accepts (JPEG, PNG or WebP), keeping the full resolution.
 *
 *  - JPEG / PNG / WebP are returned byte-for-byte (no re-encoding, so no quality loss).
 *  - HEIC / HEIF (iPhone) is decoded and re-encoded at full size (PNG, or JPEG quality 95 when large).
 *  - PDF: the first page is rendered (PDFium/WebAssembly) at up to ~4000 px on its long side, so a photo saved as PDF stays sharp.
 *  - Everything else (GIF, SVG, HTML, scripts ...) is rejected by content, never by file name.
 */
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { ImageType, ImageValidationError, MAX_IMAGE_PIXELS, MIME_BY_TYPE, EXT_BY_TYPE, sniffImageHeader, verifyImageBuffer } from './image-verify';

/** Largest file we are willing to decode (the converted image must still fit the normal upload limit). */
export const MAX_CONVERT_INPUT_BYTES = 60 * 1024 * 1024;
/** A PNG above this size is stored as JPEG quality 95 instead. */
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PDF_TARGET_LONG_SIDE = 4000;
const PDF_MAX_PAGE_PIXELS = 36_000_000;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

export type ConvertedFrom = 'none' | 'heic' | 'pdf';

export interface NormalizedImage {
  buffer: Buffer;
  type: ImageType;
  mime: string;
  ext: string;
  width: number;
  height: number;
  convertedFrom: ConvertedFrom;
}

export function isHeic(buf: Buffer): boolean {
  return buf.length > 16 && buf.toString('ascii', 4, 8) === 'ftyp' && HEIC_BRANDS.has(buf.toString('ascii', 8, 12));
}

export function isPdf(buf: Buffer): boolean {
  // The signature may be preceded by a few junk bytes (the PDF spec allows up to 1024).
  return buf.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

/** Encodes RGBA pixels at full size: PNG when reasonably small, otherwise JPEG quality 95. */
function encodeCanvas(canvas: any): { buffer: Buffer; type: ImageType } {
  const png = canvas.toBuffer('image/png');
  if (png.length <= MAX_PNG_BYTES) return { buffer: png, type: 'png' };
  return { buffer: canvas.toBuffer('image/jpeg', 95), type: 'jpeg' };
}

async function fromHeic(buf: Buffer): Promise<NormalizedImage> {
  let decoded: { width: number; height: number; data: Uint8ClampedArray };
  try {
    const decode = require('heic-decode');
    decoded = await decode({ buffer: buf });
  } catch (err: any) {
    throw new ImageValidationError(`This HEIC/HEIF image could not be decoded (${String(err?.message || err).slice(0, 80)}). Try sending it as a JPEG.`);
  }
  const { width, height } = decoded;
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageValidationError(`HEIC image is too large (${width}x${height}); the limit is ${MAX_IMAGE_PIXELS / 1_000_000} megapixels`);
  }
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), width, height), 0, 0);
  const { buffer, type } = encodeCanvas(canvas);
  return { buffer, type, mime: MIME_BY_TYPE[type], ext: EXT_BY_TYPE[type], width, height, convertedFrom: 'heic' };
}

// PDFium compiled to WebAssembly: untrusted PDFs run inside the wasm sandbox (a bad file throws, it cannot crash the server).
let pdfium: Promise<any> | null = null;
function pdfiumLibrary(): Promise<any> {
  if (!pdfium) {
    pdfium = require('@hyzyla/pdfium').PDFiumLibrary.init().catch((err: unknown) => {
      pdfium = null;
      throw err;
    });
  }
  return pdfium;
}

async function fromPdf(buf: Buffer): Promise<NormalizedImage> {
  let doc: any;
  let page: any;
  try {
    const lib = await pdfiumLibrary();
    doc = await lib.loadDocument(buf);
    page = doc.getPage(0);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    let scale = Math.max(1, PDF_TARGET_LONG_SIDE / Math.max(originalWidth, originalHeight));
    if (originalWidth * originalHeight * scale * scale > PDF_MAX_PAGE_PIXELS) scale = Math.sqrt(PDF_MAX_PAGE_PIXELS / (originalWidth * originalHeight));
    const bitmap = await page.render({ scale, render: 'bitmap' });   // RGBA pixels on a white page
    const { width, height } = bitmap;
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength), width, height), 0, 0);
    const { buffer, type } = encodeCanvas(canvas);
    return { buffer, type, mime: MIME_BY_TYPE[type], ext: EXT_BY_TYPE[type], width, height, convertedFrom: 'pdf' };
  } catch (err: any) {
    throw new ImageValidationError(`The PDF could not be read (${String(err?.message || err).slice(0, 80)}). Send the picture as an image file instead.`);
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    try { doc?.destroy(); } catch { /* ignore */ }
  }
}

/** Verifies and, when needed, converts an uploaded file. Throws ImageValidationError with a user-readable message. */
export async function normalizeImageBuffer(buf: Buffer): Promise<NormalizedImage> {
  if (!buf || buf.length === 0) throw new ImageValidationError('File is empty');
  if (buf.length > MAX_CONVERT_INPUT_BYTES) {
    throw new ImageValidationError(`File is too large (${(buf.length / 1048576).toFixed(0)} MB; limit ${MAX_CONVERT_INPUT_BYTES / 1048576} MB)`);
  }

  if (sniffImageHeader(buf)) {
    const v = await verifyImageBuffer(buf);          // real decode check; bytes are kept as they are
    return { buffer: buf, type: v.type, mime: v.mime, ext: v.ext, width: v.width, height: v.height, convertedFrom: 'none' };
  }

  let out: NormalizedImage;
  if (isHeic(buf)) out = await fromHeic(buf);
  else if (isPdf(buf)) out = await fromPdf(buf);
  else throw new ImageValidationError('Unsupported file. Send a JPEG, PNG, WebP, HEIC or PDF.');

  // The converted result goes through the same checks as any upload.
  const v = await verifyImageBuffer(out.buffer);
  return { ...out, width: v.width, height: v.height };
}
