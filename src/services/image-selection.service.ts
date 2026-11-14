import { BadRequestException, GoneException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config/app-config';
import { rightsForCandidate } from '../discovery/discovery-engine';
import { ImageCandidate } from '../discovery/discovery.types';
import { sha256 } from '../discovery/image-fingerprint';
import { RightsInfo } from '../discovery/rights';
import { ImageValidationError, MAX_UPLOAD_BYTES, verifyImageBuffer } from '../security/image-verify';
import { sanitizeDisplayName, UPLOADS_ROOT } from '../security/path-guard';
import { ImageSourceType, UploadedAsset } from '../types/meme.types';
import { InternetSubjectDiscoveryService } from './internet-subject-discovery.service';

/** Smallest side of a picture accepted at all (a technical check; the user's choice is otherwise theirs). */
export const MIN_USER_IMAGE_SIDE = 100;
const TTL_MS = 15 * 60 * 1000;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_STAGED = 60;
export const DISCOVERED_DIR = path.join(UPLOADS_ROOT, 'internet-discovered');

export interface StagedImage {
  token: string;
  buf: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
  sha256: string;
  originalName: string;
  sourceType: ImageSourceType;
  sourceUrl?: string;
  sourcePage?: string;
  provider?: string;
  license?: string;
  attribution?: string;
  rights?: RightsInfo;
  /** The search provider's terms allow only transient storage: the link and title are not kept. */
  transient?: boolean;
  /** Focal point from an earlier AI verification of this very picture (discovered alternates only). */
  focus?: { x: number; y: number };
  referenceMatch?: string;
  thumbnail: string;
  createdAt: number;
}

export interface StagedPublic {
  token: string;
  thumbnail: string;
  width: number;
  height: number;
  bytes: number;
  originalName: string;
  sourceType: ImageSourceType;
  provider?: string;
  sourcePage?: string;
  license?: string;
  rightsLabel?: string;
  /** Always shown with the choice: a user's choice is never presented as AI-verified. */
  aiVerified: false;
  warnings: string[];
}

/** A cut-off download or damaged file is refused (decoders would otherwise show a partly grey picture). */
function assertComplete(buf: Buffer, type: string) {
  const tail = buf.subarray(Math.max(0, buf.length - 1024));
  const ok =
    type === 'png'
      ? tail.includes(Buffer.from('IEND'))
      : type === 'jpeg'
      ? tail.includes(Buffer.from([0xff, 0xd9]))
      : type === 'webp'
      ? buf.length >= 12 && buf.readUInt32LE(4) + 8 <= buf.length
      : true;
  if (!ok) throw new BadRequestException('The image file is incomplete or damaged.');
}

function thumbnailOf(img: any): string {
  const scale = Math.min(1, 320 / Math.max(img.width, img.height));
  const c = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return `data:image/jpeg;base64,${c.toBuffer('image/jpeg', 72).toString('base64')}`;
}

/**
 * Images the user has chosen for a slot but not yet applied. In memory only, expiring, size-capped.
 * Everything is validated on the way in (real JPEG/PNG/WebP, size limits, decodes), so what is
 * applied later is exactly what was previewed.
 */
@Injectable()
export class ImageSelectionService {
  private readonly staged = new Map<string, StagedImage>();

  constructor(private readonly discovery: InternetSubjectDiscoveryService) {}

  private purge() {
    const now = Date.now();
    for (const [k, v] of this.staged) if (now - v.createdAt > TTL_MS) this.staged.delete(k);
    let total = 0;
    for (const v of this.staged.values()) total += v.buf.length;
    for (const [k, v] of this.staged) {
      if (total <= MAX_TOTAL_BYTES && this.staged.size <= MAX_STAGED) break;
      this.staged.delete(k);
      total -= v.buf.length;
    }
  }

  /** Validates a picture and keeps it staged. Throws ImageValidationError / 4xx for unusable files. */
  private async stage(buf: Buffer, meta: Omit<StagedImage, 'token' | 'buf' | 'mime' | 'ext' | 'width' | 'height' | 'sha256' | 'thumbnail' | 'createdAt'>): Promise<StagedImage> {
    const maxBytes = Math.min(MAX_UPLOAD_BYTES, getConfig().limits.maxUploadBytes);
    if (buf.length > maxBytes) throw new BadRequestException(`The image is ${(buf.length / 1048576).toFixed(1)} MB; the maximum image size is ${Math.round(maxBytes / 1048576)} MB (Settings > Advanced).`);
    if (buf.length < 1000) throw new BadRequestException('The file is too small to be a picture.');
    const v = await verifyImageBuffer(buf);
    if (v.width < MIN_USER_IMAGE_SIDE || v.height < MIN_USER_IMAGE_SIDE) {
      throw new BadRequestException(`The image is only ${v.width}x${v.height}px; each side must be at least ${MIN_USER_IMAGE_SIDE}px.`);
    }
    assertComplete(buf, v.type);
    let img: any;
    try {
      img = await loadImage(buf);
    } catch (e: any) {
      throw new BadRequestException(`The image could not be decoded: ${String(e.message).slice(0, 100)}`);
    }
    this.purge();
    const st: StagedImage = { ...meta, token: randomBytes(16).toString('hex'), buf, mime: v.mime, ext: v.ext.replace(/^\./, ''), width: v.width, height: v.height, sha256: sha256(buf), thumbnail: thumbnailOf(img), createdAt: Date.now() };
    this.staged.set(st.token, st);
    return st;
  }

  /** The user's own file (already checked by the upload middleware; checked again here by content). */
  async stageUpload(filePath: string, originalName: string): Promise<StagedImage> {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      throw new BadRequestException('The uploaded file could not be read.');
    }
    try {
      return await this.stage(buf, { originalName: sanitizeDisplayName(originalName), sourceType: 'user_upload' });
    } catch (e) {
      if (e instanceof ImageValidationError) throw new BadRequestException(`"${sanitizeDisplayName(originalName)}" was rejected: ${e.message}`);
      throw e;
    }
  }

  /** Downloads one search result safely and stages it. Returns null when it is unusable (reported as a note). */
  private async stageCandidate(c: ImageCandidate): Promise<StagedImage | null> {
    try {
      const buf = await this.discovery.downloadForUser(c.imageUrl);
      return await this.stage(buf, {
        originalName: String(c.title || 'online image').slice(0, 120),
        sourceType: 'online_search',
        sourceUrl: c.imageUrl,
        sourcePage: c.pageUrl,
        provider: c.provider,
        license: c.license,
        attribution: c.attribution,
        rights: c.rights || rightsForCandidate(c),
        transient: c.resultStorage === 'transient'
      });
    } catch {
      return null;
    }
  }

  /** "Find another image online": searches, downloads the best hits safely and stages the usable ones. */
  async searchOnline(query: unknown): Promise<{ results: StagedPublic[]; providers: string[]; notes: string[] }> {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw new BadRequestException('Enter 2-200 characters to search for.');
    const clean = Array.from(query).filter(ch => ch.charCodeAt(0) >= 32).join('').trim();
    const { candidates, providers, errors } = await this.discovery.searchForUser(clean);
    const notes = [...errors];
    if (!candidates.length) return { results: [], providers, notes: [...notes, 'No pictures found for that search.'] };
    const results: StagedImage[] = [];
    const seen = new Set<string>();
    const cfg = getConfig().discovery;
    const queue = candidates.slice(0, 18);
    const worker = async () => {
      while (queue.length && results.length < 10) {
        const c = queue.shift()!;
        if ((c.width && c.width < MIN_USER_IMAGE_SIDE) || (c.height && c.height < MIN_USER_IMAGE_SIDE)) continue;
        const st = await this.stageCandidate(c);
        if (!st) continue;
        if (seen.has(st.sha256)) {
          this.staged.delete(st.token);
          continue;
        }
        seen.add(st.sha256);
        results.push(st);
      }
    };
    await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise(res => setTimeout(res, cfg.downloadTimeoutMs * 3))]);
    if (!results.length) notes.push('The pictures that were found could not be downloaded or were not usable images.');
    return { results: results.slice(0, 10).map(r => this.toPublic(r)), providers, notes };
  }

  /** A verified alternate from the original discovery, re-downloaded and checked against its recorded hash. */
  async stageDiscovered(alt: { sourceUrl: string; sha256: string; title?: string; provider?: string; pageUrl?: string; license?: string; attribution?: string; focus?: { x: number; y: number }; referenceMatch?: { level?: string }; rights?: RightsInfo }): Promise<StagedImage | null> {
    try {
      const buf = await this.discovery.downloadForUser(alt.sourceUrl);
      if (sha256(buf) !== alt.sha256) return null;
      const st = await this.stage(buf, {
        originalName: String(alt.title || 'discovered image').slice(0, 120),
        sourceType: 'ai_discovery',
        sourceUrl: alt.sourceUrl,
        sourcePage: alt.pageUrl,
        provider: alt.provider,
        license: alt.license,
        attribution: alt.attribution,
        focus: alt.focus,
        referenceMatch: alt.referenceMatch?.level,
        rights: alt.rights
      });
      return st;
    } catch {
      return null;
    }
  }

  toPublic(st: StagedImage): StagedPublic {
    const warnings: string[] = [];
    const cfg = getConfig().discovery;
    if (Math.min(st.width, st.height) < cfg.minImageSide) warnings.push(`Small picture (${st.width}x${st.height}px): it may look soft when enlarged.`);
    return {
      token: st.token,
      thumbnail: st.thumbnail,
      width: st.width,
      height: st.height,
      bytes: st.buf.length,
      originalName: st.originalName,
      sourceType: st.sourceType,
      provider: st.provider,
      sourcePage: st.transient ? undefined : st.sourcePage,
      license: st.license,
      rightsLabel: st.rights?.label,
      aiVerified: false,
      warnings
    };
  }

  /** The staged picture for a token (still staged). */
  get(token: unknown): StagedImage {
    this.purge();
    const st = typeof token === 'string' ? this.staged.get(token) : undefined;
    if (!st) throw new GoneException('That image choice has expired. Choose the image again.');
    return st;
  }

  discard(token: unknown): void {
    if (typeof token === 'string') this.staged.delete(token);
  }

  /** Writes a staged picture (unchanged bytes) into application storage and returns the stored file. */
  writeToDisk(st: StagedImage): { path: string; filename: string } {
    const user = st.sourceType === 'user_upload';
    const dir = user ? UPLOADS_ROOT : DISCOVERED_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${user ? 'upload' : 'internet'}_${randomUUID()}.${st.ext}`;
    const p = path.join(dir, filename);
    fs.writeFileSync(p, st.buf, { flag: 'wx' });
    return { path: p, filename };
  }

  /**
   * The slot's new asset. The slot's own properties (label, role, position) are kept; everything
   * about the picture is the new picture's. The choice is recorded as the user's, never AI-verified.
   */
  assetFor(st: StagedImage, file: { path: string; filename: string }, slotAsset: Partial<UploadedAsset>, selectedByUser: boolean): UploadedAsset {
    const stored = !st.transient;
    return {
      id: randomUUID(),
      // a transient-only provider's title is never stored
      originalName: stored ? st.originalName : file.filename,
      filename: file.filename,
      path: file.path,
      mimeType: st.mime,
      width: st.width,
      height: st.height,
      aspectRatio: Number((st.width / st.height).toFixed(4)),
      orientation: st.width / st.height > 1.15 ? 'landscape' : st.width / st.height < 0.85 ? 'portrait' : 'square',
      role: slotAsset.role || 'subject_item',
      orderIndex: slotAsset.orderIndex ?? 0,
      label: slotAsset.label,
      sourceUrl: stored ? st.sourceUrl : undefined,
      sourcePage: stored ? st.sourcePage : undefined,
      attribution: stored ? st.attribution : undefined,
      license: st.license,
      sha256: st.sha256,
      focalX: st.focus?.x,
      focalY: st.focus?.y,
      provider: st.provider,
      rights: st.rights,
      referenceMatch: st.referenceMatch,
      sourceType: st.sourceType,
      selectedBy: selectedByUser ? 'user' : 'ai',
      aiVerified: st.sourceType === 'ai_discovery'
    };
  }
}

export function assertSlot(slot: unknown, count: number): number {
  const n = typeof slot === 'number' ? slot : typeof slot === 'string' && /^\d{1,2}$/.test(slot) ? Number(slot) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > count) throw new UnprocessableEntityException(`Image slot must be a number from 1 to ${count}.`);
  return n;
}
