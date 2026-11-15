import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { MemeFormat, MemeFormatDocument, FormatSource } from '../schemas/meme-format.schema';
import { ReferenceAnalysis } from '../analysis/reference-analysis.types';
import { arrangementFromAnalysis } from '../analysis/reference-analysis.normalizer';
import { deriveGridFromAnalysis, reactionRatioFromAnalysis } from '../analysis/layout-planner';
import { DEFAULT_HEADER_RATIO } from '../design/design-profile';
import { OUTPUT_ROOT } from '../security/path-guard';
import type { LayoutConfiguration } from '../types/meme.types';

export interface FormatSummary {
  formatId: string;
  name: string | null;
  displayName: string;
  description: string;
  status: 'named' | 'unnamed';
  source: FormatSource;
  slotCount: number;
  rows: number[];
  hasHeader: boolean;
  hasStatement: boolean;
  hasReactionPanel: boolean;
  usageCount: number;
  thumbnailUrl: string | null;
  createdAt?: Date;
}

export const MAX_FORMAT_NAME = 60;
const MAX_FORMATS = 200;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Cleans a user-given name: no control characters, collapsed spaces, bounded length. Empty -> null. */
export function cleanFormatName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = Array.from(raw).filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_FORMAT_NAME) : null;
}

/**
 * Remembers the layouts of the community's meme formats so they can be reused (manual creation) and
 * so new formats are noticed. Layout only: fonts and colours stay in the global Settings.
 */
@Injectable()
export class FormatLibraryService {
  private readonly logger = new Logger(FormatLibraryService.name);

  constructor(@InjectModel(MemeFormat.name) private readonly model: Model<MemeFormatDocument>) {}

  /** Structure fingerprint of an analysed example. */
  static signatureOf(a: ReferenceAnalysis): string {
    const grid = deriveGridFromAnalysis(a);
    const gridKey = grid
      ? grid.rows.map(r => `${round1(r.heightWeight)}[${r.slots.map(s => round1(s.widthWeight)).join(',')}]`).join('/')
      : 'std';
    return [
      arrangementFromAnalysis(a),
      gridKey,
      `n${a.slots.length}`,
      `h${a.header.present ? 1 : 0}`,
      `r${a.reactionPanel.present ? 1 : 0}`,
      `s${a.overlayText.statement ? 1 : 0}`
    ].join('|');
  }

  /** Short human description, e.g. "3 images (2 + 1) · header · reaction panel". */
  static describe(f: Pick<FormatSummary, 'slotCount' | 'rows' | 'hasHeader' | 'hasStatement' | 'hasReactionPanel'>): string {
    const n = f.slotCount;
    let shape = '';
    if (n > 1) {
      if (f.rows.length === 1) shape = ' side by side';
      else if (f.rows.every(c => c === 1)) shape = ' stacked';
      else shape = ` (${f.rows.join(' + ')})`;
    }
    return [`${n} image${n === 1 ? '' : 's'}${shape}`, f.hasHeader ? 'header' : null, f.hasStatement ? 'statement' : null, f.hasReactionPanel ? 'reaction panel' : null]
      .filter(Boolean)
      .join(' · ');
  }

  /** Public view of a saved layout (what the API and the web app show). */
  summaryOf(doc: any, position?: number): FormatSummary {
    const base = {
      slotCount: doc.slotCount,
      rows: [...(doc.rows || [])],
      hasHeader: Boolean(doc.hasHeader),
      hasStatement: Boolean(doc.hasStatement),
      hasReactionPanel: Boolean(doc.hasReactionPanel)
    };
    const description = FormatLibraryService.describe(base);
    return {
      formatId: doc.formatId,
      name: doc.name || null,
      displayName: doc.name || `Unnamed layout${position ? ` ${position}` : ''}`,
      description,
      status: doc.name ? 'named' : 'unnamed',
      source: doc.source,
      ...base,
      usageCount: doc.usageCount || 0,
      thumbnailUrl: doc.thumbnailFile ? `/output/${doc.thumbnailFile}` : null,
      createdAt: doc.createdAt
    };
  }

  /** Every saved layout, oldest first (the position in this list is the number users see). */
  async list(): Promise<FormatSummary[]> {
    const docs = await this.model.find({}).sort({ createdAt: 1, _id: 1 }).lean().exec();
    return docs.map((d, i) => this.summaryOf(d, i + 1));
  }

  /** The saved layout (full record) at a 1-based position of list(). */
  async getByPosition(position: number): Promise<any | null> {
    if (!Number.isInteger(position) || position < 1) return null;
    const docs = await this.model.find({}).sort({ createdAt: 1, _id: 1 }).lean().exec();
    return docs[position - 1] || null;
  }

  async get(formatId: string): Promise<any | null> {
    return this.model.findOne({ formatId }).lean().exec();
  }

