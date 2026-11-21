import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Delete,
  BadRequestException,
  NotFoundException,
  UseInterceptors,
  UploadedFiles,
  Res,
  HttpCode,
  HttpException
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { MemeEngineService } from '../services/meme-engine.service';
import { ViralAdaptationService } from '../services/viral-adaptation.service';
import { ThumbnailService } from '../services/thumbnail.service';
import { UploadedAsset } from '../types/meme.types';
import { getConfig } from '../config/app-config';
import { Public } from '../auth/public.decorator';
import {
  OUTPUT_ROOT,
  UPLOADS_ROOT,
  resolveApprovedFile,
  safeDeleteFile,
  sanitizeDisplayName
} from '../security/path-guard';
import {
  ACCEPTED_EXTS_BY_TYPE,
  EXT_BY_TYPE,
  ImageValidationError,
  MAX_UPLOAD_BYTES,
  verifyImageFile
} from '../security/image-verify';
import {
  MemeIdPipe,
  parseVersionNumber,
  validateGenerateBody,
  validateInstruction,
  validateListQuery,
  validatePageQuery,
  validateThumbQuery,
  validateUploadPayload,
  validateViralFields,
  validateReactionFraming,
  validateViralOverrides
} from '../security/request-validation';
import type { ReactionFraming } from '../services/reaction-framing';
import { AdaptationJobService } from '../services/adaptation-job.service';
import type { ProgressSink } from '../jobs/adaptation-progress';
import { isHeic, normalizeImageBuffer } from '../security/image-normalize';

/** A viral adaptation request after validation (shared by the synchronous endpoint and the background job). */
interface ViralRequest {
  refFile: MulterUploadedFile | undefined;
  rxFile: MulterUploadedFile;
  punchline: string;
  reactionContext: string | undefined;
  preferredFont: string | undefined;
  selectedProviders?: string[];
  own: { draftId?: string; overrides?: { slot: number; token: string }[] };
  reactionFraming?: ReactionFraming;
}

export interface MulterUploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer?: Buffer;
}

if (!fs.existsSync(UPLOADS_ROOT)) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

// Uploads: first gate (cheap) on declared extension + MIME type. The real gate is the content
// check in verifyAndNormalizeUploads(); a declared type is never trusted on its own.
// .jfif / .jpe are real-world JPEG extensions (Windows saves .jfif); the content check decides what is truly an image
const ALLOWED_UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.jpe', '.png', '.webp', '.heic', '.heif']);
const ALLOWED_UPLOAD_MIMES = new Set(['image/jpeg', 'image/pjpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
// iPhone photos (HEIC/HEIF): many browsers on Windows and Android send them with no type or a generic one. The content
// check below decides; such a file is converted to JPEG/PNG on arrival, so nothing after it ever sees HEIC.
const HEIC_EXTS = new Set(['.heic', '.heif']);
const GENERIC_MIMES = new Set(['', 'application/octet-stream']);

const multerStorage = diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_ROOT);
  },
  filename: (req, file, cb) => {
    // The stored name is always server-generated. The client's file name is never used on disk.
    const ext = extname(file.originalname).toLowerCase();
    cb(null, `upload_${randomUUID()}${ALLOWED_UPLOAD_EXTS.has(ext) ? ext : '.bin'}`);
  }
});

const imageFileFilter = (
  req: unknown,
  file: { originalname: string; mimetype: string },
  cb: (error: Error | null, acceptFile?: boolean) => void
) => {
  const ext = extname(file.originalname).toLowerCase();
  const mimeOk = ALLOWED_UPLOAD_MIMES.has(file.mimetype) || (HEIC_EXTS.has(ext) && GENERIC_MIMES.has(file.mimetype || ''));
  if (!ALLOWED_UPLOAD_EXTS.has(ext) || !mimeOk) {
    return cb(new BadRequestException('Only JPEG, PNG, WebP and HEIC (iPhone) images are accepted'), false);
  }
  cb(null, true);
};

export const uploadOptions = {
  storage: multerStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,   // 20 MB per file
    files: 12,
    fields: 20,
    fieldSize: 128 * 1024,        // the JSON payload field
    parts: 40
  }
};

