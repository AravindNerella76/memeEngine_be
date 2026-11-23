/**
 * Meme engine settings (version 2): the single source of truth for configurable behaviour.
 *
 * Stored in the existing design profile record (collection design_profiles, profileId
 * "kanyaraasi-default", field `settings`). The older flat profile (fonts, two colours, one
 * outline) is DERIVED from these settings for backward compatibility, and an older stored
 * profile is migrated into these settings on first read, so existing preferences are kept.
 *
 * Sections:
 *  typography, effects, canvas, imageProcessing -> visual style. Snapshotted into every new
 *      meme (design.style), so existing memes and their versions never change afterwards.
 *  discovery, advanced (+ the discovery part of imageProcessing) -> pipeline behaviour, applied
 *      at run time on top of the .env configuration (see app-config setRuntimeOverrides). They
 *      can never enable a provider without its key, raise a paid monthly cap, or weaken identity,
 *      visual-verification or image-quality thresholds below the .env/built-in values.
 *
 * Defaults equal the existing house style exactly (sizes, colours, outline 8, shadow 0.95 / blur
 * 8 / offset 3, no gaps, 1080 x 1350).
 */
import { BadRequestException } from '@nestjs/common';
import type { AppConfig, RuntimeOverrides } from '../config/app-config';
import { ENGLISH_FONTS, TELUGU_FONTS } from './fonts';

export type { RuntimeOverrides } from '../config/app-config';

export const TEXT_ROLES = ['heading', 'labels', 'supporting', 'punchline', 'caption'] as const;
export type TextRoleId = (typeof TEXT_ROLES)[number];

export const TEXT_ROLE_INFO: Record<TextRoleId, { label: string; appliesTo: string }> = {
  heading: { label: 'Main heading', appliesTo: 'the header banner text' },
  labels: { label: 'Subject labels', appliesTo: 'the caption on each subject image' },
  supporting: { label: 'Supporting text', appliesTo: 'statement / quote, its attribution, and review bullet points' },
  punchline: { label: 'Bottom punchline', appliesTo: 'your punchline on the reaction image' },
  caption: { label: 'Captions', appliesTo: 'the reaction context tag (e.g. "* THEATRE AUDIENCE")' }
};

export interface RoleTypography {
  englishFont: string;
  teluguFont: string;
  weight: 'normal' | 'bold';
  /** Base size in px for a 1080 px wide meme (automatic fitting may shrink it). */
  size: number;
  minSize: number;
  maxSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  /** Vertical position inside the text's area. */
  position: 'top' | 'middle' | 'bottom';
}

export interface RoleEffects {
  fill: { color: string; opacity: number };
  /**
   * The yellow emphasis (first line, numbers, alternating bullets ... depending on the role). `pattern` (heading and
   * supporting text): only the first line, or every other line (yellow, white, yellow).
   */
  highlight: { enabled: boolean; color: string; pattern: 'first' | 'alternate' };
  stroke: { enabled: boolean; width: number; color: string; opacity: number };
  shadow: { enabled: boolean; color: string; blur: number; offsetX: number; offsetY: number; opacity: number };
  /** A soft dark shade behind the text that fades out upwards (supporting text and punchline over pictures). */
  shade: { enabled: boolean; opacity: number };
}

export type CanvasAspect = 'portrait_4_5' | 'square_1_1' | 'story_9_16';

export interface CanvasSettings {
  aspect: CanvasAspect;
  /** Output width = 1080 x scale (the layout is always computed at 1080 px wide). */
  outputScale: number;
  background: string;
  headerBackground: string;
  /** Minimum distance of any text from the left/right canvas edges (0 = the layout's own insets). */
  safeMargin: number;
  /** Header height as a share of the canvas when the reference does not decide it (null = automatic). */
  headerRatio: number | null;
  /** The header never grows beyond this share (long headlines). */
  maxHeaderRatio: number;
  /** Punchline area as a share of the reaction image height. */
  punchlineRatio: number;
  /** A long punchline may grow its area up to this share of the reaction image. */
  punchlineMaxGrowRatio: number;
  /** Two-line punchline: the first (yellow, setup) line's size as a share of the second (white) line. */
  punchlineSetupScale: number;
  /** Space between subject images (px); the background colour shows through. */
  imageGap: number;
  /** Space between header, subject images and reaction image (px). */
  sectionGap: number;
  cornerRadius: number;
  /** Smallest image area the automatic layout may produce (px); smaller grids are equalised. */
  minSlotSize: number;
}

