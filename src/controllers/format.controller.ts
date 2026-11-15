import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { FormatLibraryService, FormatSummary } from '../services/format-library.service';
import { ViralAdaptationService } from '../services/viral-adaptation.service';
import { MulterUploadedFile, discardUploads, flattenUploads, uploadOptions, verifyAndNormalizeUploads } from './meme.controller';

const ID_RE = /^[0-9a-f-]{36}$/i;

/** The community's saved meme layouts (layout only; fonts and colours come from Settings). */
@Controller('api/formats')
export class FormatController {
  constructor(
    private readonly formats: FormatLibraryService,
    private readonly viralAdaptation: ViralAdaptationService
  ) {}

  @Get()
  async list(): Promise<{ formats: FormatSummary[] }> {
    return { formats: await this.formats.list() };
  }

  /**
   * Teaches the library a layout from an example meme: the structure is analysed (about 30-60 s),
   * saved, and the example is kept only as a small preview. One image per request; a structure that is
   * already saved is not duplicated (created: false).
   */
  @Post()
  @UseInterceptors(FileFieldsInterceptor([{ name: 'image', maxCount: 1 }], uploadOptions))
  async add(
    @UploadedFiles() files: { image?: MulterUploadedFile[] },
    @Body('name') name?: unknown
  ): Promise<{ created: boolean; layout: FormatSummary }> {
    const uploaded = flattenUploads(files);
    try {
      if (!files?.image?.length) throw new BadRequestException('Send an example meme image (field "image").');
      await verifyAndNormalizeUploads(uploaded);
      const f = files.image[0];
      const analysis = await this.viralAdaptation.analyzeForFormat({ path: f.path, filename: f.filename, originalName: f.originalname, mimeType: f.mimetype });
      const { format, created } = await this.formats.saveFromAnalysis(analysis, { name, source: 'api', referencePath: f.path });
      return { created, layout: this.formats.summaryOf(format) };
    } finally {
      // the preview was copied; the uploaded example itself is not kept
      discardUploads(uploaded);
    }
  }

  @Patch(':id')
  async rename(@Param('id') id: string, @Body() body: { name?: unknown }): Promise<FormatSummary> {
    if (!ID_RE.test(id)) throw new BadRequestException('Invalid layout id.');
    return this.formats.rename(id, body?.name);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: boolean }> {
    if (!ID_RE.test(id)) throw new BadRequestException('Invalid layout id.');
    return this.formats.remove(id);
  }
}
