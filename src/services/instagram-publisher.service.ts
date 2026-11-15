import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  InternalServerErrorException
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meme, MemeDocument } from '../schemas/meme.schema';
import { InstagramOAuthService } from './instagram-oauth.service';
import { getConfig } from '../config/app-config';
import * as fs from 'fs';
import { inspectImageFileHeader } from '../security/image-verify';

export interface PublishMemeResult {
  success: boolean;
  mediaId: string;
  permalink: string;
  publishedAt: Date;
  username: string;
  instagramUserId: string;
  versionNumber: number;
}

@Injectable()
export class InstagramPublisherService {
  private readonly logger = new Logger(InstagramPublisherService.name);
  private readonly inProgressPublish = new Set<string>();

  constructor(
    @InjectModel(Meme.name)
    private readonly memeModel: Model<MemeDocument>,
    private readonly oauthService: InstagramOAuthService
  ) {}

  /**
   * Publishes a generated meme version directly to Instagram feed.
   */
  async publishMeme(
    memeId: string,
    versionNumber: number | undefined,
    caption: string,
    force = false
  ): Promise<PublishMemeResult> {
    if (!memeId) {
      throw new BadRequestException('memeId is required.');
    }
    if (!caption || typeof caption !== 'string' || !caption.trim()) {
      throw new BadRequestException('Caption is required.');
    }
    if (caption.length > 2200) {
      throw new BadRequestException(`Caption length (${caption.length} characters) exceeds Instagram limit of 2200.`);
    }

    // 1. Prevent duplicate concurrent publishing requests
    const lockKey = `${memeId}_v${versionNumber || 'latest'}`;
    if (this.inProgressPublish.has(lockKey)) {
      throw new ConflictException('A publishing operation is already in progress for this meme version. Please wait.');
    }
    this.inProgressPublish.add(lockKey);

    try {
      // 2. Fetch connected Instagram account and decrypted token
      const accountData = await this.oauthService.getDecryptedTokenForPublishing();
      if (!accountData) {
        throw new BadRequestException(
          'No connected Instagram account found. Please connect your account in Settings first.'
        );
      }
      const { instagramUserId, accessToken, username } = accountData;

      // 3. Fetch meme from MongoDB
      const meme = await this.memeModel.findOne({ memeId }).exec();
      if (!meme) {
        throw new NotFoundException(`Meme ${memeId} not found.`);
      }

      // Determine target version
      const targetVersionNum = versionNumber || meme.currentVersion || 1;
      let targetVersion = (meme.versions || []).find(v => v.versionNumber === targetVersionNum);
      if (!targetVersion) {
        // Fallback to top-level meme if no version array matches
        targetVersion = {
          versionNumber: targetVersionNum,
          outputUrls: meme.outputUrls,
          outputPaths: meme.outputPaths,
          content: meme.content,
          design: meme.design,
          layout: meme.layout
        } as any;
      }

      // Refuse to post the same version twice unless explicitly forced.
      const prior: any = (meme.versions || []).find(v => v.versionNumber === targetVersionNum)?.instagramPublish
        || (!meme.versions?.length ? meme.instagramPublish : undefined);
      if (!force && prior?.status === 'published') {
        throw new ConflictException(
          `This meme version was already published to Instagram (${prior.permalink || 'no permalink'}). Pass force: true to post it again.`
        );
      }

      // 4. Construct public HTTPS image URL for Meta
      const relativeImageUrl = targetVersion.outputUrls?.jpeg || targetVersion.outputUrls?.png || meme.outputUrls?.jpeg || meme.outputUrls?.png;
      if (!relativeImageUrl) {
        throw new BadRequestException(`No output image file found for meme ${memeId} (version ${targetVersionNum}).`);
      }

      // Instagram feed rules, checked up front so the failure is a clear message instead of an opaque Meta error
      this.assertInstagramFeedImage((targetVersion as any).outputPaths?.jpeg || (meme as any).outputPaths?.jpeg);

      const publicBase = getConfig().instagram.publicBaseUrl;
      const publicImageUrl = `${publicBase}${relativeImageUrl}`;

      this.logger.log(`Publishing meme ${memeId} (v${targetVersionNum}) to Instagram @${username} (${instagramUserId})...`);
      this.logger.log(`Public image URL for Meta: ${publicImageUrl}`);

      // 5. Step 1: Create Instagram Media Container
      const containerId = await this.createMediaContainer(
        instagramUserId,
        accessToken,
        publicImageUrl,
        caption.trim()
      );

      // 6. Step 2: Poll container status until FINISHED
      await this.waitForContainerProcessing(containerId, accessToken);

      // 7. Step 3: Publish Media Container
      const publishedMediaId = await this.publishMediaContainer(
        instagramUserId,
        accessToken,
        containerId
      );

      // 8. Step 4: Fetch permalink
      const permalink = await this.fetchMediaPermalink(publishedMediaId, accessToken, username);

      const publishedAt = new Date();

      // 9. Update MongoDB record
      const publishRecord = {
        status: 'published' as const,
        instagramMediaId: publishedMediaId,
        permalink,
        publishedAt,
        versionNumber: targetVersionNum,
        caption: caption.trim()
      };

      await this.memeModel.updateOne(
        { memeId },
        {
          $set: {
            instagramPublish: publishRecord,
            'versions.$[elem].instagramPublish': publishRecord
          }
        },
        {
          arrayFilters: [{ 'elem.versionNumber': targetVersionNum }]
        }
      );

      this.logger.log(`Successfully published meme ${memeId} to Instagram! Media ID: ${publishedMediaId}, Permalink: ${permalink}`);

      return {
        success: true,
        mediaId: publishedMediaId,
        permalink,
        publishedAt,
        username,
        instagramUserId,
        versionNumber: targetVersionNum
      };
    } finally {
      this.inProgressPublish.delete(lockKey);
    }
  }