export interface ImageProcessingSettings {
  subjectFit: 'cover' | 'contain';
  reactionFit: 'cover' | 'contain';
  /** Vertical crop anchor (0 top - 1 bottom) for portrait subjects, landscape subjects and the reaction image. */
  portraitAnchorY: number;
  landscapeAnchorY: number;
  reactionAnchorY: number;
  /** Centre crops on the face found by visual verification. */
  useFocalPoint: boolean;
  /** Cut away black or white bars around a picture (movie letterboxing, screenshot borders) before it is placed. */
  trimBorders: boolean;
  jpegQuality: number;
  primaryFormat: 'png' | 'jpeg';
  /** Picture-hash distance treated as "the same picture" (higher = more aggressive duplicate detection). */
  duplicateSensitivity: number;
  /** Minimum width/height of an internet image (px); cannot go below 250. */
  minImageSide: number;
  /** Largest allowed enlargement of an internet image; cannot exceed 2.5. */
  maxUpscale: number;
  watermarkPolicy: 'prefer_clean' | 'reject';
}

export interface DiscoverySettings {
  /** Allowed providers. A provider still needs its key in .env; switching it on here cannot bypass that. */
  providers: { wikimediaCommons: boolean; wikipedia: boolean; openverse: boolean; googleVision: boolean; brave: boolean };
  rightsPolicy: 'allow_copyrighted' | 'open_license_only';
  /** Candidates downloaded and checked per slot. */
  maxCandidatesChecked: number;
  /** Search rounds per slot (precise -> identity -> broad). */
  maxRounds: number;
  /** Minimum AI confidence for an AI-only identification (never below the .env value / 0.8). */
  identityMinConfidence: number;
  /** Minimum confidence of the visual check (never below 0.6). */
  visualMinConfidence: number;
}

export type LogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface AdvancedSettings {
  analysisTimeoutSec: number;
  downloadTimeoutSec: number;
  retryCount: number;
  maxConcurrentGenerations: number;
  maxUploadMB: number;
  diagnostics: boolean;
  logLevel: LogLevel;
}

export interface AppSettings {
  version: 2;
  name: string;
  typography: { fontSizeScale: number; textScales: Record<string, number>; roles: Record<TextRoleId, RoleTypography> };
  effects: { roles: Record<TextRoleId, RoleEffects> };
  canvas: CanvasSettings;
  imageProcessing: ImageProcessingSettings;
  discovery: DiscoverySettings;
  advanced: AdvancedSettings;
  updatedAt?: string;
}

