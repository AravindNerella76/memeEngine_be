import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ReactionImage, ReactionImageDocument } from '../schemas/reaction-image.schema';
import { ImageValidationError, verifyImageBuffer } from '../security/image-verify';
import { ValidatedReactionPatch, ValidatedReactionQuery, escapeRegex } from '../security/request-validation';
import { sanitizeDisplayName } from '../security/path-guard';

/** The library is the owner's own set, not a dump: this keeps a runaway import from filling the database. */
export const MAX_LIBRARY_IMAGES = 3000;
/** Larger pictures are shrunk when stored (a reaction panel is never wider than the 1080 px canvas). */
const MAX_STORED_SIDE = 2400;
const MAX_STORED_BYTES = 3 * 1024 * 1024;
const THUMB_WIDTH = 480;

export interface ReactionSummary {
  imageId: string;
  category: string;
  name: string;
  tags: string[];
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AddReactionResult {
  created: boolean;
  image: ReactionSummary;
}

const SUMMARY_FIELDS = 'imageId category name tags width height bytes mimeType usedCount lastUsedAt createdAt';

function summarize(d: any): ReactionSummary {
  return {
    imageId: d.imageId,
    category: d.category,
    name: d.name || '',
    tags: d.tags || [],
    width: d.width,
    height: d.height,
    bytes: d.bytes,
    mimeType: d.mimeType,
    usedCount: d.usedCount || 0,
    lastUsedAt: d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : new Date(0).toISOString()
  };
}

/** True when any pixel is noticeably transparent (checked on a small copy). */
function hasAlpha(img: { width: number; height: number }, source: any): boolean {
  const w = Math.min(img.width, 96);
  const h = Math.min(img.height, 96);
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.drawImage(source, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/**
 * The owner's reaction pictures, grouped by situation / emotion / subject. Stored in MongoDB so a host with a
 * temporary disk (Render's free plan) never loses them.
 */
@Injectable()
export class ReactionLibraryService {
  constructor(@InjectModel(ReactionImage.name) private readonly model: Model<ReactionImageDocument>) {}

  /** Every folder with how many pictures it holds, biggest first. */
  async categories(): Promise<{ categories: Array<{ category: string; count: number }>; total: number }> {
    const rows = await this.model.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }]);
    const categories = rows.map((r: any) => ({ category: String(r._id), count: r.count as number }));
    return { categories, total: categories.reduce((n, c) => n + c.count, 0) };
  }

