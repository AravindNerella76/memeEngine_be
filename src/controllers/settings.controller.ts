import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { getConfig } from '../config/app-config';
import { DesignProfileService } from '../design/design-profile.service';
import { ENGLISH_FONTS, TELUGU_FONTS } from '../design/fonts';
import { AppSettings, CANVAS_SIZES, SETTINGS_SCHEMA, SETTINGS_SECTIONS, TEXT_ROLE_INFO } from '../design/settings';
import { InternetSubjectDiscoveryService } from '../services/internet-subject-discovery.service';
import { PREVIEW_SAMPLES, SettingsPreviewService } from '../services/settings-preview.service';

/**
 * Settings (one record, shared with GET/PUT /api/design-profile). Visual settings are snapshotted
 * into each new meme; pipeline settings apply on top of the .env configuration and can only make
 * checks stricter, switch providers off, or lower limits. API keys are never returned.
 */
@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly profiles: DesignProfileService,
    private readonly preview: SettingsPreviewService,
    private readonly discovery: InternetSubjectDiscoveryService
  ) {}

  @Get()
  async get() {
    const [settings, usage] = await Promise.all([this.profiles.getSettings(), this.discovery.describeUsage().catch(() => [])]);
    return {
      settings,
      defaults: this.profiles.defaults(),
      schema: SETTINGS_SCHEMA,
      sections: SETTINGS_SECTIONS,
      roles: TEXT_ROLE_INFO,
      fonts: { english: ENGLISH_FONTS, telugu: TELUGU_FONTS },
      canvasSizes: CANVAS_SIZES,
      previewSamples: Object.fromEntries(Object.entries(PREVIEW_SAMPLES).map(([k, v]) => [k, v.label])),
      effective: this.effective(),
      providers: this.discovery.describeProviders(),
      usage
    };
  }

  @Put()
  async update(@Body() body: unknown) {
    const settings = await this.profiles.updateSettings(body);
    return this.saved(settings);
  }

  /** Body: { "section": "typography" | "effects" | "canvas" | "imageProcessing" | "discovery" | "advanced" | "all" } */
  @Post('reset')
  @HttpCode(200)
  async reset(@Body() body: unknown) {
    const section = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).section : undefined;
    const settings = await this.profiles.resetSettings(section);
    return this.saved(settings);
  }

  /** Body: { settings?: <unsaved changes>, sample?: "comparison" | "news" | "review" | "long", text?: {...} } */
  @Post('preview')
  @HttpCode(200)
  previewRender(@Body() body: unknown) {
    return this.preview.render(body);
  }

  private saved(settings: AppSettings) {
    return { settings, effective: this.effective(), providers: this.discovery.describeProviders() };
  }

  /** What the pipeline actually uses after combining Settings with .env (no secrets). */
  private effective() {
    const cfg = getConfig();
    const d = cfg.discovery;
    return {
      providersEnabled: d.enabledProviders.filter(p => p !== 'duckduckgo' || d.allowUnofficialProviders),
      rightsPolicy: d.rightsPolicy,
      maxDownloadsPerSlot: d.maxDownloadsPerSlot,
      maxRounds: d.maxRounds,
      identityMinConfidence: cfg.identity.aiMinConfidence,
      visualMinConfidence: d.visualMinConfidence,
      visualVerification: cfg.vision.verifyCandidates,
      duplicateHamming: d.duplicateHamming,
      minImageSide: d.minImageSide,
      maxUpscale: d.maxUpscale,
      watermarkPolicy: d.watermarkPolicy,
      analysisTimeoutSec: Math.round(cfg.vision.timeoutMs / 1000),
      downloadTimeoutSec: Math.round(d.downloadTimeoutMs / 1000),
      retryCount: cfg.vision.maxAttempts,
      maxConcurrentGenerations: cfg.adaptationMaxConcurrent,
      maxUploadMB: Math.round(cfg.limits.maxUploadBytes / (1024 * 1024)),
      diagnostics: cfg.diagnostics,
      logLevel: cfg.logLevel,
      // read-only: set in .env only
      caps: {
        braveMonthlyRequests: d.braveMonthlyLimit,
        braveQueriesPerSlot: d.braveMaxQueriesPerSlot,
        googleVisionMonthlyUnits: d.googleVisionMonthlyLimit
      },
      keysConfigured: { brave: Boolean(d.braveApiKey), googleVision: Boolean(d.googleVisionApiKey) }
    };
  }
}