export const SETTINGS_SECTIONS = ['typography', 'effects', 'canvas', 'imageProcessing', 'discovery', 'advanced'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const CANVAS_SIZES: Record<CanvasAspect, { width: number; height: number }> = {
  portrait_4_5: { width: 1080, height: 1350 },
  square_1_1: { width: 1080, height: 1080 },
  story_9_16: { width: 1080, height: 1920 }
};

export const HARD_MAX_UPLOAD_MB = 20;

// ------------------------------------------------------------------------------------------------
// Defaults (= the existing house style and the .env configuration)
// ------------------------------------------------------------------------------------------------

// Intrepid ExtraBold: the font the owner uses in PixelLab (their Intreb__.ttf is the same file, checked byte for byte)
const typo = (size: number, minSize: number, lineHeight: number, position: RoleTypography['position'] = 'middle', letterSpacing = 0): RoleTypography => ({
  englishFont: 'Intrepid ExtraBold',
  teluguFont: 'Ramabhadra',
  weight: 'bold',
  size,
  minSize,
  maxSize: 160,
  lineHeight,
  letterSpacing,
  align: 'center',
  position
});

/**
 * The house style (2026-11-24, matched to the owner's own PixelLab memes): soft lemon yellow over white, a thin dark
 * outline with a soft offset shadow (instead of the old heavy 8 px outline that filled the gaps between letters), and
 * a dark shade fading up behind text that sits on a picture.
 */
const fx = (shade = false, pattern: RoleEffects['highlight']['pattern'] = 'first', shadeOpacity = 0.65): RoleEffects => ({
  fill: { color: '#FFFFFF', opacity: 1 },
  highlight: { enabled: true, color: '#FAE944', pattern },
  stroke: { enabled: true, width: 5, color: '#000000', opacity: 1 },
  shadow: { enabled: true, color: '#000000', blur: 3, offsetX: 3, offsetY: 3, opacity: 0.9 },
  shade: { enabled: shade, opacity: shadeOpacity }
});

/** Built-in defaults; the pipeline sections follow the given .env configuration when provided. */
export function defaultSettings(env?: AppConfig): AppSettings {
  const d = env?.discovery;
  const enabled = (id: string) => (d ? d.enabledProviders.includes(id) || !['wikimedia-commons', 'wikipedia', 'openverse'].includes(id) : true);
  return {
    version: 2,
    name: '@kanyaraasi_memes house style',
    typography: {
      fontSizeScale: 1,
      textScales: {},
      roles: {
        heading: typo(48, 26, 1.08),
        labels: typo(33, 18, 1.2),
        supporting: typo(42, 22, 1.11, 'bottom', 2),
        punchline: typo(64, 24, 0.94, 'middle', 2),
        caption: typo(34, 20, 1.1)
      }
    },
    effects: {
      roles: {
        heading: fx(false, 'alternate'),
        labels: fx(),
        supporting: fx(true, 'alternate'),
        punchline: fx(true, 'first', 1), // fades to solid black at the bottom edge
        caption: fx()
      }
    },
    canvas: {
      aspect: 'portrait_4_5',
      outputScale: 1,
      background: '#000000',
      headerBackground: '#000000',
      safeMargin: 0,
      headerRatio: null,
      maxHeaderRatio: 0.2,
      punchlineRatio: 0.38,
      punchlineMaxGrowRatio: 0.62,
      punchlineSetupScale: 0.82,
      imageGap: 0,
      sectionGap: 0,
      cornerRadius: 0,
      minSlotSize: 140
    },
    imageProcessing: {
      subjectFit: 'cover',
      reactionFit: 'cover',
      portraitAnchorY: 0.28,
      landscapeAnchorY: 0.4,
      reactionAnchorY: 0.36,
      useFocalPoint: true,
      trimBorders: true,
      jpegQuality: 92,
      primaryFormat: 'png',
      duplicateSensitivity: d?.duplicateHamming ?? 6,
      minImageSide: d?.minImageSide ?? 250,
      maxUpscale: d?.maxUpscale ?? 2.5,
      watermarkPolicy: d?.watermarkPolicy ?? 'prefer_clean'
    },
    discovery: {
      providers: {
        wikimediaCommons: enabled('wikimedia-commons'),
        wikipedia: enabled('wikipedia'),
        openverse: enabled('openverse'),
        googleVision: true,
        brave: true
      },
      rightsPolicy: d?.rightsPolicy ?? 'allow_copyrighted',
      maxCandidatesChecked: d?.maxDownloadsPerSlot ?? 14,
      maxRounds: Math.min(3, d?.maxRounds ?? 3),
      identityMinConfidence: Math.max(0.8, env?.identity?.aiMinConfidence ?? 0.8),
      visualMinConfidence: d?.visualMinConfidence ?? 0.6
    },
    advanced: {
      analysisTimeoutSec: Math.round((env?.vision?.timeoutMs ?? 180_000) / 1000),
      downloadTimeoutSec: Math.round((d?.downloadTimeoutMs ?? 20_000) / 1000),
      retryCount: env?.vision?.maxAttempts ?? 2,
      maxConcurrentGenerations: env?.adaptationMaxConcurrent ?? 1,
      maxUploadMB: Math.round(((env)?.limits?.maxUploadBytes ?? HARD_MAX_UPLOAD_MB * 1024 * 1024) / (1024 * 1024)),
      diagnostics: env?.diagnostics ?? false,
      logLevel: env?.logLevel ?? 'log'
    }
  };
}

// ------------------------------------------------------------------------------------------------
// Schema: allowed values (also sent to the frontend, so its controls use the same limits)
// ------------------------------------------------------------------------------------------------

export type FieldSpec =
  | { kind: 'number'; min: number; max: number; step: number; unit?: string; nullable?: boolean }
  | { kind: 'enum'; values: (string | number)[] }
  | { kind: 'bool' }
  | { kind: 'color' }
  | { kind: 'font'; script: 'english' | 'telugu' }
  | { kind: 'text'; maxLength: number };
type Spec = FieldSpec | { [key: string]: Spec };

const num = (min: number, max: number, step: number, unit?: string, nullable = false): FieldSpec => ({ kind: 'number', min, max, step, unit, nullable });
const oneOf = (...values: (string | number)[]): FieldSpec => ({ kind: 'enum', values });
const bool: FieldSpec = { kind: 'bool' };
const color: FieldSpec = { kind: 'color' };

const ROLE_TYPO_SPEC: Spec = {
  englishFont: { kind: 'font', script: 'english' },
  teluguFont: { kind: 'font', script: 'telugu' },
  weight: oneOf('normal', 'bold'),
  size: num(10, 200, 1, 'px'),
  minSize: num(8, 120, 1, 'px'),
  maxSize: num(12, 240, 1, 'px'),
  lineHeight: num(0.8, 2, 0.01),
  letterSpacing: num(-5, 30, 0.5, 'px'),
  align: oneOf('left', 'center', 'right'),
  position: oneOf('top', 'middle', 'bottom')
};

const ROLE_FX_SPEC: Spec = {
  fill: { color, opacity: num(0.1, 1, 0.05) },
  highlight: { enabled: bool, color, pattern: oneOf('first', 'alternate') },
  stroke: { enabled: bool, width: num(0, 24, 0.5, 'px'), color, opacity: num(0, 1, 0.05) },
  shadow: { enabled: bool, color, blur: num(0, 40, 1, 'px'), offsetX: num(-20, 20, 1, 'px'), offsetY: num(-20, 20, 1, 'px'), opacity: num(0, 1, 0.05) },
  shade: { enabled: bool, opacity: num(0.1, 1, 0.05) }
};

const perRole = (s: Spec): Spec => Object.fromEntries(TEXT_ROLES.map(r => [r, s]));

export const SETTINGS_SCHEMA: { [K in SettingsSection]: Spec } & { name: Spec } = {
  name: { kind: 'text', maxLength: 80 },
  typography: {
    fontSizeScale: num(0.6, 1.6, 0.05),
    /** Per-element multipliers kept from the version 1 profile (regeneration sets these per meme). */
    textScales: {
      headline: num(0.5, 2, 0.05),
      labels: num(0.5, 2, 0.05),
      statement: num(0.5, 2, 0.05),
      bullets: num(0.5, 2, 0.05),
      reactionContext: num(0.5, 2, 0.05),
      punchline: num(0.5, 2, 0.05)
    },
    roles: perRole(ROLE_TYPO_SPEC)
  },
  effects: { roles: perRole(ROLE_FX_SPEC) },
  canvas: {
    aspect: oneOf('portrait_4_5', 'square_1_1', 'story_9_16'),
    outputScale: oneOf(1, 1.5, 2),
    background: color,
    headerBackground: color,
    safeMargin: num(0, 80, 1, 'px'),
    headerRatio: num(0.05, 0.2, 0.005, undefined, true),
    maxHeaderRatio: num(0.12, 0.3, 0.01),
    punchlineRatio: num(0.2, 0.6, 0.01),
    punchlineMaxGrowRatio: num(0.4, 0.8, 0.01),
    punchlineSetupScale: num(0.6, 1, 0.01),
    imageGap: num(0, 24, 1, 'px'),
    sectionGap: num(0, 24, 1, 'px'),
    cornerRadius: num(0, 40, 1, 'px'),
    minSlotSize: num(100, 400, 10, 'px')
  },
  imageProcessing: {
    subjectFit: oneOf('cover', 'contain'),
    reactionFit: oneOf('cover', 'contain'),
    portraitAnchorY: num(0, 1, 0.01),
    landscapeAnchorY: num(0, 1, 0.01),
    reactionAnchorY: num(0, 1, 0.01),
    useFocalPoint: bool,
    trimBorders: bool,
    jpegQuality: num(50, 100, 1),
    primaryFormat: oneOf('png', 'jpeg'),
    duplicateSensitivity: num(4, 10, 1),
    minImageSide: num(250, 1000, 10, 'px'),
    maxUpscale: num(1.25, 2.5, 0.05, 'x'),
    watermarkPolicy: oneOf('prefer_clean', 'reject')
  },
  discovery: {
    providers: { wikimediaCommons: bool, wikipedia: bool, openverse: bool, googleVision: bool, brave: bool },
    rightsPolicy: oneOf('allow_copyrighted', 'open_license_only'),
    maxCandidatesChecked: num(4, 30, 1),
    maxRounds: num(1, 3, 1),
    identityMinConfidence: num(0.8, 0.99, 0.01),
    visualMinConfidence: num(0.6, 0.95, 0.01)
  },
  advanced: {
    analysisTimeoutSec: num(60, 600, 10, 's'),
    downloadTimeoutSec: num(5, 120, 1, 's'),
    retryCount: num(1, 4, 1),
    maxConcurrentGenerations: num(1, 4, 1),
    maxUploadMB: num(1, HARD_MAX_UPLOAD_MB, 1, 'MB'),
    diagnostics: bool,
    logLevel: oneOf('error', 'warn', 'log', 'debug', 'verbose')
  }
};

// ------------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
const isLeaf = (s: Spec): s is FieldSpec => typeof (s as FieldSpec).kind === 'string' && !('roles' in (s as object));

function validateLeaf(spec: FieldSpec, v: unknown, where: string, errors: string[]): { ok: boolean; value?: unknown } {
  switch (spec.kind) {
    case 'number':
      if (v === null && spec.nullable) return { ok: true, value: null };
      if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) {
        errors.push(`${where} must be a number from ${spec.min} to ${spec.max}${spec.nullable ? ' (or null for automatic)' : ''}`);
        return { ok: false };
      }
      return { ok: true, value: Math.round(v * 1000) / 1000 };
    case 'enum':
      if (!spec.values.includes(v as string | number)) {
        errors.push(`${where} must be one of ${spec.values.join(', ')}`);
        return { ok: false };
      }
      return { ok: true, value: v };
    case 'bool':
      if (typeof v !== 'boolean') {
        errors.push(`${where} must be true or false`);
        return { ok: false };
      }
      return { ok: true, value: v };
    case 'color':
      if (typeof v !== 'string' || !HEX.test(v)) {
        errors.push(`${where} must be a colour like #FFE500`);
        return { ok: false };
      }
      return { ok: true, value: v.toUpperCase() };
    case 'font': {
      const list = spec.script === 'english' ? ENGLISH_FONTS : TELUGU_FONTS;
      if (typeof v !== 'string' || !list.includes(v)) {
        errors.push(`${where} must be an installed ${spec.script === 'english' ? 'English' : 'Telugu'} font: ${list.join(', ')}`);
        return { ok: false };
      }
      return { ok: true, value: v };
    }
    case 'text':
      if (typeof v !== 'string' || !v.trim() || v.length > spec.maxLength) {
        errors.push(`${where} must be 1-${spec.maxLength} characters`);
        return { ok: false };
      }
      return { ok: true, value: v.trim() };
  }
}