export const flattenUploads = (files: Record<string, MulterUploadedFile[] | undefined> | undefined): MulterUploadedFile[] =>
  Object.values(files || {}).flatMap(list => list || []);

/** Removes files multer just wrote for a request that is being rejected (they are referenced by nothing). */
export function discardUploads(files: MulterUploadedFile[]): void {
  for (const f of files) safeDeleteFile(f.path, UPLOADS_ROOT);
}

/**
 * Verifies the ACTUAL content of every uploaded file (JPEG/PNG/WebP, sane dimensions, decodes) and
 * normalises the stored extension to the detected type. HTML, SVG, GIF, scripts etc. are rejected
 * even when named .jpg with an image/jpeg MIME type.
 */
export async function verifyAndNormalizeUploads(files: MulterUploadedFile[]): Promise<void> {
  // Settings > Advanced > maximum image size (can only be lower than the 20 MB upload limit)
  const maxBytes = getConfig().limits.maxUploadBytes;
  for (const f of files) {
    if (typeof f.size === 'number' && f.size > maxBytes) {
      throw new BadRequestException(
        `"${sanitizeDisplayName(f.originalname)}" is ${(f.size / (1024 * 1024)).toFixed(1)} MB; the maximum image size is ${Math.round(maxBytes / (1024 * 1024))} MB (Settings > Advanced).`
      );
    }
  }
  for (const f of files) {
    try {
      await convertHeicUpload(f);
      const verified = await verifyImageFile(f.path);
      const currentExt = extname(f.path).toLowerCase();
      if (!ACCEPTED_EXTS_BY_TYPE[verified.type].includes(currentExt)) {
        const fixed = path.join(path.dirname(f.path), path.parse(f.path).name + EXT_BY_TYPE[verified.type]);
        fs.renameSync(f.path, fixed);
        f.path = fixed;
        f.filename = path.basename(fixed);
      }
      f.mimetype = verified.mime;
    } catch (err: any) {
      const name = sanitizeDisplayName(f.originalname);
      if (err instanceof ImageValidationError) {
        throw new BadRequestException(`"${name}" was rejected: ${err.message}`);
      }
      throw err;
    }
  }
}

/**
 * An iPhone photo (HEIC/HEIF, recognised by its content, not its name): decoded and stored as JPEG/PNG in place of the
 * original, so every later step works with an ordinary image. Anything else is left alone.
 */
async function convertHeicUpload(f: MulterUploadedFile): Promise<void> {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(f.path, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!isHeic(head)) return;
  const converted = await normalizeImageBuffer(await fs.promises.readFile(f.path));
  const target = path.join(path.dirname(f.path), path.parse(f.path).name + converted.ext);
  await fs.promises.writeFile(target, converted.buffer);
  if (target !== f.path) safeDeleteFile(f.path, UPLOADS_ROOT);
  f.path = target;
  f.filename = path.basename(target);
  f.mimetype = converted.mime;
  f.size = converted.buffer.length;
}

@Controller('api/memes')
export class MemeController {
  constructor(
    private readonly memeEngine: MemeEngineService,
    private readonly viralAdaptation: ViralAdaptationService,
    private readonly thumbnails: ThumbnailService,
    private readonly jobs: AdaptationJobService
  ) {}

  /**
   * List all memes with optional search, category filter and sorting
   */
  @Get()
  async getMemes(@Query() query: unknown) {
    // Every value must be a plain string from the allowed set: no arrays, no operator objects
    return this.memeEngine.getAllMemes(validateListQuery(query));
  }

  /**
   * One page of the gallery, lightweight (see MemeEngineService.listMemes). The total lets the app show
   * "24 of 180" and know when to stop loading more.
   */
  @Get('list')
  async listMemes(@Query() query: unknown) {
    const q = validatePageQuery(query);
    const { items, total } = await this.memeEngine.listMemes(q);
    return { items, total, skip: q.skip, limit: q.limit, hasMore: q.skip + items.length < total };
  }

  /**
   * Get single meme by ID
   */
  @Get(':id')
  async getMemeById(@Param('id', MemeIdPipe) id: string) {
    return this.memeEngine.getMemeById(id);
  }

  /**
   * Generation details (explainability report) of a meme
   */
  @Get(':id/report')
  async getMemeReport(@Param('id', MemeIdPipe) id: string) {
    return this.memeEngine.getReport(id);
  }

