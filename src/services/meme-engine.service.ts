import {
  Injectable,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
  Logger,
  UnprocessableEntityException,
  ConflictException,
  Optional
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { loadImage } from '@napi-rs/canvas';
import * as path from 'path';
import * as fs from 'fs';
import { LayoutEngineService, ComputedMemeLayout } from './layout-engine.service';
import { CanvasRendererService, RenderResult } from './canvas-renderer.service';
import { layoutAndRender } from './render-pipeline';
import { DesignProfileService } from '../design/design-profile.service';
import { isStyleSnapshot } from '../design/render-style';
import { assertSlot, ImageSelectionService, StagedImage, StagedPublic } from './image-selection.service';
import { applyOps, describeOp, InterpretationContext, RegenerationService } from './regeneration.service';
import { Meme, MemeDocument } from '../schemas/meme.schema';
import { MemeImage, MemeImageDocument } from '../schemas/meme-image.schema';
import {
  MemeContent,
  MemeAssets,
  UploadedAsset,
  DesignSpecifications,
  LayoutConfiguration,
  ImageChangeRecord,
  GridSpec
} from '../types/meme.types';
import {
  APPROVED_READ_ROOTS,
  OUTPUT_ROOT,
  UPLOADS_ROOT,
  resolveApprovedFile,
  safeDeleteFile
} from '../security/path-guard';
import { ImageValidationError, MAX_UPLOAD_BYTES, MIME_BY_TYPE, inspectImageFileHeader, verifyImageBuffer } from '../security/image-verify';
import { escapeRegex, THUMB_WIDTHS } from '../security/request-validation';
import { ThumbnailService } from './thumbnail.service';
import { safeFetch } from '../security/safe-fetch';
import { getConfig } from '../config/app-config';
import { sha256 } from '../discovery/image-fingerprint';
import { buildRightsInfo, classifyLicense } from '../discovery/rights';

export interface GenerateMemeInput {
  content: MemeContent;
  assets: MemeAssets;
  design?: Partial<DesignSpecifications>;
  layout?: Partial<LayoutConfiguration>;
}

export interface GenerateMemeOptions {
  pipeline?: string;
  referenceImage?: UploadedAsset;
  generationReport?: Record<string, any>;
}

export interface MemeFilterQuery {
  search?: string;
  type?: string;
  sort?: 'newest' | 'oldest';
}

const DISCOVERED_DIR = path.join(UPLOADS_ROOT, 'internet-discovered');
const plain = (v: any) => (v && typeof v.toObject === 'function' ? v.toObject() : v);

@Injectable()
export class MemeEngineService implements OnModuleInit {
  private readonly logger = new Logger(MemeEngineService.name);
  private readonly outputDir = OUTPUT_ROOT;

  constructor(
    @InjectModel(Meme.name) private readonly memeModel: Model<MemeDocument>,
    private readonly layoutEngine: LayoutEngineService,
    private readonly canvasRenderer: CanvasRendererService,
    private readonly regenerationService: RegenerationService,
    /** Saved Settings (absent in unit tests: new memes then use the original house constants). */
    @Optional() private readonly profiles?: DesignProfileService,
    /** Staged image choices for image replacement (absent in unit tests). */
    @Optional() private readonly selection?: ImageSelectionService,
    /** Makes the gallery's small copies as soon as a meme is saved (absent in unit tests: they are then made on first view). */
    @Optional() private readonly thumbnails?: ThumbnailService,
    @Optional() @InjectModel(MemeImage.name) private readonly memeImageModel?: Model<MemeImageDocument>
  ) {}

  onModuleInit() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Retrieves all memes from MongoDB with optional search, filter and sort.
   * The (large) generation report is not included in lists; fetch it with getReport().
   */
  /**
   * One page of the gallery with only what a card needs. A full record is ~13 KB (every version, its design,
   * its assets); a card needs ~1 KB, so the list stays quick however many memes there are. `versionCount`
   * replaces the versions array and `lite: true` tells the app to fetch the full meme when one is opened.
   */
  async listMemes(query: MemeFilterQuery & { limit?: number; skip?: number }): Promise<{ items: any[]; total: number }> {
    const filter = this.buildFilter(query);
    const limit = Math.min(Math.max(query.limit ?? 24, 1), 60);
    const skip = Math.max(query.skip ?? 0, 0);
    const sortOrder = query.sort === 'oldest' ? 1 : -1;
    const [rows, total] = await Promise.all([
      this.memeModel
        .find(filter)
        .select('memeId createdAt currentVersion content.topic content.headline content.punchline layout.memeType pipeline instagramPublish.status outputUrls versions.versionNumber')
        .sort({ createdAt: sortOrder, _id: sortOrder }) // _id breaks ties so paging never repeats or skips a meme
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.memeModel.countDocuments(filter).exec()
    ]);
    const items = (rows as any[]).map(({ versions, _id, __v, ...m }) => ({ ...m, versionCount: Array.isArray(versions) ? versions.length : 1, lite: true }));
    return { items, total };
  }

  /** Search / type filter shared by the full and the paged list. Only plain strings may reach the query. */
  private buildFilter(query?: MemeFilterQuery): any {
    const filter: any = {};
    if (typeof query?.type === 'string' && query.type !== 'all') filter['layout.memeType'] = query.type;
    if (typeof query?.search === 'string' && query.search.trim()) {
      const s = escapeRegex(query.search.trim().slice(0, 100));
      filter.$or = [
        { 'content.topic': { $regex: s, $options: 'i' } },
        { 'content.headline': { $regex: s, $options: 'i' } },
        { 'content.statement': { $regex: s, $options: 'i' } },
        { 'content.punchline': { $regex: s, $options: 'i' } }
      ];
    }
    return filter;
  }

  /** Where a version's output image lives (JPEG preferred: smaller to decode), or null. Used for thumbnails. */
  async resolveOutputFile(memeId: string, version?: number): Promise<{ path: string; version: number } | null> {
    const m: any = await this.memeModel.findOne({ memeId }).select('currentVersion outputPaths versions.versionNumber versions.outputPaths').lean().exec();
    if (!m) return null;
    const wanted = version ?? m.currentVersion ?? 1;
    const v = (m.versions || []).find((x: any) => x.versionNumber === wanted);
    const paths = v?.outputPaths || (wanted === (m.currentVersion ?? 1) ? m.outputPaths : null);
    const file = paths?.jpeg || paths?.png;
    const targetPath = file || path.join(this.outputDir, `meme_${memeId}_v${wanted}.jpeg`);

    // If the file does not exist on disk (e.g. after container restart on ephemeral storage), restore from MongoDB!
    if (!fs.existsSync(targetPath)) {
      const buf = await this.getImageBuffer(memeId, wanted, 'jpeg');
      if (buf) {
        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, buf);
          this.logger.log(`Restored meme image ${memeId} v${wanted} to disk from MongoDB.`);
        } catch (e: any) {
          this.logger.warn(`Could not restore file to disk: ${e.message}`);
        }
      } else {
        return null;
      }
    }
    return { path: targetPath, version: wanted };
  }

  async getAllMemes(query?: MemeFilterQuery): Promise<Meme[]> {
    const filter: any = {};

    // Only plain strings may reach the query: an object here would be a MongoDB operator injection.
    if (typeof query?.type === 'string' && query.type !== 'all') {
      filter['layout.memeType'] = query.type;
    }

    if (typeof query?.search === 'string' && query.search.trim()) {
      const s = escapeRegex(query.search.trim().slice(0, 100));
      filter.$or = [
        { 'content.topic': { $regex: s, $options: 'i' } },
        { 'content.headline': { $regex: s, $options: 'i' } },
        { 'content.statement': { $regex: s, $options: 'i' } },
        { 'content.punchline': { $regex: s, $options: 'i' } }
      ];
    }

    const sortOrder = query?.sort === 'oldest' ? 1 : -1;
    return this.memeModel.find(filter).select('-generationReport').sort({ createdAt: sortOrder }).exec();
  }

  async getMemeById(memeId: string): Promise<MemeDocument> {
    if (typeof memeId !== 'string') {
      throw new BadRequestException('Invalid meme id');
    }
    const meme = await this.memeModel.findOne({ memeId }).exec();
    if (!meme) {
      throw new NotFoundException(`Meme with ID ${memeId} not found in database`);
    }
    return meme;
  }

  /** Explainability record of a viral adaptation (or a short note for other memes). */
  async getReport(memeId: string): Promise<Record<string, any>> {
    const meme = await this.getMemeById(memeId);
    const report = plain(meme.generationReport);
    return {
      memeId,
      pipeline: meme.pipeline || 'manual',
      hasReferenceImage: Boolean(meme.referenceImage),
      currentVersion: meme.currentVersion,
      report: report || null,
      assets: {
        subjects: (meme.assets?.subjectImages || []).map((a: any, i: number) => ({
          index: i,
          label: a.label,
          sourceUrl: a.sourceUrl,
          sourcePage: a.sourcePage,
          license: a.license,
          attribution: a.attribution,
          width: a.width,
          height: a.height
        })),
        reaction: meme.assets?.reactionImage ? { width: meme.assets.reactionImage.width, height: meme.assets.reactionImage.height } : null
      }
    };
  }

  /** Path of one of the meme's images, for the private (local-only) thumbnail endpoint. */
  async resolveAssetFile(memeId: string, which: string): Promise<{ path: string; mime: string }> {
    const meme = await this.getMemeById(memeId);
    let asset: any;
    let subjectIdx: number | null = null;
    if (which === 'reaction') asset = meme.assets?.reactionImage;
    else if (which === 'reference') asset = meme.referenceImage;
    else if (/^subject-\d{1,2}$/.test(which)) {
      subjectIdx = Number(which.split('-')[1]);
      asset = meme.assets?.subjectImages?.[subjectIdx];
    }
    else throw new BadRequestException('Unknown image');

    let real = asset ? resolveApprovedFile(asset.path, APPROVED_READ_ROOTS) : null;
    if (!real && subjectIdx !== null && this.memeImageModel) {
      try {
        const doc = await this.memeImageModel.findOne({ memeId, version: meme.currentVersion || 1 }).select('+subjects').lean().exec();
        const s = doc?.subjects?.find((item: any) => item.index === subjectIdx);
        if (s?.data) {
          const destPath = asset?.path || path.join(UPLOADS_ROOT, `${memeId}_subject_${subjectIdx}.${s.mime?.includes('png') ? 'png' : 'jpg'}`);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, s.data);
          real = destPath;
        }
      } catch {}
    }
    if (!real) throw new NotFoundException('Image not available');
    const header = inspectImageFileHeader(real);
    return { path: real, mime: MIME_BY_TYPE[header.type] };
  }

  /**
   * Every image the renderer will read must be an existing JPEG/PNG/WebP file inside an approved
   * application directory. Paths are canonicalised (symlinks resolved), so a client-supplied path
   * can never make the server read, or later delete, a file outside application storage.
   */
  private approveAssets(assets: MemeAssets): MemeAssets {
    const approve = (a: UploadedAsset, label: string): UploadedAsset => {
      const real = resolveApprovedFile(a?.path, APPROVED_READ_ROOTS);
      if (!real) {
        throw new BadRequestException(`${label}: image file is missing or outside the application's image storage`);
      }
      try {
        const header = inspectImageFileHeader(real);
        return { ...a, path: real, filename: path.basename(real), mimeType: MIME_BY_TYPE[header.type] };
      } catch (err: any) {
        if (err instanceof ImageValidationError) throw new BadRequestException(`${label}: ${err.message}`);
        throw err;
      }
    };

    const subjects = (assets?.subjectImages || []).map((a, i) => approve(a, `Subject image ${i + 1}`));
    const reactionImage = assets?.reactionImage ? approve(assets.reactionImage, 'Reaction image') : undefined;
    return { subjectImages: subjects, reactionImage };
  }

  private async measureAssets(assets: MemeAssets, loader: (p: string) => Promise<any> = loadImage): Promise<{ subjectAspectRatios: number[]; reactionAspectRatio: number }> {
    const subjectAspectRatios: number[] = [];
    for (const asset of assets.subjectImages || []) {
      try {
        const img = await loader(asset.path);
        asset.width = img.width;
        asset.height = img.height;
        asset.aspectRatio = Math.round((img.width / img.height) * 1000) / 1000;
        asset.orientation = asset.aspectRatio < 0.95 ? 'portrait' : (asset.aspectRatio > 1.15 ? 'landscape' : 'square');
        subjectAspectRatios.push(asset.aspectRatio);
      } catch (e: any) {
        throw new UnprocessableEntityException(`Subject image "${asset.originalName}" could not be decoded: ${e.message}`);
      }
    }
    let reactionAspectRatio = 16 / 9;
    if (assets.reactionImage) {
      try {
        const rxImg = await loader(assets.reactionImage.path);
        assets.reactionImage.width = rxImg.width;
        assets.reactionImage.height = rxImg.height;
        assets.reactionImage.aspectRatio = Math.round((rxImg.width / rxImg.height) * 1000) / 1000;
        assets.reactionImage.orientation = 'landscape';
        reactionAspectRatio = assets.reactionImage.aspectRatio;
      } catch (e: any) {
        throw new UnprocessableEntityException(`Reaction image could not be decoded: ${e.message}`);
      }
    }
    return { subjectAspectRatios, reactionAspectRatio };
  }

  /**
   * Lays out and renders. If the headline needs more room the header grows (bounded by the meme's
   * style); any other text that cannot fit, or a structurally invalid render, becomes a clear 422.
   */
  private layoutAndRender(
    design: DesignSpecifications,
    layoutCfg: Partial<LayoutConfiguration>,
    content: MemeContent,
    assets: MemeAssets,
    ratios: { subjectAspectRatios: number[]; reactionAspectRatio: number }
  ): Promise<{ computed: ComputedMemeLayout; render: RenderResult; headerHeightRatio?: number; attempts: number }> {
    return layoutAndRender(this.layoutEngine, this.canvasRenderer, design, layoutCfg, content, assets, ratios);
  }

  /**
   * Design of a NEW meme: the saved Settings (with the style snapshot the meme keeps for life), and
   * on top of them the values sent with this request (the per-meme choices of the create form).
   */
  private async designForNewMeme(d: Partial<DesignSpecifications> | undefined): Promise<DesignSpecifications> {
    if (isStyleSnapshot(d?.style) || !this.profiles) return this.normalizeDesign(d);
    const base = await this.profiles.newMemeDesign(d?.fontFamily);
    const own = Object.fromEntries(Object.entries(d || {}).filter(([k, v]) => v !== undefined && k !== 'style'));
    return this.normalizeDesign({ ...base, ...own, style: base.style });
  }

  private normalizeDesign(d: Partial<DesignSpecifications> | undefined): DesignSpecifications {
    const preset = d?.canvasPreset || 'portrait_4_5';
    return {
      fontFamily: d?.fontFamily || 'Arial Black',
      teluguFontFamily: d?.teluguFontFamily || 'Ramabhadra',
      canvasPreset: preset,
      width: 1080,
      height: preset === 'square_1_1' ? 1080 : preset === 'story_9_16' ? 1920 : 1350,
      primaryTextColor: d?.primaryTextColor || '#FFE500',
      secondaryTextColor: d?.secondaryTextColor || '#FFFFFF',
      headerBgColor: d?.headerBgColor || '#000000',
      headerTextColor: d?.headerTextColor || '#FFE500',
      outlineColor: d?.outlineColor || '#000000',
      outlineThickness: d?.outlineThickness !== undefined ? Number(d.outlineThickness) : 7,
      shadowColor: d?.shadowColor || 'rgba(0,0,0,0.92)',
      shadowBlur: d?.shadowBlur !== undefined ? Number(d.shadowBlur) : 8,
      shadowOffsetX: 3,
      shadowOffsetY: 3,
      fontSizeScale: d?.fontSizeScale !== undefined ? Number(d.fontSizeScale) : 1.0,
      textScales: d?.textScales ? { ...d.textScales } : {},
      textAlignment: d?.textAlignment || 'center',
      customInstructions: d?.customInstructions,
      // preserve subjectFit (cover vs contain)
      ...(d?.subjectFit ? { subjectFit: d.subjectFit } : {}),
      // how the owner framed the reaction image (kept through regeneration)
      ...(d?.reactionFraming ? { reactionFraming: d.reactionFraming } : {}),
      // the meme's own settings snapshot (kept through regeneration; older memes have none)
      ...(isStyleSnapshot(d?.style) ? { style: d!.style } : {})
    };
  }

  /**
   * Makes the gallery's small copies in the background right after a meme is saved, so the first time the gallery opens
   * nothing has to be made on demand. Never delays or fails the save: if one is missing it is simply made on first view.
   */
  private warmThumbnails(memeId: string, version: number, source: string) {
    if (!this.thumbnails) return;
    for (const width of THUMB_WIDTHS) {
      this.thumbnails.ensure(source, `${memeId}_v${version}`, width).catch(err => this.logger.debug(`Thumbnail ${width}px for ${memeId} v${version} not made yet: ${err?.message || err}`));
    }
  }

  private writeOutputs(memeId: string, version: number, render: RenderResult, subjectImages?: UploadedAsset[]) {
    const pngFilename = `meme_${memeId}_v${version}.png`;
    const jpegFilename = `meme_${memeId}_v${version}.jpeg`;
    const pngPath = path.join(this.outputDir, pngFilename);
    const jpegPath = path.join(this.outputDir, jpegFilename);
    fs.writeFileSync(pngPath, render.pngBuffer);
    fs.writeFileSync(jpegPath, render.jpegBuffer);
    this.warmThumbnails(memeId, version, jpegPath);
    this.persistImageBuffers(memeId, version, render.jpegBuffer, render.pngBuffer, undefined, subjectImages);
    return { outputPaths: { png: pngPath, jpeg: jpegPath }, outputUrls: { png: `/output/${pngFilename}`, jpeg: `/output/${jpegFilename}` } };
  }

  /**
   * Persists binary image buffers into MongoDB so they survive ephemeral container restarts (e.g. Render).
   */
  async persistImageBuffers(
    memeId: string,
    version: number,
    jpeg: Buffer,
    png?: Buffer,
    thumb?: Buffer,
    subjectImages?: UploadedAsset[]
  ): Promise<void> {
    if (!this.memeImageModel) return;
    try {
      const subjects: { index: number; data: Buffer; mime: string }[] = [];
      if (subjectImages && Array.isArray(subjectImages)) {
        for (let i = 0; i < subjectImages.length; i++) {
          const img = subjectImages[i];
          if (img?.path && fs.existsSync(img.path)) {
            try {
              const buf = fs.readFileSync(img.path);
              subjects.push({ index: i, data: buf, mime: img.mimeType || 'image/jpeg' });
            } catch {}
          }
        }
      }

      await this.memeImageModel.updateOne(
        { memeId, version },
        {
          $set: {
            memeId,
            version,
            jpeg,
            ...(png ? { png } : {}),
            ...(thumb ? { thumb } : {}),
            ...(subjects.length > 0 ? { subjects } : {})
          }
        },
        { upsert: true }
      );
      this.logger.debug(`Persisted meme image ${memeId} v${version} to MongoDB.`);
    } catch (err: any) {
      this.logger.warn(`Failed to persist meme ${memeId} v${version} to MongoDB: ${err?.message || err}`);
    }
  }

  /**
   * Retrieves binary image buffer from MongoDB for a given meme version.
   */
  async getImageBuffer(memeId: string, version = 1, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer | null> {
    if (!this.memeImageModel) return null;
    try {
      const selectField = format === 'png' ? '+png +jpeg' : '+jpeg';
      const img = await this.memeImageModel.findOne({ memeId, version }).select(selectField).lean().exec();
      if (!img) return null;
      if (format === 'png') {
        return (img as any).png || (img as any).jpeg || null;
      }
      return (img as any).jpeg || null;
    } catch (err: any) {
      this.logger.warn(`Failed to get image buffer for ${memeId} v${version}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Generates a new meme (Version 1) and persists document to MongoDB
   */
  async generateMeme(rawInput: GenerateMemeInput, options: GenerateMemeOptions = {}): Promise<MemeDocument> {
    const input: GenerateMemeInput = { ...rawInput, assets: this.approveAssets(rawInput.assets) };
    const memeId = randomUUID();
    const fullDesign = await this.designForNewMeme(input.design);
    const ratios = await this.measureAssets(input.assets);
    const memeType = input.layout?.memeType || 'trending_news';

    const { computed, render, headerHeightRatio, attempts } = await this.layoutAndRender(fullDesign, { ...input.layout, memeType }, input.content, input.assets, ratios);
    const outputs = this.writeOutputs(memeId, 1, render, input.assets.subjectImages);

    const fullLayout: LayoutConfiguration = {
      memeType,
      arrangement: computed.arrangement,
      hasHeaderBanner: Boolean(input.content.headline),
      headerHeightRatio: computed.headerBox ? computed.headerBox.height / computed.canvasHeight : 0,
      reactionHeightRatio: computed.reactionBox ? computed.reactionBox.height / computed.canvasHeight : 0,
      reactionPosition: 'bottom',
      subjectSectionRatio: computed.subjectSectionBox.height / computed.canvasHeight,
      gapSize: input.layout?.gapSize ?? 0,
      grid: input.layout?.grid
    };

    const report = options.generationReport ? { ...options.generationReport } : undefined;
    if (report) {
      report.render = { textFit: render.textFit, headerHeightRatio: headerHeightRatio ?? null, fitAttempts: attempts, arrangement: computed.arrangement, canvas: `${render.width}x${render.height}` };
    }

    const assetsSnapshot = JSON.parse(JSON.stringify(input.assets));
    const createdMeme = new this.memeModel({
      memeId,
      currentVersion: 1,
      content: input.content,
      assets: input.assets,
      design: fullDesign,
      layout: fullLayout,
      ...outputs,
      pipeline: options.pipeline || 'manual',
      referenceImage: options.referenceImage,
      generationReport: report,
      versions: [{
        versionNumber: 1,
        instruction: 'Initial Generation',
        createdAt: new Date(),
        design: fullDesign,
        layout: fullLayout,
        content: input.content,
        ...outputs,
        appliedChanges: [],
        interpreter: 'initial',
        assets: assetsSnapshot
      }]
    });

    return createdMeme.save();
  }

  /** Next verified alternate for a slot, re-downloaded and checked byte-for-byte against the verified hash. */
  private async replaceSlotImage(meme: MemeDocument, assets: MemeAssets, slotNumber: number): Promise<{ asset: UploadedAsset; note: string }> {
    const report = plain(meme.generationReport);
    const slotReport = report?.slots?.[slotNumber - 1];
    const current = assets.subjectImages?.[slotNumber - 1];
    if (current?.selectedBy === 'user') {
      throw new UnprocessableEntityException(`You chose the image in slot ${slotNumber} yourself, so the AI will not replace it. Use "Replace Image" to change it.`);
    }
    if (!slotReport || !current) throw new UnprocessableEntityException(`Slot ${slotNumber} has no verified alternate images.`);
    const usedShas = new Set<string>();
    for (const v of meme.versions || []) for (const a of (plain(v.assets)?.subjectImages || [])) if (a?.sha256) usedShas.add(a.sha256);
    for (const a of assets.subjectImages || []) if (a?.sha256) usedShas.add(a.sha256);
    if (slotReport.selected?.sha256) usedShas.add(slotReport.selected.sha256);
    const next = (slotReport.alternates || []).find((a: any) => a?.sha256 && a?.sourceUrl && a?.stored !== false && !usedShas.has(a.sha256));
    if (!next) throw new UnprocessableEntityException(`All verified alternate images for slot ${slotNumber} have already been used.`);

    const cfg = getConfig().discovery;
    const res = await safeFetch(next.sourceUrl, { timeoutMs: cfg.downloadTimeoutMs, maxBytes: MAX_UPLOAD_BYTES, userAgent: cfg.userAgent });
    if (sha256(res.body) !== next.sha256) {
      throw new UnprocessableEntityException(`The verified alternate for slot ${slotNumber} has changed at its source, so it was not used.`);
    }
    const v = await verifyImageBuffer(res.body);
    fs.mkdirSync(DISCOVERED_DIR, { recursive: true });
    const filename = `internet_${randomUUID()}${v.ext}`;
    const p = path.join(DISCOVERED_DIR, filename);
    fs.writeFileSync(p, res.body);
    return {
      asset: {
        ...current,
        id: randomUUID(),
        originalName: String(next.title || filename).slice(0, 120),
        filename,
        path: p,
        mimeType: v.mime,
        width: v.width,
        height: v.height,
        aspectRatio: Number((v.width / v.height).toFixed(4)),
        sourceUrl: next.sourceUrl,
        sourcePage: next.pageUrl,
        license: next.license,
        attribution: next.attribution,
        sha256: next.sha256,
        focalX: next.focus?.x,
        focalY: next.focus?.y,
        provider: next.provider,
        // the new picture's own rights, never the replaced one's
        rights: buildRightsInfo({
          classification: classifyLicense(next.license, { nonFree: /non-?free|fair use/i.test(String(next.license || '')) }),
          license: next.license,
          attribution: next.attribution,
          provider: next.provider,
          basis: `licence metadata recorded when ${next.provider} found this verified alternate`,
          sourceStored: true
        }),
        referenceMatch: next.referenceMatch?.level
      },
      note: `Slot ${slotNumber}: replaced with "${String(next.title || '').slice(0, 60)}" (${next.provider})`
    };
  }

  /**
   * Natural-language regeneration: the instruction becomes validated, structured changes; the
   * punchline, reaction image and subject identities are never changed. Creates version max+1.
   */
  async regenerateWithInstruction(memeId: string, instruction: string): Promise<MemeDocument> {
    const meme = await this.getMemeById(memeId);
    const currentDesign = this.normalizeDesign(plain(meme.design));
    const currentLayout: LayoutConfiguration = plain(meme.layout);
    const currentContent: MemeContent = plain(meme.content);
    const storedAssets: MemeAssets = plain(meme.assets);
    let assets = this.approveAssets(JSON.parse(JSON.stringify(storedAssets)));

    const report = plain(meme.generationReport);
    const ctx: InterpretationContext = {
      design: currentDesign,
      layout: currentLayout,
      content: currentContent,
      slots: (assets.subjectImages || []).map((a, i) => ({
        slot: i + 1,
        subject: String(report?.slots?.[i]?.subject || a.label || `image ${i + 1}`).slice(0, 60),
        alternatesAvailable: (report?.slots?.[i]?.alternates || []).length
      }))
    };

    const interpretation = await this.regenerationService.interpret(instruction, ctx);
    if (interpretation.status === 'clarify') {
      throw new UnprocessableEntityException({ statusCode: 422, clarification: true, question: interpretation.question, message: interpretation.question });
    }
    if (interpretation.status === 'unsupported') {
      throw new UnprocessableEntityException({ statusCode: 422, clarification: false, message: interpretation.summary || 'That change is not supported by the meme engine.' });
    }

    let updatedDesign: DesignSpecifications;
    let updatedLayout: LayoutConfiguration;
    const appliedChanges: string[] = [];
    if (interpretation.interpreter === 'ai') {
      const applied = applyOps(interpretation.ops, currentDesign, currentLayout);
      updatedDesign = applied.design;
      updatedLayout = applied.layout;
      appliedChanges.push(...interpretation.ops.filter(o => o.op !== 'replace_slot_image').map(describeOp));
      if (interpretation.ops.some(o => o.op === 'equalize_slots') && !currentLayout.grid) {
        appliedChanges.push('Subject images already use equal sizes in this layout');
      }
      if (applied.slotReplacements.length) {
        const subjects = [...assets.subjectImages];
        for (const slot of applied.slotReplacements) {
          const { asset, note } = await this.replaceSlotImage(meme, { ...assets, subjectImages: subjects }, slot);
          subjects[slot - 1] = asset;
          appliedChanges.push(note);
        }
        assets = this.approveAssets({ ...assets, subjectImages: subjects });
      }
    } else {
      const kw = this.regenerationService.parseInstruction(instruction, currentDesign, currentLayout, currentContent);
      updatedDesign = this.normalizeDesign(kw.updatedDesign);
      updatedLayout = kw.updatedLayout;
      appliedChanges.push(...kw.appliedChanges);
    }

    const ratios = await this.measureAssets(assets);
    const { computed, render } = await this.layoutAndRender(updatedDesign, updatedLayout, currentContent, assets, ratios);
    if (computed.reactionBox) updatedLayout.reactionHeightRatio = Math.round((computed.reactionBox.height / computed.canvasHeight) * 1000) / 1000;
    if (computed.headerBox) updatedLayout.headerHeightRatio = Math.round((computed.headerBox.height / computed.canvasHeight) * 1000) / 1000;

    const nextVersion = Math.max(meme.currentVersion || 1, ...(meme.versions || []).map(v => v.versionNumber || 0)) + 1;
    const outputs = this.writeOutputs(memeId, nextVersion, render, assets.subjectImages);

    meme.currentVersion = nextVersion;
    meme.design = updatedDesign as any;
    meme.layout = updatedLayout as any;
    meme.content = currentContent as any;
    meme.assets = assets as any;
    meme.outputPaths = outputs.outputPaths;
    meme.outputUrls = outputs.outputUrls;
    meme.versions.push({
      versionNumber: nextVersion,
      instruction: instruction.trim(),
      createdAt: new Date(),
      design: updatedDesign,
      layout: updatedLayout,
      content: currentContent,
      ...outputs,
      appliedChanges,
      interpreter: interpretation.interpreter,
      assets: JSON.parse(JSON.stringify(assets))
    } as any);

    return meme.save();
  }

  // ---------------------------------------------------------------------------------------------
  // Image replacement (no manual editor): swap chosen subject images, keep everything else
  // ---------------------------------------------------------------------------------------------

  private readonly replacing = new Set<string>();

  private requireSelection(): ImageSelectionService {
    if (!this.selection) throw new BadRequestException('Image replacement is not available.');
    return this.selection;
  }

  /**
   * Candidates already found during the original discovery for one slot (the AI's own first pick
   * and its verified alternates), staged for preview. The picture currently in the slot is left out.
   */
  async getSlotCandidates(memeId: string, slot: number): Promise<{ slot: number; candidates: StagedPublic[]; notes: string[] }> {
    const selection = this.requireSelection();
    const meme = await this.getMemeById(memeId);
    const assets: MemeAssets = plain(meme.assets);
    const n = assertSlot(slot, (assets.subjectImages || []).length);
    const current = assets.subjectImages[n - 1];
    const slotReport = plain(meme.generationReport)?.slots?.[n - 1];
    const notes: string[] = [];
    const pool: any[] = [];
    const sel = slotReport?.selected;
    if (sel?.sourceUrl && sel?.sha256) {
      pool.push({ sourceUrl: sel.sourceUrl, sha256: sel.sha256, title: sel.title ? `${sel.title} (original pick)` : 'Original pick', provider: sel.provider, pageUrl: sel.pageUrl, license: sel.license, attribution: sel.attribution, focus: sel.visual?.subjectFocus, referenceMatch: sel.referenceMatch, rights: sel.rights });
    }
    for (const a of slotReport?.alternates || []) {
      if (!a?.sha256 || !a?.sourceUrl || a?.stored === false) continue;
      pool.push({
        ...a,
        rights: buildRightsInfo({
          classification: classifyLicense(a.license, { nonFree: /non-?free|fair use/i.test(String(a.license || '')) }),
          license: a.license,
          attribution: a.attribution,
          provider: a.provider,
          basis: `licence metadata recorded when ${a.provider} found this verified alternate`,
          sourceStored: true
        })
      });
    }
    const seen = new Set<string>(current?.sha256 ? [current.sha256] : []);
    const unique = pool.filter(p => (seen.has(p.sha256) ? false : (seen.add(p.sha256), true)));
    if (!unique.length) notes.push(slotReport ? 'No other verified candidates were kept for this image.' : 'This meme has no discovery record, so there are no earlier candidates.');
    const staged = (await Promise.all(unique.slice(0, 6).map(p => selection.stageDiscovered(p)))).filter(Boolean) as StagedImage[];
    if (unique.length && staged.length < Math.min(6, unique.length)) notes.push('Some candidates could no longer be downloaded or have changed at their source, so they are not offered.');
    return { slot: n, candidates: staged.map(s => selection.toPublic(s)), notes };
  }

  /** Validates a replacement request against the meme as it is now. */
  private async loadForReplacement(memeId: string, rawChanges: unknown, baseVersion?: unknown) {
    const selection = this.requireSelection();
    const meme = await this.getMemeById(memeId);
    if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== (meme.currentVersion || 1)) {
      throw new ConflictException('This meme has changed since you opened it. Reload the page and try again.');
    }
    const assets: MemeAssets = plain(meme.assets);
    const count = (assets.subjectImages || []).length;
    if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > count) throw new BadRequestException(`Provide 1-${count} image changes: [{ "slot": 1, "token": "..." }].`);
    const changes: { slot: number; st: StagedImage }[] = [];
    const slots = new Set<number>();
    const shas = new Set<string>();
    for (const c of rawChanges) {
      if (!c || typeof c !== 'object') throw new BadRequestException('Each change must be an object with a slot and a token.');
      const slot = assertSlot((c as any).slot, count);
      if (slots.has(slot)) throw new BadRequestException(`Image ${slot} appears twice.`);
      slots.add(slot);
      const st = selection.get((c as any).token);
      if (shas.has(st.sha256)) throw new UnprocessableEntityException('The same picture was chosen for two images.');
      shas.add(st.sha256);
      changes.push({ slot, st });
    }
    for (const { slot, st } of changes) {
      const prev = assets.subjectImages[slot - 1];
      if (prev?.sha256 && prev.sha256 === st.sha256) throw new UnprocessableEntityException(`Image ${slot} already is this picture.`);
      const other = assets.subjectImages.findIndex((a, i) => !slots.has(i + 1) && a?.sha256 && a.sha256 === st.sha256);
      if (other >= 0) throw new UnprocessableEntityException(`That picture is already used as image ${other + 1}.`);
    }
    return { meme, assets, changes, selection };
  }

  /** Whole-meme preview of a pending replacement, rendered in memory (nothing is saved). */
  async previewImageReplacement(memeId: string, rawChanges: unknown, baseVersion?: unknown): Promise<{ image: string; width: number; height: number }> {
    const { meme, assets, changes, selection } = await this.loadForReplacement(memeId, rawChanges, baseVersion);
    const design = this.normalizeDesign(plain(meme.design));
    const layout: LayoutConfiguration = plain(meme.layout);
    const content: MemeContent = plain(meme.content);
    const approved = this.approveAssets(JSON.parse(JSON.stringify(assets)));
    const subjects = approved.subjectImages;
    for (const { slot, st } of changes) subjects[slot - 1] = { ...subjects[slot - 1], path: `staged:${st.token}`, focalX: st.focus?.x, focalY: st.focus?.y };
    const stagedImg = async (p: string) => (p.startsWith('staged:') ? loadImage(selection.get(p.slice(7)).buf) : loadImage(p));
    const preview: MemeAssets = { subjectImages: subjects, reactionImage: approved.reactionImage };
    const ratios = await this.measureAssets(preview, stagedImg);
    const { render } = await layoutAndRender(this.layoutEngine, this.canvasRenderer, design, layout, content, preview, ratios, { formats: ['jpeg'], loadImage: stagedImg });
    return { image: `data:image/jpeg;base64,${render.jpegBuffer.toString('base64')}`, width: render.width, height: render.height };
  }

  /**
   * Applies the replacement: only the chosen slots change; layout, design, text, punchline and
   * reaction image are reused as stored. Creates the next version (older versions are never touched).
   */
  async applyImageReplacement(memeId: string, rawChanges: unknown, baseVersion?: unknown): Promise<MemeDocument> {
    if (this.replacing.has(memeId)) throw new ConflictException('An image change for this meme is already being applied.');
    this.replacing.add(memeId);
    const written: string[] = [];
    try {
      const { meme, assets, changes, selection } = await this.loadForReplacement(memeId, rawChanges, baseVersion);
      const design = this.normalizeDesign(plain(meme.design));
      const layout: LayoutConfiguration = plain(meme.layout);
      const content: MemeContent = plain(meme.content);

      const subjects = JSON.parse(JSON.stringify(assets.subjectImages)) as UploadedAsset[];
      const imageChanges: ImageChangeRecord[] = [];
      const appliedChanges: string[] = [];
      const at = new Date().toISOString();
      for (const { slot, st } of changes) {
        const prev = subjects[slot - 1];
        const file = selection.writeToDisk(st);
        written.push(file.path);
        const next = selection.assetFor(st, file, prev, true);
        subjects[slot - 1] = next;
        imageChanges.push({
          slot,
          at,
          sourceType: st.sourceType,
          sourceUrl: next.sourceUrl,
          previous: { assetId: prev.id, filename: prev.filename, sha256: prev.sha256, sourceType: prev.sourceType || (prev.provider ? 'ai_discovery' : 'user_upload'), sourceUrl: prev.sourceUrl, provider: prev.provider },
          replacement: { assetId: next.id, filename: next.filename, originalName: next.originalName, sha256: next.sha256, provider: next.provider, sourcePage: next.sourcePage, license: next.license, rights: next.rights, width: next.width, height: next.height }
        });
        const how = st.sourceType === 'user_upload' ? 'your upload' : st.sourceType === 'online_search' ? `online search${st.provider ? ` (${st.provider})` : ''}` : 'an earlier discovered candidate';
        appliedChanges.push(`Image ${slot} replaced with ${how}: ${String(next.originalName).slice(0, 60)}`);
      }

      const newAssets = this.approveAssets({ subjectImages: subjects, reactionImage: assets.reactionImage });
      const ratios = await this.measureAssets(newAssets);
      const { render } = await layoutAndRender(this.layoutEngine, this.canvasRenderer, design, layout, content, newAssets, ratios);

      const nextVersion = Math.max(meme.currentVersion || 1, ...(meme.versions || []).map(v => v.versionNumber || 0)) + 1;
      const outputs = this.writeOutputs(memeId, nextVersion, render, newAssets.subjectImages);
      meme.currentVersion = nextVersion;
      meme.assets = newAssets as any;
      meme.outputPaths = outputs.outputPaths;
      meme.outputUrls = outputs.outputUrls;
      const slotList = changes.map(c => c.slot).sort((a, b) => a - b);
      meme.versions.push({
        versionNumber: nextVersion,
        instruction: `Replaced image${slotList.length > 1 ? 's' : ''} ${slotList.join(', ')}`,
        createdAt: new Date(),
        design: plain(meme.design),
        layout: plain(meme.layout),
        content: plain(meme.content),
        ...outputs,
        appliedChanges,
        interpreter: 'image_replace',
        assets: JSON.parse(JSON.stringify(newAssets)),
        imageChanges
      } as any);
      const saved = await meme.save();
      for (const c of changes) selection.discard(c.st.token);
      return saved;
    } catch (e) {
      // nothing references the files written for a failed replacement
      for (const p of written) safeDeleteFile(p, UPLOADS_ROOT);
      throw e;
    } finally {
      this.replacing.delete(memeId);
    }
  }

  /**
   * Restores an earlier version of the meme (including the images it used, when recorded)
   */
  async restoreVersion(memeId: string, targetVersion: number): Promise<MemeDocument> {
    const meme = await this.getMemeById(memeId);
    const versionSnapshot = meme.versions.find(v => v.versionNumber === Number(targetVersion));

    if (!versionSnapshot) {
      throw new NotFoundException(`Version ${targetVersion} does not exist for meme ${memeId}`);
    }

    meme.currentVersion = versionSnapshot.versionNumber;
    meme.design = versionSnapshot.design;
    meme.layout = versionSnapshot.layout;
    meme.content = versionSnapshot.content;
    meme.outputPaths = versionSnapshot.outputPaths;
    meme.outputUrls = versionSnapshot.outputUrls;
    const snapshotAssets = plain(versionSnapshot.assets);
    if (snapshotAssets?.subjectImages) meme.assets = snapshotAssets as any;

    return meme.save();
  }

  /**
   * Deletes a meme document and cleans up associated output files safely
   */
  async deleteMeme(memeId: string): Promise<{ success: boolean; message: string }> {
    const meme = await this.getMemeById(memeId);

    // Generated outputs: only regular files inside the output directory are ever deleted
    const outputFiles = new Set<string>();
    for (const v of meme.versions) {
      if (v.outputPaths?.png) outputFiles.add(v.outputPaths.png);
      if (v.outputPaths?.jpeg) outputFiles.add(v.outputPaths.jpeg);
    }
    if (meme.outputPaths?.png) outputFiles.add(meme.outputPaths.png);
    if (meme.outputPaths?.jpeg) outputFiles.add(meme.outputPaths.jpeg);
    for (const f of outputFiles) {
      if (!safeDeleteFile(f, OUTPUT_ROOT)) {
        this.logger.warn(`Skipped deleting output file (missing or outside the output directory): ${path.basename(String(f))}`);
      }
    }

    // Uploaded / discovered images of every version (and the private reference): only files inside
    // the uploads directory, and only if no OTHER meme still references them.
    const allImages: any[] = [...(meme.assets.subjectImages || [])];
    if (meme.assets.reactionImage) allImages.push(meme.assets.reactionImage);
    for (const v of meme.versions || []) {
      const a = plain(v.assets);
      if (a?.subjectImages) allImages.push(...a.subjectImages);
      if (a?.reactionImage) allImages.push(a.reactionImage);
    }
    if (meme.referenceImage) allImages.push(meme.referenceImage);

    const seen = new Set<string>();
    for (const img of allImages) {
      const real = resolveApprovedFile(img?.path, [UPLOADS_ROOT]);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      const stillUsed = await this.memeModel.exists({
        memeId: { $ne: memeId },
        $or: [
          { 'assets.subjectImages.path': { $in: [img.path, real] } },
          { 'assets.reactionImage.path': { $in: [img.path, real] } },
          { 'referenceImage.path': { $in: [img.path, real] } }
        ]
      });
      if (stillUsed) {
        this.logger.log(`Kept ${path.basename(real)}: still referenced by another meme`);
        continue;
      }
      safeDeleteFile(real, UPLOADS_ROOT);
    }

    await this.memeModel.deleteOne({ memeId }).exec();
    if (this.memeImageModel) {
      try {
        await this.memeImageModel.deleteMany({ memeId }).exec();
      } catch (err: any) {
        this.logger.warn(`Could not delete meme images for ${memeId}: ${err?.message || err}`);
      }
    }
    return { success: true, message: `Meme ${memeId} and its associated version assets deleted safely.` };
  }
}
