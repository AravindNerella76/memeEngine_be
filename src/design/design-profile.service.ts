import { BadRequestException, Injectable, Logger, LogLevel, OnModuleInit } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Model } from 'mongoose';
import { getConfig, getEnvConfig, setRuntimeOverrides } from '../config/app-config';
import { DesignSpecifications } from '../types/meme.types';
import { applyLegacyProfile, DEFAULT_PROFILE_ID, DesignProfile, mergeProfileUpdate, profileFromSettings, settingsFromLegacyProfile } from './design-profile';
import { designFromSettings } from './render-style';
import {
  AppSettings,
  defaultSettings,
  mergeSettingsPatch,
  normalizeStoredSettings,
  resetSection,
  runtimeOverridesFromSettings,
  SETTINGS_SECTIONS,
  SettingsSection,
  settingsDelta
} from './settings';

/**
 * One record per page (profileId "kanyaraasi-default") in the existing design_profiles collection:
 *  - settings: version 2 settings, stored as the values that differ from the defaults
 *  - profile:  the version 1 flat profile, derived from the settings on every save (older code
 *              and GET /api/design-profile keep working; a record holding only a profile is migrated)
 */
@Schema({ collection: 'design_profiles', timestamps: true })
export class DesignProfileRecord {
  @Prop({ required: true, unique: true, index: true })
  profileId: string;

  @Prop({ type: Object })
  profile?: DesignProfile;

  @Prop({ type: Object })
  settings?: Record<string, unknown>;
}
export type DesignProfileDocument = DesignProfileRecord & Document;
export const DesignProfileSchema = SchemaFactory.createForClass(DesignProfileRecord);

const LOG_LEVELS: Record<string, LogLevel[]> = {
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  log: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  verbose: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose']
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

@Injectable()
export class DesignProfileService implements OnModuleInit {
  private readonly logger = new Logger(DesignProfileService.name);
  private cache: AppSettings | null = null;

  constructor(@InjectModel(DesignProfileRecord.name) private readonly model: Model<DesignProfileDocument>) {}

  /** Saved pipeline settings (discovery, timeouts, limits, log level) take effect at startup. */
  async onModuleInit() {
    this.applyPipelineSettings(await this.getSettings());
  }

  /** Built-in defaults, with the pipeline sections taken from the .env configuration. */
  defaults(): AppSettings {
    return defaultSettings(getEnvConfig());
  }

  /** The saved settings (or the defaults). Never throws: a database problem falls back to the defaults. */
  async getSettings(): Promise<AppSettings> {
    if (this.cache) return clone(this.cache);
    const defaults = this.defaults();
    try {
      const doc = await this.model.findOne({ profileId: DEFAULT_PROFILE_ID }).lean().exec();
      let s = defaults;
      if (doc?.settings) s = normalizeStoredSettings(doc.settings, defaults);
      else if (doc?.profile) s = settingsFromLegacyProfile(doc.profile, defaults);
      this.cache = s;
      return clone(s);
    } catch (e: any) {
      this.logger.warn(`Could not read the saved settings, using the defaults: ${e.message}`);
      return clone(defaults);
    }
  }

  /** Validates and saves a partial update. Invalid values are refused with a list of errors (nothing is saved). */
  async updateSettings(patch: unknown): Promise<AppSettings> {
    const next = mergeSettingsPatch(await this.getSettings(), patch);
    await this.persist(next);
    return clone(next);
  }

  /** Resets one section (typography, effects, canvas, imageProcessing, discovery, advanced) or everything ("all"). */
  async resetSettings(section: unknown): Promise<AppSettings> {
    if (section === 'all') {
      await this.model.deleteOne({ profileId: DEFAULT_PROFILE_ID }).exec();
      this.cache = null;
      const s = await this.getSettings();
      this.applyPipelineSettings(s);
      return s;
    }
    if (typeof section !== 'string' || !(SETTINGS_SECTIONS as readonly string[]).includes(section)) {
      throw new BadRequestException(`section must be one of ${SETTINGS_SECTIONS.join(', ')} or all`);
    }
    const next = resetSection(await this.getSettings(), section as SettingsSection, this.defaults());
    await this.persist(next);
    return clone(next);
  }

  private async persist(next: AppSettings) {
    const stored = { version: 2, ...settingsDelta(next, this.defaults()), updatedAt: next.updatedAt };
    await this.model
      .updateOne({ profileId: DEFAULT_PROFILE_ID }, { $set: { settings: stored, profile: profileFromSettings(next) } }, { upsert: true })
      .exec();
    this.cache = clone(next);
    this.applyPipelineSettings(next);
  }

  private applyPipelineSettings(s: AppSettings) {
    setRuntimeOverrides(runtimeOverridesFromSettings(s));
    Logger.overrideLogger(LOG_LEVELS[getConfig().logLevel] || LOG_LEVELS.log);
  }

  /** Design for a NEW meme: the current settings, with the style snapshot the renderer will use for it. */
  async newMemeDesign(englishFontOverride?: string): Promise<DesignSpecifications> {
    return designFromSettings(await this.getSettings(), englishFontOverride);
  }

  // ---- version 1 profile API (GET/PUT /api/design-profile, POST /api/design-profile/reset) ----

  /** The active profile in its version 1 form (derived from the settings). */
  async getActive(): Promise<DesignProfile> {
    return profileFromSettings(await this.getSettings());
  }

  async update(body: unknown): Promise<DesignProfile> {
    const current = await this.getSettings();
    const prev = profileFromSettings(current);
    const nextProfile = mergeProfileUpdate(prev, body);
    // the version 2 rules (cross-checks) also apply to a version 1 update
    const next = mergeSettingsPatch(applyLegacyProfile(current, nextProfile, prev), {});
    await this.persist(next);
    return profileFromSettings(next);
  }

  async reset(): Promise<DesignProfile> {
    await this.resetSettings('all');
    return this.getActive();
  }
}
