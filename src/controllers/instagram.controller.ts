import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Param,
  Res,
  HttpStatus,
  Logger
} from '@nestjs/common';
import type { Response } from 'express';
import { InstagramOAuthService, SanitizedInstagramAccount } from '../services/instagram-oauth.service';
import { InstagramPublisherService, PublishMemeResult } from '../services/instagram-publisher.service';
import { Public } from '../auth/public.decorator';
import { getConfig } from '../config/app-config';

@Controller('api/instagram')
export class InstagramController {
  private readonly logger = new Logger(InstagramController.name);

  constructor(
    private readonly instagramOAuthService: InstagramOAuthService,
    private readonly instagramPublisherService: InstagramPublisherService
  ) {}

  /**
   * Generates the Meta Unified Login authorization URL.
   */
  @Get('auth/url')
  getAuthUrl(): { url: string } {
    const { url } = this.instagramOAuthService.generateAuthUrl();
    return { url };
  }

  /**
   * Handles OAuth redirect callback from Meta.
   * Public: Meta redirects the owner's browser here. Only an owner who is signed in can start the flow
   * (auth/url is protected), and the `state` issued then is verified before anything is stored.
   */
  @Public()
  @Get('auth/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_reason') errorReason: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response
  ): Promise<void> {
    // Where the owner's browser returns to (APP_PUBLIC_URL; the local dev frontend by default)
    const feBaseUrl = getConfig().auth.appPublicUrl;

    // 1. Check if user cancelled or Meta returned an error
    if (error || errorReason) {
      const errMsg = errorDescription || errorReason || error || 'Authorization was cancelled or denied by user.';
      this.logger.warn(`Meta OAuth error: ${errMsg}`);
      return res.redirect(
        HttpStatus.FOUND,
        `${feBaseUrl}/settings?section=instagram&status=error&message=${encodeURIComponent(errMsg)}`
      );
    }

    if (!code || !state) {
      return res.redirect(
        HttpStatus.FOUND,
        `${feBaseUrl}/settings?section=instagram&status=error&message=${encodeURIComponent('Missing authorization code or state parameter.')}`
      );
    }

    try {
      const result = await this.instagramOAuthService.handleCallback(code, state);
      return res.redirect(
        HttpStatus.FOUND,
        `${feBaseUrl}/settings?section=instagram&status=connected&username=${encodeURIComponent(result.username)}`
      );
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to authenticate with Instagram.';
      this.logger.error(`Failed to handle Instagram callback: ${errMsg}`);
      return res.redirect(
        HttpStatus.FOUND,
        `${feBaseUrl}/settings?section=instagram&status=error&message=${encodeURIComponent(errMsg)}`
      );
    }
  }

  /**
   * Returns sanitized connection status and profile details.
   */
  @Get('account')
  async getAccount(): Promise<SanitizedInstagramAccount> {
    return this.instagramOAuthService.getSanitizedAccount();
  }

  /**
   * Disconnects the active Instagram account.
   */
  @Delete('account')
  async disconnect(): Promise<{ disconnected: boolean }> {
    return this.instagramOAuthService.disconnect();
  }

  /**
   * Publishes a meme version directly to Instagram feed.
   */
  @Post('publish')
  async publish(
    @Body() body: { memeId: string; versionNumber?: number; caption: string; force?: boolean }
  ): Promise<PublishMemeResult> {
    return this.instagramPublisherService.publishMeme(
      body.memeId,
      body.versionNumber,
      body.caption,
      body.force === true
    );
  }

  /**
   * Retrieves publishing status for a specific meme.
   */
  @Get('status/:memeId')
  async getStatus(@Param('memeId') memeId: string): Promise<Record<string, any>> {
    return this.instagramPublisherService.getPublishStatus(memeId);
  }
}