function applyPatch(spec: Spec, target: Record<string, any>, patch: unknown, where: string, errors: string[]) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    errors.push(`${where || 'settings'} must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const sub = (spec as Record<string, Spec>)[k];
    const path = where ? `${where}.${k}` : k;
    if (!sub) {
      errors.push(`"${path}" is not a setting`);
      continue;
    }
    if (isLeaf(sub)) {
      const r = validateLeaf(sub, v, path, errors);
      if (r.ok) target[k] = r.value;
    } else {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      applyPatch(sub, target[k], v, path, errors);
    }
  }
}

function crossChecks(s: AppSettings, errors: string[]) {
  for (const r of TEXT_ROLES) {
    const t = s.typography.roles[r];
    if (t.minSize > t.size) errors.push(`typography.roles.${r}: minimum size (${t.minSize}) is larger than the size (${t.size})`);
    if (t.maxSize < t.size) errors.push(`typography.roles.${r}: maximum size (${t.maxSize}) is smaller than the size (${t.size})`);
  }
  const c = s.canvas;
  if (c.headerRatio !== null && c.headerRatio > c.maxHeaderRatio) errors.push('canvas.headerRatio is larger than canvas.maxHeaderRatio');
  if (c.punchlineRatio > c.punchlineMaxGrowRatio) errors.push('canvas.punchlineRatio is larger than canvas.punchlineMaxGrowRatio');
}

/** Validates a partial update against the current settings. Unknown keys and invalid values are refused (nothing is saved). */
export function mergeSettingsPatch(current: AppSettings, patch: unknown): AppSettings {
  const next: AppSettings = JSON.parse(JSON.stringify(current));
  const errors: string[] = [];
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const { version, updatedAt, ...rest } = patch as Record<string, unknown>;
    void version;
    void updatedAt;
    applyPatch(SETTINGS_SCHEMA as unknown as Spec, next as unknown as Record<string, any>, rest, '', errors);
  } else {
    errors.push('settings must be a JSON object');
  }
  if (!errors.length) crossChecks(next, errors);
  if (errors.length) throw new BadRequestException({ statusCode: 400, message: 'Invalid settings', errors });
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Fills a stored (possibly older or partial) settings document from defaults, dropping unknown keys. */
export function normalizeStoredSettings(stored: unknown, defaults: AppSettings): AppSettings {
  const next: AppSettings = JSON.parse(JSON.stringify(defaults));
  if (!stored || typeof stored !== 'object') return next;
  const errors: string[] = [];
  const { version, updatedAt, ...rest } = stored as Record<string, unknown>;
  void version;
  // Invalid stored values (e.g. a font that was removed) silently fall back to the default.
  applyPatch(SETTINGS_SCHEMA as unknown as Spec, next as unknown as Record<string, any>, rest, '', errors);
  const cross: string[] = [];
  crossChecks(next, cross);
  if (cross.length) return defaults;
  if (typeof updatedAt === 'string') next.updatedAt = updatedAt;
  return next;
}

/**
 * The values of `s` that differ from `defaults`. Only these are stored, so a value nobody changed
 * keeps following the defaults (and the .env file for the pipeline sections).
 */
export function settingsDelta(s: AppSettings, defaults: AppSettings): Record<string, unknown> {
  const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const walk = (a: unknown, b: unknown): unknown => {
    if (isObj(a) && isObj(b)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(a)) {
        if (k === 'version' || k === 'updatedAt') continue;
        const d = walk(a[k], b[k]);
        if (d !== undefined) out[k] = d;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? undefined : a;
  };
  return (walk(s, defaults) as Record<string, unknown>) || {};
}

export function resetSection(current: AppSettings, section: SettingsSection | 'all', defaults: AppSettings): AppSettings {
  if (section === 'all') return { ...JSON.parse(JSON.stringify(defaults)), updatedAt: new Date().toISOString() };
  if (!SETTINGS_SECTIONS.includes(section)) throw new BadRequestException(`Unknown settings section "${section}"; use one of ${SETTINGS_SECTIONS.join(', ')} or all`);
  const next: AppSettings = JSON.parse(JSON.stringify(current));
  (next as any)[section] = JSON.parse(JSON.stringify((defaults as any)[section]));
  next.updatedAt = new Date().toISOString();
  return next;
}

// ------------------------------------------------------------------------------------------------
// Colour helpers
// ------------------------------------------------------------------------------------------------

export function hexToRgba(hex: string, opacity: number): string {
  if (opacity >= 1) return hex.toUpperCase();
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.round(opacity * 1000) / 1000})`;
}