  /**
   * Saves the layout of an analysed example. A structure that is already saved is not duplicated:
   * the existing layout is returned (created=false) and its usage is counted.
   */
  async saveFromAnalysis(
    a: ReferenceAnalysis,
    opts: { name?: unknown; source: FormatSource; referencePath?: string }
  ): Promise<{ format: any; created: boolean }> {
    if (!a.slots.length) throw new BadRequestException('No image slots were found in that example, so there is no layout to save.');
    const signature = FormatLibraryService.signatureOf(a);
    const name = cleanFormatName(opts.name);

    const existing = await this.model.findOne({ signature }).exec();
    if (existing) {
      existing.usageCount = (existing.usageCount || 0) + 1;
      existing.lastUsedAt = new Date();
      if (!existing.name && name) existing.name = name;   // an unnamed auto-saved layout gets the first name given
      await existing.save();
      return { format: existing.toObject(), created: false };
    }
    if ((await this.model.estimatedDocumentCount()) >= MAX_FORMATS) {
      throw new BadRequestException(`The layout library is full (${MAX_FORMATS}). Delete layouts you no longer use first.`);
    }

    const grid = deriveGridFromAnalysis(a);
    const rows: number[] = [];
    for (const s of a.slots) rows[s.row] = (rows[s.row] || 0) + 1;
    const headerFraction = a.header.present ? Math.min(0.16, Math.max(0, a.header.heightFraction || 0)) : null;
    const formatId = randomUUID();
    const thumbnailFile = opts.referencePath ? await this.writeThumbnail(formatId, opts.referencePath) : null;

    const created = await this.model.create({
      formatId,
      name,
      signature,
      source: opts.source,
      memeType: a.legacyMemeType,
      memeFormat: a.memeFormat,
      arrangement: arrangementFromAnalysis(a),
      grid: grid || null,
      slotCount: a.slots.length,
      rows: rows.filter(n => n !== undefined),
      hasHeader: a.header.present,
      headerHeightRatio: headerFraction,
      hasStatement: Boolean(a.overlayText.statement),
      hasBullets: a.overlayText.bulletPoints.length > 0,
      hasReactionPanel: a.reactionPanel.present,
      reactionHeightRatio: reactionRatioFromAnalysis(a) ?? null,
      thumbnailFile,
      usageCount: 1,
      lastUsedAt: new Date()
    });
    this.logger.log(`Saved new layout ${name ? `"${name}"` : '(unnamed)'}: ${signature}`);
    return { format: created.toObject(), created: true };
  }

  /** Called after a viral adaptation: remembers an unseen structure, counts a seen one. Never throws. */
  async recordSeen(a: ReferenceAnalysis, referencePath?: string): Promise<{ format: any; created: boolean } | null> {
    try {
      return await this.saveFromAnalysis(a, { source: 'viral_auto', referencePath });
    } catch (err: any) {
      this.logger.warn(`Could not record the layout of this reference: ${err?.message || err}`);
      return null;
    }
  }

  async rename(formatId: string, name: unknown): Promise<FormatSummary> {
    const clean = cleanFormatName(name);
    if (!clean) throw new BadRequestException('Give the layout a name (1-60 characters).');
    const doc = await this.model.findOneAndUpdate({ formatId }, { $set: { name: clean } }, { new: true }).lean().exec();
    if (!doc) throw new NotFoundException('Layout not found.');
    return this.summaryOf(doc);
  }

  async remove(formatId: string): Promise<{ deleted: boolean }> {
    const doc = await this.model.findOneAndDelete({ formatId }).lean().exec();
    if (!doc) throw new NotFoundException('Layout not found.');
    if (doc.thumbnailFile && /^format_[0-9a-f-]{36}\.jpg$/.test(doc.thumbnailFile)) {
      try { fs.rmSync(path.join(OUTPUT_ROOT, doc.thumbnailFile), { force: true }); } catch { /* ignore */ }
    }
    return { deleted: true };
  }

  async markUsed(formatId: string): Promise<void> {
    await this.model.updateOne({ formatId }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }).exec();
  }

  /** The layout request for generating a meme in this saved layout (the Settings style still applies). */
  static layoutFor(f: any, withHeadline: boolean): Partial<LayoutConfiguration> {
    const headerRatio = f.hasHeader && withHeadline && typeof f.headerHeightRatio === 'number' && f.headerHeightRatio > DEFAULT_HEADER_RATIO ? f.headerHeightRatio : undefined;
    const layout: Partial<LayoutConfiguration> = {
      memeType: f.memeType,
      arrangement: f.arrangement,
      gapSize: 0
    };
    if (f.grid) layout.grid = f.grid;
    if (headerRatio) layout.headerHeightRatio = headerRatio;
    if (typeof f.reactionHeightRatio === 'number') layout.reactionHeightRatio = f.reactionHeightRatio;
    return layout;
  }

  /** A small JPEG preview of the example, stored in /output (public) as format_<id>.jpg. */
  private async writeThumbnail(formatId: string, referencePath: string): Promise<string | null> {
    try {
      const img = await loadImage(fs.readFileSync(referencePath));
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const file = `format_${formatId}.jpg`;
      fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT_ROOT, file), c.toBuffer('image/jpeg', 82));
      return file;
    } catch {
      return null;
    }
  }
}
