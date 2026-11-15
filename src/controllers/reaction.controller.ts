import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import { loadImage } from '@napi-rs/canvas';
import { ReactionLibraryService, ReactionSummary } from '../services/reaction-library.service';
import { MulterUploadedFile, discardUploads, flattenUploads, uploadOptions, verifyAndNormalizeUploads } from './meme.controller';
import { DesignProfileService } from '../design/design-profile.service';
import { resolveRenderStyle } from '../design/render-style';
import { analyzeReactionImage, reactionPanelHeight } from '../services/reaction-framing';
import { Errors, REACTION_PAGE_DEFAULT, isReactionId, normalizeCategory, normalizeTags, validateReactionBulk, validateReactionPatch, validateReactionQuery } from '../security/request-validation';
import { sanitizeDisplayName } from '../security/path-guard';

const notFound = () => new NotFoundException('That picture is no longer in the library.');

export interface ReactionUploadResult {
  added: number;
  duplicates: Array<{ name: string; category: string }>;
  failed: Array<{ name: string; reason: string }>;
  items: ReactionSummary[];
}

/**
 * The owner's reaction library: pictures grouped by situation / emotion / subject, ready to drop into the reaction
 * panel of a new meme. Every route needs a signed-in session like the rest of the API.
 */
@Controller('api/reactions')
export class ReactionController {
  constructor(
    private readonly library: ReactionLibraryService,
    private readonly profiles: DesignProfileService
  ) {}

  /** One page of pictures. ?category=&search=&sort=newest|recent|used&limit=&skip= */
  @Get()
  async list(@Query() query: unknown) {
    const q = validateReactionQuery(query);
    const { items, total } = await this.library.list(q);
    return { items, total, skip: q.skip, limit: q.limit || REACTION_PAGE_DEFAULT, hasMore: q.skip + items.length < total };
  }

  /** The folders and how many pictures each holds. */
  @Get('categories')
  categories() {
    return this.library.categories();
  }

  /**
   * Adds pictures to a folder (field "images", up to 12 per request, body "category"; optional "tags").
   * Every file is checked by its content. One bad file never stops the rest: it is listed under "failed".
   * A picture that is already in the library (same content) is listed under "duplicates", not stored twice.
   */
  @Post()
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 12 }], uploadOptions))
  async add(@UploadedFiles() files: { images?: MulterUploadedFile[] }, @Body() body: { category?: unknown; tags?: unknown }): Promise<ReactionUploadResult> {
    const uploaded = flattenUploads(files);
    try {
      const category = normalizeCategory(body?.category);
      if (!category) throw new BadRequestException('Choose a folder for these pictures (1-40 letters, digits, spaces, - or _).');
      if (!files?.images?.length) throw new BadRequestException('Choose one or more image files (field "images").');
      const e = new Errors();
      const tags = normalizeTags(body?.tags, e);
      e.throwIfAny();

      const out: ReactionUploadResult = { added: 0, duplicates: [], failed: [], items: [] };
      for (const f of files.images) {
        const name = sanitizeDisplayName(f.originalname);
        try {
          const buffer = await fs.promises.readFile(f.path);
          const r = await this.library.add({ buffer, originalName: f.originalname, category, tags });
          if (r.created) {
            out.added++;
            out.items.push(r.image);
          } else {
            out.duplicates.push({ name, category: r.image.category });
          }
        } catch (err: any) {
          out.failed.push({ name, reason: err instanceof BadRequestException ? String((err.getResponse() as any)?.message || err.message) : 'Could not be stored.' });
        }
      }
      return out;
    } finally {
      discardUploads(uploaded);
    }
  }

  /**
   * How a reaction picture will sit in the reaction panel (field "image", one file; the studio sends a small copy):
   * is it a stack of frames, where are they and their faces, and the panel's shape from the current Settings. The studio
   * draws its live framing preview from this. Nothing is stored.
   */
  @Post('analyze')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'image', maxCount: 1 }], uploadOptions))
  async analyze(@UploadedFiles() files: { image?: MulterUploadedFile[] }) {
    const uploaded = flattenUploads(files);
    try {
      if (!files?.image?.length) throw new BadRequestException('Choose an image file (field "image").');
      await verifyAndNormalizeUploads(uploaded);
      const img = await loadImage(await fs.promises.readFile(files.image[0].path));
      const a = analyzeReactionImage(img);
      const design = await this.profiles.newMemeDesign();
      const style = resolveRenderStyle(design);
      return {
        width: a.width,
        height: a.height,
        stacked: a.stacked,
        // as shares of the picture's height, so they hold for the full-size picture as well as the small copy sent here
        frames: a.frames.map(f => ({ top: f.y / a.height, bottom: (f.y + f.height) / a.height })),
        autoFocus: a.autoFocus,
        panel: { width: design.width, height: reactionPanelHeight(design.width, design.height, a.width / a.height) },
        anchorY: style.image.reactionAnchorY,
        fit: style.image.reactionFit
      };
    } finally {
      discardUploads(uploaded);
    }
  }

  /** Several pictures at once: { action: "move", ids, category } or { action: "delete", ids }. */
  @Post('bulk')
  @HttpCode(200)
  bulk(@Body() body: unknown) {
    const v = validateReactionBulk(body);
    return this.library.bulk(v.action, v.ids, v.category);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    if (!isReactionId(id)) throw notFound();
    return this.library.update(id, validateReactionPatch(body));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    if (!isReactionId(id)) throw notFound();
    return this.library.remove(id);
  }

  /** Counts a use (what the quick-pick row sorts by). */
  @Post(':id/used')
  @HttpCode(204)
  async used(@Param('id') id: string): Promise<void> {
    if (!isReactionId(id)) throw notFound();
    await this.library.markUsed(id);
  }

  @Get(':id/thumb')
  async thumb(@Param('id') id: string, @Res() res: Response) {
    return this.send(id, 'thumb', res);
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    return this.send(id, 'file', res);
  }

  /** A picture's bytes never change (a changed picture is a new one), so the browser may keep them a day. */
  private async send(id: string, which: 'file' | 'thumb', res: Response) {
    if (!isReactionId(id)) throw notFound();
    const { data, mime } = await this.library.bytes(id, which);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }
}