  /**
   * Instagram feed images: JPEG, at most 8 MB, width 320-1440 px (larger is resized), aspect ratio between
   * 4:5 and 1.91:1. A file that is not on disk (or cannot be inspected) is left for Meta to judge.
   */
  private assertInstagramFeedImage(jpegPath: string | undefined): void {
    if (!jpegPath || !fs.existsSync(jpegPath)) return;
    let header: ReturnType<typeof inspectImageFileHeader>;
    try {
      header = inspectImageFileHeader(jpegPath);
    } catch {
      return;
    }
    const mb = fs.statSync(jpegPath).size / 1048576;
    const ratio = header.width / header.height;
    if (header.type !== 'jpeg') {
      throw new BadRequestException('Instagram feed posts must be JPEG images.');
    }
    if (mb > 8) {
      throw new BadRequestException(`The image is ${mb.toFixed(1)} MB; Instagram allows at most 8 MB. Lower the JPEG quality or output scale in Settings.`);
    }
    if (header.width < 320) {
      throw new BadRequestException(`The image is only ${header.width}px wide; Instagram needs at least 320px.`);
    }
    if (ratio < 0.8 - 0.001 || ratio > 1.91 + 0.001) {
      throw new BadRequestException(
        `This meme is ${header.width}x${header.height} (${ratio.toFixed(2)}:1). Instagram feed posts must be between 4:5 and 1.91:1, so a 9:16 story-size meme cannot be posted. Regenerate it with the 4:5 or square canvas.`
      );
    }
  }

  /**
   * Meta API Step 1: POST /{ig-user-id}/media
   */
  private async createMediaContainer(
    igUserId: string,
    accessToken: string,
    imageUrl: string,
    caption: string
  ): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${igUserId}/media`;
    const params = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: accessToken
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error || !data.id) {
      const errMsg = data.error?.message || `Failed to create Instagram media container (HTTP ${res.status})`;
      this.logger.error(`Container creation error: ${errMsg}`, JSON.stringify(data.error));
      throw new BadRequestException(`Meta Graph API error: ${errMsg}`);
    }

    return String(data.id);
  }

  /**
   * Meta API Step 2: GET /{container-id}?fields=status_code,status
   */
  private async waitForContainerProcessing(
    containerId: string,
    accessToken: string,
    maxWaitMs: number = 30000
  ): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    while (Date.now() - startTime < maxWaitMs) {
      const url = `https://graph.facebook.com/v21.0/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status_code) {
        const code = String(data.status_code).toUpperCase();
        this.logger.log(`Container ${containerId} processing status: ${code}`);

        if (code === 'FINISHED') {
          return;
        }

        if (code === 'ERROR' || code === 'EXPIRED') {
          const detail = data.status || 'Image processing error at Instagram';
          throw new BadRequestException(`Instagram media container failed with status ${code}: ${detail}`);
        }
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    // If maxWait exceeded but container didn't error, proceed to attempt publish
    this.logger.warn(`Container ${containerId} polling timed out after ${maxWaitMs}ms. Attempting publish anyway.`);
  }

  /**
   * Meta API Step 3: POST /{ig-user-id}/media_publish
   */
  private async publishMediaContainer(
    igUserId: string,
    accessToken: string,
    creationId: string
  ): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${igUserId}/media_publish`;
    const params = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error || !data.id) {
      const errMsg = data.error?.message || `Failed to publish Instagram media container (HTTP ${res.status})`;
      this.logger.error(`Publish error: ${errMsg}`, JSON.stringify(data.error));
      throw new BadRequestException(`Meta Graph API publish error: ${errMsg}`);
    }

    return String(data.id);
  }

  /**
   * Meta API Step 4: GET /{media-id}?fields=permalink
   */
  private async fetchMediaPermalink(
    mediaId: string,
    accessToken: string,
    fallbackUsername: string
  ): Promise<string> {
    try {
      const url = `https://graph.facebook.com/v21.0/${mediaId}?fields=id,permalink&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.permalink) {
        return data.permalink;
      }
    } catch (err: any) {
      this.logger.warn(`Could not fetch permalink for media ${mediaId}: ${err.message}`);
    }

    return `https://www.instagram.com/${fallbackUsername}/`;
  }

  /**
   * Retrieves publishing status for a specific meme.
   */
  async getPublishStatus(memeId: string): Promise<Record<string, any>> {
    const meme = await this.memeModel.findOne({ memeId }).select('instagramPublish memeId').exec();
    if (!meme) {
      throw new NotFoundException(`Meme ${memeId} not found.`);
    }

    return {
      memeId,
      published: Boolean(meme.instagramPublish?.status === 'published'),
      publishRecord: meme.instagramPublish || null
    };
  }
}

