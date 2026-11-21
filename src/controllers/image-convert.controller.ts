import { BadRequestException, Controller, HttpCode, HttpException, Post, Res, UnsupportedMediaTypeException, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ImageValidationError } from '../security/image-verify';
import { isHeic, normalizeImageBuffer } from '../security/image-normalize';

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_AT_ONCE = 3;
let running = 0;

/**
 * POST /api/images/convert  (field "image", one file)
 *
 * Browsers other than Safari cannot show iPhone photos (HEIC/HEIF). The studio sends such a photo here the moment it is
 * picked and gets an ordinary JPEG back (PNG for small ones), which it then previews and uploads like any picture.
 * Only HEIC/HEIF content is accepted (checked by its bytes, not its name); nothing is stored.
 */
@Controller('api/images')
export class ImageConvertController {
  @Post('convert')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'image', maxCount: 1 }], { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 2 } }))
  async convert(@UploadedFiles() files: { image?: { buffer: Buffer; originalname: string }[] }, @Res() res: Response) {
    const file = files?.image?.[0];
    if (!file?.buffer?.length) throw new BadRequestException('Choose a picture (field "image").');
    if (!isHeic(file.buffer)) throw new UnsupportedMediaTypeException('Only HEIC/HEIF (iPhone) photos need converting; this one is not.');
    if (running >= MAX_AT_ONCE) throw new HttpException({ statusCode: 429, message: 'Converting other photos right now. Try again in a moment.' }, 429);
    running++;
    try {
      const out = await normalizeImageBuffer(file.buffer);
      res.setHeader('Content-Type', out.mime);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Image-Width', String(out.width));
      res.setHeader('X-Image-Height', String(out.height));
      res.setHeader('X-Converted-From', out.convertedFrom);
      res.end(out.buffer);
    } catch (err) {
      if (err instanceof ImageValidationError) throw new BadRequestException(err.message);
      throw err;
    } finally {
      running--;
    }
  }
}
