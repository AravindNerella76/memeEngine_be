import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { OUTPUT_ROOT, isPathInside } from '../security/path-guard';

export const THUMB_DIR = path.join(OUTPUT_ROOT, 'thumbs');
const JPEG_QUALITY = 80;
const MAX_PARALLEL = 3;

/**
 * Small JPEG copies of generated memes for the gallery. A 1080x1350 PNG is ~1.6 MB; its 480 px thumbnail is
 * ~40 KB, so a page of memes loads in a blink instead of tens of megabytes. Made on first request, cached on
 * disk, and rebuilt automatically if the source file changes.
 */
@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);
  private readonly inflight = new Map<string, Promise<string>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** Where the thumbnail of `source` at `width` lives. `key` (meme id + version) keeps names readable and deletable. */
  thumbPath(key: string, width: number): string {
    return path.join(THUMB_DIR, `${key}_${width}.jpg`);
  }

  /** Returns the thumbnail's path, creating it if it is missing or older than the source image. */
  async ensure(source: string, key: string, width: number): Promise<string> {
    if (!isPathInside(OUTPUT_ROOT, source)) throw new Error('Thumbnail source is outside the output folder');
    const dest = this.thumbPath(key, width);
    const srcStat = fs.statSync(source); // throws ENOENT when the image is gone
    try {
      if (fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) return dest;
    } catch {
      /* not made yet */
    }
    const running = this.inflight.get(dest);
    if (running) return running;
    const job = this.limited(() => this.make(source, dest, width)).finally(() => this.inflight.delete(dest));
    this.inflight.set(dest, job);
    return job;
  }

  /** Deletes every thumbnail of a meme (all versions and widths). Only files inside the thumbs folder. */
  removeForMeme(memeId: string): number {
    let n = 0;
    try {
      for (const f of fs.readdirSync(THUMB_DIR)) {
        if (f.startsWith(`${memeId}_`) && f.endsWith('.jpg')) {
          const p = path.join(THUMB_DIR, f);
          if (isPathInside(THUMB_DIR, p)) {
            fs.unlinkSync(p);
            n++;
          }
        }
      }
    } catch {
      /* no thumbs folder yet */
    }
    return n;
  }

  private async make(source: string, dest: string, width: number): Promise<string> {
    const img = await loadImage(source);
    const w = Math.min(width, img.width);
    const h = Math.max(1, Math.round((img.height * w) / img.width));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000'; // JPEG has no transparency
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const buf = canvas.toBuffer('image/jpeg', JPEG_QUALITY);
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest); // atomic: a reader never sees half a file
    this.logger.debug(`Thumbnail ${path.basename(dest)} (${Math.round(buf.length / 1024)} KB)`);
    return dest;
  }

  /** At most MAX_PARALLEL decodes at once, so the first gallery view cannot starve the server. */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_PARALLEL) await new Promise<void>(r => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