/** Parses #RRGGBB or rgba()/rgb() into a hex colour and an opacity. */
export function parseCssColor(css: string | undefined, fallback: { color: string; opacity: number }): { color: string; opacity: number } {
  if (!css) return fallback;
  if (HEX.test(css)) return { color: css.toUpperCase(), opacity: 1 };
  const m = css.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
  if (!m) return fallback;
  const hex = '#' + [m[1], m[2], m[3]].map(x => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('').toUpperCase();
  return { color: hex, opacity: m[4] !== undefined ? Math.min(1, Math.max(0, Number(m[4]))) : 1 };
}

// ------------------------------------------------------------------------------------------------
// Runtime (pipeline) overrides for app-config
// ------------------------------------------------------------------------------------------------

const PROVIDER_IDS: Record<keyof DiscoverySettings['providers'], string> = {
  wikimediaCommons: 'wikimedia-commons',
  wikipedia: 'wikipedia',
  openverse: 'openverse',
  googleVision: 'google-vision-web',
  brave: 'brave-images'
};

export function runtimeOverridesFromSettings(s: AppSettings): RuntimeOverrides {
  const d = s.discovery;
  const ip = s.imageProcessing;
  const a = s.advanced;
  return {
    discovery: {
      disabledProviders: (Object.keys(PROVIDER_IDS) as (keyof typeof PROVIDER_IDS)[]).filter(k => !d.providers[k]).map(k => PROVIDER_IDS[k]),
      rightsPolicy: d.rightsPolicy,
      maxDownloadsPerSlot: d.maxCandidatesChecked,
      maxRounds: d.maxRounds,
      visualMinConfidence: d.visualMinConfidence,
      duplicateHamming: ip.duplicateSensitivity,
      minImageSide: ip.minImageSide,
      maxUpscale: ip.maxUpscale,
      watermarkPolicy: ip.watermarkPolicy,
      downloadTimeoutMs: a.downloadTimeoutSec * 1000
    },
    vision: { timeoutMs: a.analysisTimeoutSec * 1000, maxAttempts: a.retryCount },
    identity: { aiMinConfidence: d.identityMinConfidence },
    adaptationMaxConcurrent: a.maxConcurrentGenerations,
    limits: { maxUploadBytes: a.maxUploadMB * 1024 * 1024 },
    diagnostics: a.diagnostics,
    logLevel: a.logLevel
  };
}
