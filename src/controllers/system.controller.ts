import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { getConfig } from '../config/app-config';
import { DesignProfileService } from '../design/design-profile.service';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { InternetSubjectDiscoveryService } from '../services/internet-subject-discovery.service';
import { CanvasRendererService } from '../services/canvas-renderer.service';
import { WhatsAppCredentialsService } from '../services/whatsapp-credentials.service';

/** Personal design profile (house style). A settings record, not a meme editor. */
@Controller('api/design-profile')
export class DesignProfileController {
  constructor(private readonly profiles: DesignProfileService) {}

  @Get()
  get() {
    return this.profiles.getActive();
  }

  @Put()
  update(@Body() body: unknown) {
    return this.profiles.update(body);
  }

  @Post('reset')
  reset() {
    return this.profiles.reset();
  }
}

/** Read-only health of the AI pipeline (no secrets are returned). */
@Controller('api/system')
export class SystemController {
  constructor(
    private readonly runner: VisionCliRunner,
    private readonly discovery: InternetSubjectDiscoveryService,
    private readonly whatsapp: WhatsAppCredentialsService
  ) {}

  @Get('status')
  async status() {
    const cfg = getConfig();
    return {
      visionCli: this.runner.describe(),
      verification: cfg.vision.verifyCandidates,
      identityAiMinConfidence: cfg.identity.aiMinConfidence,
      rightsPolicy: cfg.discovery.rightsPolicy,
      providers: this.discovery.describeProviders(),
      paidProviderUsage: await this.discovery.describeUsage(),
      fonts: { english: CanvasRendererService.ENGLISH_FONTS, telugu: CanvasRendererService.TELUGU_FONTS },
      adaptationMaxConcurrent: cfg.adaptationMaxConcurrent,
      // Token health without calling Meta: lets the app warn before WhatsApp silently stops answering
      whatsapp: await this.whatsapp.indicator().catch(() => null)
    };
  }
}