  async list(q: ValidatedReactionQuery): Promise<{ items: ReactionSummary[]; total: number }> {
    const filter: Record<string, unknown> = {};
    if (q.category) filter.category = q.category;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: rx }, { tags: rx }, { category: rx }];
    }
    // "recent" and "used" are for the quick-pick row: only pictures that were actually used
    let sort: Record<string, 1 | -1> = { createdAt: -1, imageId: 1 };
    if (q.sort === 'recent') {
      filter.lastUsedAt = { $ne: null };
      sort = { lastUsedAt: -1 };
    } else if (q.sort === 'used') {
      filter.usedCount = { $gt: 0 };
      sort = { usedCount: -1, lastUsedAt: -1 };
    }
    const [docs, total] = await Promise.all([
      this.model.find(filter).select(SUMMARY_FIELDS).sort(sort).skip(q.skip).limit(q.limit).lean().exec(),
      this.model.countDocuments(filter).exec()
    ]);
    return { items: docs.map(summarize), total };
  }

  /**
   * Adds one picture. The same file (by content) is never stored twice: it is reported, not duplicated.
   * Throws BadRequestException with a readable reason when the file is not a usable image.
   */
  async add(input: { buffer: Buffer; originalName: string; category: string; name?: string; tags?: string[] }): Promise<AddReactionResult> {
    const sha256 = createHash('sha256').update(input.buffer).digest('hex');
    const existing = await this.model.findOne({ sha256 }).select(SUMMARY_FIELDS).lean().exec();
    if (existing) return { created: false, image: summarize(existing) };

    if ((await this.model.estimatedDocumentCount().exec()) >= MAX_LIBRARY_IMAGES) {
      throw new BadRequestException(`The library holds ${MAX_LIBRARY_IMAGES} pictures already. Remove some before adding more.`);
    }

    let verified;
    try {
      verified = await verifyImageBuffer(input.buffer);
    } catch (err) {
      if (err instanceof ImageValidationError) throw new BadRequestException(`"${sanitizeDisplayName(input.originalName)}" was rejected: ${err.message}`);
      throw err;
    }

    const img = await loadImage(input.buffer);
    const alpha = verified.type !== 'jpeg' && hasAlpha(img, img);

    // keep the original bytes when they are reasonable; shrink only what is far larger than any canvas needs
    let data = input.buffer;
    let mimeType = verified.mime;
    let width = verified.width;
    let height = verified.height;
    if (Math.max(width, height) > MAX_STORED_SIDE || input.buffer.length > MAX_STORED_BYTES) {
      const scale = Math.min(1, MAX_STORED_SIDE / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const c = createCanvas(width, height);
      const x = c.getContext('2d');
      if (!alpha) {
        x.fillStyle = '#000000';
        x.fillRect(0, 0, width, height);
      }
      x.drawImage(img, 0, 0, width, height);
      const png = alpha ? c.toBuffer('image/png') : null;
      if (png && png.length <= MAX_STORED_BYTES * 2) {
        data = png;
        mimeType = 'image/png';
      } else {
        data = c.toBuffer('image/jpeg', 90);
        mimeType = 'image/jpeg';
      }
    }

    // the small copy the library grid shows; a transparent picture keeps its transparency
    const tw = Math.min(THUMB_WIDTH, width);
    const th = Math.max(1, Math.round((height * tw) / width));
    const tc = createCanvas(tw, th);
    tc.getContext('2d').drawImage(img, 0, 0, tw, th);
    const thumb = alpha ? tc.toBuffer('image/png') : tc.toBuffer('image/jpeg', 80);
    const thumbMime = alpha ? 'image/png' : 'image/jpeg';

    try {
      const doc = await this.model.create({
        imageId: randomUUID(),
        category: input.category,
        name: input.name || '',
        tags: input.tags || [],
        sha256,
        mimeType,
        width,
        height,
        bytes: data.length,
        data,
        thumb,
        thumbMime
      });
      return { created: true, image: summarize(doc.toObject()) };
    } catch (err: any) {
      if (err?.code === 11000) {
        // two requests with the same picture at once: the other one won
        const again = await this.model.findOne({ sha256 }).select(SUMMARY_FIELDS).lean().exec();
        if (again) return { created: false, image: summarize(again) };
      }
      throw err;
    }
  }

  async update(imageId: string, patch: ValidatedReactionPatch): Promise<ReactionSummary> {
    const set: Record<string, unknown> = {};
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.tags !== undefined) set.tags = patch.tags;
    if (!Object.keys(set).length) throw new BadRequestException('Nothing to change.');
    const doc = await this.model.findOneAndUpdate({ imageId }, { $set: set }, { new: true }).select(SUMMARY_FIELDS).lean().exec();
    if (!doc) throw new NotFoundException('That picture is no longer in the library.');
    return summarize(doc);
  }

  async remove(imageId: string): Promise<{ deleted: boolean }> {
    const r = await this.model.deleteOne({ imageId }).exec();
    if (!r.deletedCount) throw new NotFoundException('That picture is no longer in the library.');
    return { deleted: true };
  }

  async bulk(action: 'move' | 'delete', ids: string[], category?: string): Promise<{ changed: number }> {
    if (action === 'delete') return { changed: (await this.model.deleteMany({ imageId: { $in: ids } }).exec()).deletedCount || 0 };
    const r = await this.model.updateMany({ imageId: { $in: ids } }, { $set: { category } }).exec();
    return { changed: r.modifiedCount };
  }

  async markUsed(imageId: string): Promise<void> {
    await this.model.updateOne({ imageId }, { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } }).exec();
  }

  /** Small copies of several pictures at once (for a numbered sheet), keyed by id. Missing ids are simply absent. */
  async thumbs(ids: string[]): Promise<Map<string, { data: Buffer; mime: string }>> {
    const docs = await this.model.find({ imageId: { $in: ids } }).select('imageId +thumb thumbMime').exec();
    return new Map(docs.map(d => [d.imageId, { data: Buffer.from(d.thumb), mime: d.thumbMime || 'image/jpeg' }]));
  }

  /**
   * Writes a picture to `dir` as a file the meme pipeline can read (it works from files) and returns where. The name is made
   * here; the stored picture is the one the owner added, byte for byte.
   */
  async materialize(imageId: string, dir: string): Promise<{ filePath: string; filename: string; mimeType: string; category: string }> {
    const { data, mime } = await this.bytes(imageId, 'file');
    const doc = await this.model.findOne({ imageId }).select('category').lean().exec();
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const filename = `lib_${randomUUID()}${ext}`;
    const filePath = path.join(dir, filename);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, data, { flag: 'wx' });
    return { filePath, filename, mimeType: mime, category: doc?.category || '' };
  }

  /** The stored file (original bytes) or its small copy. */
  async bytes(imageId: string, which: 'file' | 'thumb'): Promise<{ data: Buffer; mime: string; name: string }> {
    const doc = await this.model.findOne({ imageId }).select(which === 'file' ? '+data mimeType category name' : '+thumb thumbMime category name').exec();
    if (!doc) throw new NotFoundException('That picture is no longer in the library.');
    const raw = which === 'file' ? doc.data : doc.thumb;
    return { data: Buffer.from(raw), mime: which === 'file' ? doc.mimeType : doc.thumbMime || 'image/jpeg', name: doc.name || doc.category };
  }
}