  /**
   * One of the meme's source images (subject-N, reaction or reference), for the local details view.
   * Streams verified images that belong to the meme.
   */
  @Public()
  @Get(':id/assets/:which')
  async getMemeAsset(@Param('id', MemeIdPipe) id: string, @Param('which') which: string, @Res() res: Response) {
    const file = await this.memeEngine.resolveAssetFile(id, which);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(file.path);
  }

  /**
   * A small JPEG of a meme version for the gallery (?v=<version>&w=240|360|480|720). Made on first use and kept
   * on disk. The URL names the version, and the file is rebuilt if its source changes, so it may be cached.
   */
  @Public()
  @Get(':id/thumb')
  async getMemeThumb(@Param('id', MemeIdPipe) id: string, @Query() query: unknown, @Res() res: Response) {
    const { version, width } = validateThumbQuery(query);
    const out = await this.memeEngine.resolveOutputFile(id, version);
    if (!out) throw new NotFoundException('Meme image not found');
    let file: string;
    try {
      file = await this.thumbnails.ensure(out.path, `${id}_v${out.version}`, width);
    } catch {
      throw new NotFoundException('Meme image not found');
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(file);
  }

  /**
   * Get version history of a meme
   */
  @Get(':id/versions')
  async getMemeVersions(@Param('id', MemeIdPipe) id: string) {
    const meme = await this.memeEngine.getMemeById(id);
    return meme.versions || [];
  }

  /**
   * Natural Language Instruction-Based Regeneration
   */
  @Post(':id/regenerate')
  async regenerateMeme(
    @Param('id', MemeIdPipe) id: string,
    @Body('instruction') instruction: unknown
  ) {
    return this.memeEngine.regenerateWithInstruction(id, validateInstruction(instruction));
  }

  /**
   * Restore an earlier version
   */
  @Post(':id/restore/:version')
  async restoreVersion(
    @Param('id', MemeIdPipe) id: string,
    @Param('version') version: string
  ) {
    return this.memeEngine.restoreVersion(id, parseVersionNumber(version));
  }

  /**
   * Replace Image, step 1: pictures already found for this image during the original discovery
   * (the AI's first pick and its verified alternates), staged for preview.
   */
  @Post(':id/slots/:slot/candidates')
  @HttpCode(200)
  async slotCandidates(@Param('id', MemeIdPipe) id: string, @Param('slot') slot: string) {
    return this.memeEngine.getSlotCandidates(id, Number(slot));
  }

  /** Replace Image, preview: the whole meme with the pending replacements, rendered in memory (nothing saved). */
  @Post(':id/image-replace/preview')
  @HttpCode(200)
  async previewImageReplace(@Param('id', MemeIdPipe) id: string, @Body() body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.memeEngine.previewImageReplacement(id, b.changes, b.baseVersion);
  }

  /** Replace Image, apply: only the chosen images change; creates a new version. Body: { changes: [{ slot, token }], baseVersion }. */
  @Post(':id/image-replace')
  @HttpCode(200)
  async applyImageReplace(@Param('id', MemeIdPipe) id: string, @Body() body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.memeEngine.applyImageReplacement(id, b.changes, b.baseVersion);
  }

  /**
   * Delete meme and clean up version outputs safely
   */
  @Delete(':id')
  async deleteMeme(@Param('id', MemeIdPipe) id: string) {
    const result = await this.memeEngine.deleteMeme(id);
    this.thumbnails.removeForMeme(id); // its small copies go with it
    return result;
  }

  /**
   * Download meme in PNG or JPEG (optionally specifying version)
   */
  @Get(':id/download/:format')
  async downloadMeme(
    @Param('id', MemeIdPipe) id: string,
    @Param('format') format: string,
    @Query('version') version: unknown,
    @Res() res: Response
  ) {
    if (!['png', 'jpeg', 'jpg'].includes(format)) {
      throw new BadRequestException('Format must be png, jpeg or jpg');
    }
    const meme = await this.memeEngine.getMemeById(id);

    let targetPaths = meme.outputPaths;
    let targetVersion = meme.currentVersion;

    if (version !== undefined) {
      const vNum = parseVersionNumber(version);
      const snapshot = meme.versions?.find(v => v.versionNumber === vNum);
      if (!snapshot || !snapshot.outputPaths) {
        throw new NotFoundException(`Version ${vNum} does not exist for this meme`);
      }
      targetPaths = snapshot.outputPaths;
      targetVersion = vNum;
    }

    // Only files inside the output directory are ever sent, whatever the stored path says
    const isJpeg = format === 'jpeg' || format === 'jpg';
    let filePath = resolveApprovedFile(isJpeg ? targetPaths?.jpeg : targetPaths?.png, [OUTPUT_ROOT]);
    if (!filePath) {
      const buf = await this.memeEngine.getImageBuffer(meme.memeId, targetVersion, isJpeg ? 'jpeg' : 'png');
      if (buf) {
        const ext = isJpeg ? 'jpeg' : 'png';
        const expectedPath = path.join(OUTPUT_ROOT, `meme_${meme.memeId}_v${targetVersion}.${ext}`);
        try {
          fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
          fs.writeFileSync(expectedPath, buf);
          filePath = expectedPath;
        } catch {}
      }
    }
    if (!filePath) {
      throw new NotFoundException(`Image file for version ${targetVersion} not found on disk`);
    }

    const filename = `kanyaraasi_${meme.memeId.substring(0, 8)}_v${targetVersion}.${isJpeg ? 'jpeg' : 'png'}`;
    res.download(filePath, filename);
  }

  /**
   * Direct JSON generation endpoint
   */
  @Post('generate')
  async generateMeme(@Body() body: unknown) {
    return this.memeEngine.generateMeme(validateGenerateBody(body));
  }

  @Post('preview')
  async previewMeme(@Body() body: unknown) {
    return this.memeEngine.generateMeme(validateGenerateBody(body));
  }

  /**
   * Multipart Form Upload & Generation Endpoint
   */
  @Post('upload-and-generate')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'subjectImages', maxCount: 10 },
        { name: 'reactionImage', maxCount: 1 }
      ],
      uploadOptions
    )
  )
  async uploadAndGenerate(
    @UploadedFiles()
    files: {
      subjectImages?: MulterUploadedFile[];
      reactionImage?: MulterUploadedFile[];
    },
    @Body('payload') rawPayload: unknown
  ) {
    const uploaded = flattenUploads(files);
    try {
      return await this.memeEngine.generateMeme(await this.assembleManual(files, rawPayload, uploaded));
    } catch (err) {
      discardUploads(uploaded);
      throw err;
    }
  }

  private previewsRunning = 0;

  /**
   * A real preview of a meme being built by hand (same body as upload-and-generate): rendered exactly as it will be,
   * in memory. Nothing is saved, and the uploaded copies are deleted whatever happens.
   */
  @Post('upload-and-preview')
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'subjectImages', maxCount: 10 },
        { name: 'reactionImage', maxCount: 1 }
      ],
      uploadOptions
    )
  )
  async uploadAndPreview(
    @UploadedFiles()
    files: {
      subjectImages?: MulterUploadedFile[];
      reactionImage?: MulterUploadedFile[];
    },
    @Body('payload') rawPayload: unknown
  ) {
    const uploaded = flattenUploads(files);
    try {
      // a few at a time: the page asks again as the person types, and renders are heavy
      if (this.previewsRunning >= 2) throw new HttpException({ statusCode: 429, message: 'A preview is already being drawn. Try again in a moment.' }, 429);
      this.previewsRunning++;
      try {
        return await this.memeEngine.previewManual(await this.assembleManual(files, rawPayload, uploaded));
      } finally {
        this.previewsRunning--;
      }
    } finally {
      discardUploads(uploaded);
    }
  }

  /** The uploaded pictures and the JSON payload of the manual form, checked and put together. */
  private async assembleManual(
    files: { subjectImages?: MulterUploadedFile[]; reactionImage?: MulterUploadedFile[] },
    rawPayload: unknown,
    uploaded: MulterUploadedFile[]
  ) {
    await verifyAndNormalizeUploads(uploaded);
    const { content, design, layout, subjectLabels } = validateUploadPayload(rawPayload);

    const subjectImages: UploadedAsset[] = [];
    (files?.subjectImages || []).forEach((f, idx) => {
      subjectImages.push({
        id: randomUUID(),
        originalName: sanitizeDisplayName(f.originalname),
        filename: f.filename,
        path: f.path,
        mimeType: f.mimetype,
        role: idx === 0 ? 'subject_primary' : (idx === 1 ? 'subject_secondary' : 'subject_item'),
        orderIndex: idx,
        label: subjectLabels[idx] || undefined
      });
    });

    let reactionImage: UploadedAsset | undefined;
    if (files?.reactionImage && files.reactionImage.length > 0) {
      const rx = files.reactionImage[0];
      reactionImage = {
        id: randomUUID(),
        originalName: sanitizeDisplayName(rx.originalname),
        filename: rx.filename,
        path: rx.path,
        mimeType: rx.mimetype,
        role: 'reaction_punchline',
        orderIndex: 99
      };
    }

    return { content, assets: { subjectImages, reactionImage }, design, layout };
  }

  /**
   * Viral Meme Adaptation:
   * Only three user inputs required:
   * 1. Viral Meme Reference Screenshot
   * 2. Meme Reacting Image
   * 3. Exact Reacting Image Punchline Text
   *
   * AI (sandboxed) analyses the reference and visually verifies candidate images; subject images
   * come ONLY from internet discovery; rendering is deterministic. The punchline is never modified.
   */
  /**
   * Optional first step of Viral Adaptation (to choose your own pictures): analyses the reference once and
   * returns its image slots. Pass the returned draftId (and slotOverrides) to adapt-viral afterwards.
   */
  @Post('viral-analyze')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'referenceImage', maxCount: 1 }], uploadOptions))
  async analyzeViralReference(@UploadedFiles() files: { referenceImage?: MulterUploadedFile[] }) {
    const uploaded = flattenUploads(files);
    try {
      if (!files?.referenceImage?.length) throw new BadRequestException('Input 1 missing: Viral Meme Reference screenshot is required.');
      await verifyAndNormalizeUploads(uploaded);
      const f = files.referenceImage[0];
      return await this.viralAdaptation.analyzeDraft({ path: f.path, filename: f.filename, originalName: f.originalname, mimeType: f.mimetype });
    } catch (err) {
      discardUploads(uploaded);
      throw err;
    }
  }

  @Post('adapt-viral')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'referenceImage', maxCount: 1 },
        { name: 'reactionImage', maxCount: 1 },
      ],
      uploadOptions
    )
  )
  async adaptViralMeme(
    @UploadedFiles()
    files: {
      referenceImage?: MulterUploadedFile[];
      reactionImage?: MulterUploadedFile[];
    },
    @Body() body?: Record<string, unknown>
  ) {
    const uploaded = flattenUploads(files);
    try {
      const request = await this.prepareViralRequest(files, body, uploaded);
      return await this.runViralAdaptation(request);
    } catch (err) {
      // Nothing references these files yet: do not leave rejected or failed uploads on disk
      discardUploads(uploaded);
      throw err;
    }
  }

  /**
   * The same adaptation, run in the background: answers at once with a job, and the app watches its real progress
   * (GET adapt-viral/jobs/:jobId). It can leave the page, refresh or close the tab and still collect the meme.
   * Validation is identical to adapt-viral, so a bad request is refused here, before any work starts.
   */
  @Post('adapt-viral/jobs')
  @HttpCode(202)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'referenceImage', maxCount: 1 },
        { name: 'reactionImage', maxCount: 1 }
      ],
      uploadOptions
    )
  )
  async startViralJob(
    @UploadedFiles()
    files: {
      referenceImage?: MulterUploadedFile[];
      reactionImage?: MulterUploadedFile[];
    },
    @Body() body?: Record<string, unknown>
  ) {
    const uploaded = flattenUploads(files);
    try {
      const request = await this.prepareViralRequest(files, body, uploaded);
      // checked in the same breath as the start (no await between), so two requests cannot both slip in
      if (this.viralAdaptation.isBusy()) {
        throw new HttpException({ statusCode: 429, message: 'Another meme is still being made. Wait for it to finish, then try again.' }, 429);
      }
      return this.jobs.start(
        sink => this.runViralAdaptation(request, sink),
        () => discardUploads(uploaded) // a failed run leaves nothing that references these files
      );
    } catch (err) {
      discardUploads(uploaded);
      throw err;
    }
  }

  /** The meme being made right now, if any: lets the app pick its progress up again after a refresh or a closed tab. */
  @Get('adapt-viral/jobs/active')
  activeViralJob() {
    return { job: this.jobs.active() ?? null };
  }

  @Get('adapt-viral/jobs/:jobId')
  viralJob(@Param('jobId') jobId: string) {
    const view = /^[0-9a-f-]{36}$/i.test(jobId) ? this.jobs.get(jobId) : undefined;
    if (!view) {
      throw new NotFoundException('That job is no longer known. If the server was restarted, a finished meme is still in My Memes.');
    }
    return view;
  }

  /** Validates the three inputs and the options, and checks what was uploaded really is an image. */
  private async prepareViralRequest(
    files: { referenceImage?: MulterUploadedFile[]; reactionImage?: MulterUploadedFile[] },
    body: Record<string, unknown> | undefined,
    uploaded: MulterUploadedFile[]
  ): Promise<ViralRequest> {
    const b = body || {};
    const own = validateViralOverrides({ draftId: b.draftId, slotOverrides: b.slotOverrides });
    const framing = validateReactionFraming(b.reactionFraming);
    if (!own.draftId && (!files?.referenceImage || files.referenceImage.length === 0)) {
      throw new BadRequestException('Input 1 missing: Viral Meme Reference screenshot is required.');
    }
    if (!files?.reactionImage || files.reactionImage.length === 0) {
      throw new BadRequestException('Input 2 missing: Meme Reacting Image is required.');
    }
    if (typeof b.punchline !== 'string' || !b.punchline.trim()) {
      throw new BadRequestException('Input 3 missing: Reacting Image Text (punchline) is required.');
    }
    const fields = validateViralFields({
      punchline: b.punchline,
      reactionContext: b.reactionContext,
      fontFamily: b.fontFamily,
      selectedProviders: b.selectedProviders
    });

    await verifyAndNormalizeUploads(uploaded);

    return {
      refFile: own.draftId ? undefined : files.referenceImage![0],
      rxFile: files.reactionImage[0],
      punchline: fields.punchline,
      reactionContext: fields.reactionContext,
      preferredFont: fields.fontFamily,
      selectedProviders: fields.selectedProviders,
      own,
      reactionFraming: framing
    };
  }

  private async runViralAdaptation(request: ViralRequest, onProgress?: ProgressSink) {
    const { refFile, rxFile, punchline, reactionContext, preferredFont, selectedProviders, own, reactionFraming } = request;
    // The orchestrator runs: analysis -> identity -> internet discovery + visual verification ->
    // layout -> render -> persistence (with the generation report). The punchline is passed verbatim.
    const { meme, adaptationMetadata } = await this.viralAdaptation.adapt({
      reference: refFile ? { path: refFile.path, filename: refFile.filename, originalName: refFile.originalname, mimeType: refFile.mimetype } : undefined,
      draftId: own.draftId,
      overrides: own.overrides,
      reaction: { path: rxFile.path, filename: rxFile.filename, originalName: rxFile.originalname, mimeType: rxFile.mimetype },
      punchline,
      reactionContext,
      fontFamily: preferredFont,
      selectedProviders,
      reactionFraming,
      onProgress
    });
    const { generationReport, ...rest } = meme;
    return { ...rest, adaptationMetadata };
  }

  /**
   * Generates reference standard meme for any of the 5 archetypes using extracted assets
   */
  @Get('reference/:format')
  async generateReferenceFormat(@Param('format') format: string) {
    const assetsDir = path.join(__dirname, '..', '..', 'test-assets');

    if (format === 'facts_collage') {
      return this.memeEngine.generateMeme({
        content: {
          topic: 'Lord Vishnu Special Number 7 Facts',
          headline: '7 ALWAYS BEEN A SPECIAL NUMBER FOR LORD VISHNU',
          punchline: 'నంబర్ 7 తో ఇంకో స్పెషల్ ఉంది అది ఏంటో కామెంట్ చేయండి!',
          itemLabels: [
            '7 GATES OF VAIKUNTAM',
            '7TH AVATAR OF LORD VISHNU',
            '7 DAYS LIFTING GOVARDAN',
            '7 HILLS OF VENKATESWARA SWAMY'
          ]
        },
        assets: {
          subjectImages: [
            { id: '1', originalName: 'facts_item1.jpg', filename: 'facts_item1.jpg', path: path.join(assetsDir, 'facts_item1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: '7 GATES OF VAIKUNTAM' },
            { id: '2', originalName: 'facts_item2.jpg', filename: 'facts_item2.jpg', path: path.join(assetsDir, 'facts_item2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: '7TH AVATAR OF LORD VISHNU' },
            { id: '3', originalName: 'facts_item3.jpg', filename: 'facts_item3.jpg', path: path.join(assetsDir, 'facts_item3.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 2, label: '7 DAYS LIFTING GOVARDAN' },
            { id: '4', originalName: 'facts_item4.jpg', filename: 'facts_item4.jpg', path: path.join(assetsDir, 'facts_item4.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 3, label: '7 HILLS OF VENKATESWARA SWAMY' },
          ],
          reactionImage: {
            id: 'rx', originalName: 'facts_reaction.jpg', filename: 'facts_reaction.jpg', path: path.join(assetsDir, 'facts_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 4
          }
        },
        layout: {
          memeType: 'facts_collage',
          arrangement: 'grid_2x2'
        },
        design: {
          fontFamily: 'Arial Black',
          teluguFontFamily: 'Ramabhadra',
          primaryTextColor: '#FFE500',
          secondaryTextColor: '#FFFFFF',
          outlineThickness: 7
        }
      });
    }

    if (format === 'comparison') {
      return this.memeEngine.generateMeme({
        content: {
          topic: 'Net Worth of Chief Ministers of India',
          headline: 'NET WORTH OF CHIEF MINISTERS OF INDIA',
          punchline: 'మీ అంత పూరెస్ట్ చీఫ్ మినిస్టర్ ని చూడలేదు మేడం!',
          itemLabels: [
            '931 CRORES\n1ST PLACE',
            '30 CRORES\n7TH PLACE',
            '15 LAKHS\nLAST PLACE'
          ]
        },
        assets: {
          subjectImages: [
            { id: 'c1', originalName: 'compare_col1.jpg', filename: 'compare_col1.jpg', path: path.join(assetsDir, 'compare_col1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: '931 CRORES\n1ST PLACE' },
            { id: 'c2', originalName: 'compare_col2.jpg', filename: 'compare_col2.jpg', path: path.join(assetsDir, 'compare_col2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: '30 CRORES\n7TH PLACE' },
            { id: 'c3', originalName: 'compare_col3.jpg', filename: 'compare_col3.jpg', path: path.join(assetsDir, 'compare_col3.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 2, label: '15 LAKHS\nLAST PLACE' }
          ],
          reactionImage: {
            id: 'crx', originalName: 'compare_reaction.jpg', filename: 'compare_reaction.jpg', path: path.join(assetsDir, 'compare_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 3
          }
        },
        layout: {
          memeType: 'comparison',
          arrangement: 'columns_3'
        },
        design: {
          fontFamily: 'Arial Black',
          teluguFontFamily: 'Ramabhadra',
          primaryTextColor: '#FFE500',
          secondaryTextColor: '#FFFFFF',
          outlineThickness: 7
        }
      });
    }

    if (format === 'trending_news') {
      return this.memeEngine.generateMeme({
        content: {
          topic: 'Producer Anil Sunkara Statement',
          statement: 'CHIRANJEEVI GAVE UP REMUNERATION FOR BHOLA SHANKAR AND AKHIL FOR AGENT, BOTH HELPED ME DURING HEAVY LOSSES AND SUPPORTED EVEN AFTER THE RELEASE.\n- PRODUCER ANIL SUNKARA',
          reactionContext: '* BOSS AND AKHIL',
          punchline: 'ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు'
        },
        assets: {
          subjectImages: [
            { id: 'n1', originalName: 'news_subject1.jpg', filename: 'news_subject1.jpg', path: path.join(assetsDir, 'news_subject1.jpg'), mimeType: 'image/jpeg', role: 'subject_primary', orderIndex: 0 },
            { id: 'n2', originalName: 'news_subject2.jpg', filename: 'news_subject2.jpg', path: path.join(assetsDir, 'news_subject2.jpg'), mimeType: 'image/jpeg', role: 'subject_secondary', orderIndex: 1 }
          ],
          reactionImage: {
            id: 'nrx', originalName: 'news_reaction.jpg', filename: 'news_reaction.jpg', path: path.join(assetsDir, 'news_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
          }
        },
        layout: {
          memeType: 'trending_news',
          arrangement: 'side_by_side'
        },
        design: {
          fontFamily: 'Arial Black',
          teluguFontFamily: 'Ramabhadra',
          primaryTextColor: '#FFE500',
          secondaryTextColor: '#FFFFFF',
          outlineThickness: 8
        }
      });
    }

    if (format === 'movie_update') {
      return this.memeEngine.generateMeme({
        content: {
          topic: 'OG Censor Report',
          headline: 'OG CENSOR REPORT',
          bulletPoints: [
            'DECENT 1ST HALF',
            'MASSIVE INTERVAL SEQUENCE',
            'TERRIFIC 2ND HALF',
            '3 MAJOR SEQUENCES'
          ],
          reactionContext: '* THEATRE LO AUDIENCE RESPONSE',
          punchline: 'చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!'
        },
        assets: {
          subjectImages: [
            { id: 'm1', originalName: 'movie_subject1.jpg', filename: 'movie_subject1.jpg', path: path.join(assetsDir, 'movie_subject1.jpg'), mimeType: 'image/jpeg', role: 'subject_primary', orderIndex: 0 },
            { id: 'm2', originalName: 'movie_subject2.jpg', filename: 'movie_subject2.jpg', path: path.join(assetsDir, 'movie_subject2.jpg'), mimeType: 'image/jpeg', role: 'subject_secondary', orderIndex: 1 }
          ],
          reactionImage: {
            id: 'mrx', originalName: 'movie_reaction.jpg', filename: 'movie_reaction.jpg', path: path.join(assetsDir, 'movie_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
          }
        },
        layout: {
          memeType: 'movie_update',
          arrangement: 'side_by_side'
        },
        design: {
          fontFamily: 'Arial Black',
          teluguFontFamily: 'Ramabhadra',
          primaryTextColor: '#FFE500',
          secondaryTextColor: '#FFFFFF',
          outlineThickness: 7
        }
      });
    }

    if (format === 'stacked_comparison' || format === 'custom') {
      return this.memeEngine.generateMeme({
        content: {
          topic: 'Thalapathy vs NTR Crowd Comparison',
          punchline: 'మీరు ఒప్పుకున్నా ఒప్పుకోకపోయినా 19 ఇయర్స్ కే ఈ రేంజ్ ఫ్యాన్స్ ఇండియా లో ఏ హీరో కి లేరు',
          itemLabels: [
            'THALAPATHY AT THE AGE 50\n(7 LAKH PEOPLE)',
            'NTR AT AGE OF 19\n(10 LAKH PEOPLE)'
          ]
        },
        assets: {
          subjectImages: [
            { id: 's1', originalName: 'stacked_row1.jpg', filename: 'stacked_row1.jpg', path: path.join(assetsDir, 'stacked_row1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: 'THALAPATHY AT THE AGE 50\n(7 LAKH PEOPLE)' },
            { id: 's2', originalName: 'stacked_row2.jpg', filename: 'stacked_row2.jpg', path: path.join(assetsDir, 'stacked_row2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: 'NTR AT AGE OF 19\n(10 LAKH PEOPLE)' }
          ],
          reactionImage: {
            id: 'srx', originalName: 'stacked_reaction.jpg', filename: 'stacked_reaction.jpg', path: path.join(assetsDir, 'stacked_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
          }
        },
        layout: {
          memeType: 'comparison',
          arrangement: 'stacked_rows'
        },
        design: {
          fontFamily: 'Arial Black',
          teluguFontFamily: 'Ramabhadra',
          primaryTextColor: '#FFE500',
          secondaryTextColor: '#FFFFFF',
          outlineThickness: 7
        }
      });
    }

    throw new BadRequestException(`Unknown format: ${format}`);
  }
}
