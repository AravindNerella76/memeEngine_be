import { BadRequestException, Body, Controller, Delete, HttpCode, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { discardUploads, flattenUploads, MulterUploadedFile, uploadOptions, verifyAndNormalizeUploads } from './meme.controller';
import { ImageSelectionService } from '../services/image-selection.service';

/**
 * Staged image choices (upload or online search) for Replace Image and for Viral Adaptation
 * overrides. Staging validates and previews a picture; nothing is saved until it is applied.
 */
@Controller('api/staged-images')
export class ImageSelectionController {
  constructor(private readonly selection: ImageSelectionService) {}

  /** The user's own picture for a slot. Checked by content (real JPEG/PNG/WebP, size, decodes) and returned as a preview. */
  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'image', maxCount: 1 }], uploadOptions))
  async upload(@UploadedFiles() files: { image?: MulterUploadedFile[] }) {
    const uploaded = flattenUploads(files);
    try {
      if (!files?.image?.length) throw new BadRequestException('Choose an image file to upload.');
      await verifyAndNormalizeUploads(uploaded);
      const st = await this.selection.stageUpload(files.image[0].path, files.image[0].originalname);
      return this.selection.toPublic(st);
    } finally {
      // the picture is kept in memory until it is applied; the temporary upload is never needed again
      discardUploads(uploaded);
    }
  }

  /** "Find another image online": body { query }. Returns downloaded, validated results with previews. */
  @Post('search')
  @HttpCode(200)
  async search(@Body() body: unknown) {
    const q = body && typeof body === 'object' ? (body as Record<string, unknown>).query : undefined;
    return this.selection.searchOnline(q);
  }

  /** Cancel: forget a staged choice. */
  @Delete(':token')
  @HttpCode(200)
  discard(@Param('token') token: string) {
    if (!/^[a-f0-9]{32}$/.test(token)) throw new BadRequestException('Invalid token.');
    this.selection.discard(token);
    return { success: true };
  }
}
