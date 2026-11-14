/**
 * Personal design profile (version 1 view). The reference meme decides STRUCTURE and CONTENT; the
 * page's settings decide the final VISUAL STYLE of every new meme.
 *
 * Since Settings (design/settings.ts) the source of truth is the version 2 settings document. This
 * flat profile is DERIVED from it (GET /api/design-profile keeps working), a profile update is
 * mapped back onto the settings, and a stored version 1 profile is migrated on first read.
 */
import { BadRequestException } from '@nestjs/common';
import { DesignSpecifications, TextScales } from '../types/meme.types';
import { ENGLISH_FONTS, TELUGU_FONTS } from './fonts';
import { AppSettings, CANVAS_SIZES, CanvasAspect, defaultSettings, hexToRgba, parseCssColor, TEXT_ROLES } from './settings';

export interface DesignProfile {
  profileId: string;
  name: string;
  canvas: { preset: CanvasAspect; width: number; height: number };
  typography: { englishFont: string; teluguFont: string; fontSizeScale: number; textScales: TextScales };
  colors: { primary: string; secondary: string; headerBackground: string; headerText: string; outline: string; shadow: string };
  effects: { outlineThickness: number; shadowBlur: number; shadowOffsetX: number; shadowOffsetY: number };
  imagery: {
    /** Usual subject image shapes (width / height): 3:4 and 2:3 portraits. */
    subjectAspectPreference: number[];
    /** Usual reaction image shape: 16:9. */
    reactionAspect: number;
    gaps: number;
    dividerLines: boolean;
    borders: boolean;
  };
  layout: { headerHeightRatio: number };
  updatedAt?: string;
}

export const DEFAULT_PROFILE_ID = 'kanyaraasi-default';
/** Header share used when neither the reference nor the settings decide it. */
export const DEFAULT_HEADER_RATIO = 0.082;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The flat (version 1) profile view of the settings. */
export function profileFromSettings(s: AppSettings, profileId = DEFAULT_PROFILE_ID): DesignProfile {
  const r = s.typography.roles;
  const e = s.effects.roles;
  const p = e.punchline;
  const size = CANVAS_SIZES[s.canvas.aspect];
  const profile: DesignProfile = {
    profileId,
    name: s.name,
    canvas: { preset: s.canvas.aspect, width: size.width, height: size.height },
    typography: { englishFont: r.heading.englishFont, teluguFont: r.punchline.teluguFont, fontSizeScale: s.typography.fontSizeScale, textScales: { ...(s.typography.textScales || {}) } },
    colors: {
      primary: p.highlight.color,
      secondary: p.fill.color,
      headerBackground: s.canvas.headerBackground,
      headerText: e.heading.highlight.color,
      outline: p.stroke.color,
      shadow: hexToRgba(p.shadow.color, p.shadow.opacity)
    },
    effects: { outlineThickness: p.stroke.enabled ? p.stroke.width : 0, shadowBlur: p.shadow.blur, shadowOffsetX: p.shadow.offsetX, shadowOffsetY: p.shadow.offsetY },
    imagery: { subjectAspectPreference: [0.75, 0.667], reactionAspect: 16 / 9, gaps: s.canvas.imageGap, dividerLines: false, borders: false },
    layout: { headerHeightRatio: s.canvas.headerRatio ?? DEFAULT_HEADER_RATIO }
  };
  if (s.updatedAt) profile.updatedAt = s.updatedAt;
  return profile;
}

/** The house style (= the default settings). */
export const KANYARAASI_DEFAULT_PROFILE: DesignProfile = profileFromSettings(defaultSettings());

/**
 * Applies a version 1 profile to the settings. Only values that differ from `prev` are applied, so
 * per-role choices made in Settings are not overwritten by profile values nobody changed. A changed
 * value applies to every text role, which is what it always meant.
 */
export function applyLegacyProfile(settings: AppSettings, next: DesignProfile, prev: DesignProfile = KANYARAASI_DEFAULT_PROFILE): AppSettings {
  const s = clone(settings);
  const changed = (get: (p: DesignProfile) => unknown) => JSON.stringify(get(next) ?? null) !== JSON.stringify(get(prev) ?? null);
  const roles = (fn: (r: (typeof TEXT_ROLES)[number]) => void) => TEXT_ROLES.forEach(fn);
  const fx = s.effects.roles;
  const ty = s.typography.roles;

  if (changed(p => p.name) && typeof next.name === 'string' && next.name.trim()) s.name = next.name.trim().slice(0, 80);
  const t = next.typography || ({} as DesignProfile['typography']);
  if (changed(p => p.typography?.englishFont) && ENGLISH_FONTS.includes(t.englishFont)) roles(r => (ty[r].englishFont = t.englishFont));
  if (changed(p => p.typography?.teluguFont) && TELUGU_FONTS.includes(t.teluguFont)) roles(r => (ty[r].teluguFont = t.teluguFont));
  if (changed(p => p.typography?.fontSizeScale) && Number.isFinite(t.fontSizeScale)) s.typography.fontSizeScale = clamp(t.fontSizeScale, 0.6, 1.6);
  if (changed(p => p.typography?.textScales) && t.textScales && typeof t.textScales === 'object') s.typography.textScales = { ...(t.textScales as Record<string, number>) };

  const c = next.colors || ({} as DesignProfile['colors']);
  const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  if (changed(p => p.colors?.primary) && hex(c.primary)) roles(r => r !== 'heading' && (fx[r].highlight.color = c.primary.toUpperCase()));
  if (changed(p => p.colors?.headerText) && hex(c.headerText)) fx.heading.highlight.color = c.headerText.toUpperCase();
  if (changed(p => p.colors?.secondary) && hex(c.secondary)) roles(r => (fx[r].fill.color = c.secondary.toUpperCase()));
  if (changed(p => p.colors?.headerBackground) && hex(c.headerBackground)) s.canvas.headerBackground = c.headerBackground.toUpperCase();
  if (changed(p => p.colors?.outline) && hex(c.outline)) roles(r => (fx[r].stroke.color = c.outline.toUpperCase()));
  if (changed(p => p.colors?.shadow)) {
    const parsed = parseCssColor(c.shadow, { color: '', opacity: 1 });
    if (parsed.color) roles(r => Object.assign(fx[r].shadow, { color: parsed.color, opacity: parsed.opacity }));
  }

  const e = next.effects || ({} as DesignProfile['effects']);
  if (changed(p => p.effects?.outlineThickness) && Number.isFinite(e.outlineThickness)) {
    const w = clamp(e.outlineThickness, 0, 24);
    roles(r => Object.assign(fx[r].stroke, { width: w, enabled: w > 0 }));
  }
  if (changed(p => p.effects?.shadowBlur) && Number.isFinite(e.shadowBlur)) roles(r => (fx[r].shadow.blur = clamp(e.shadowBlur, 0, 40)));
  if (changed(p => p.effects?.shadowOffsetX) && Number.isFinite(e.shadowOffsetX)) roles(r => (fx[r].shadow.offsetX = clamp(e.shadowOffsetX, -20, 20)));
  if (changed(p => p.effects?.shadowOffsetY) && Number.isFinite(e.shadowOffsetY)) roles(r => (fx[r].shadow.offsetY = clamp(e.shadowOffsetY, -20, 20)));

  if (changed(p => p.canvas?.preset) && next.canvas?.preset && CANVAS_SIZES[next.canvas.preset]) s.canvas.aspect = next.canvas.preset;
  if (changed(p => p.layout?.headerHeightRatio) && Number.isFinite(next.layout?.headerHeightRatio)) {
    const v = next.layout.headerHeightRatio;
    s.canvas.headerRatio = Math.abs(v - DEFAULT_HEADER_RATIO) < 1e-9 ? null : clamp(v, 0.05, 0.2);
    if (s.canvas.headerRatio !== null && s.canvas.headerRatio > s.canvas.maxHeaderRatio) s.canvas.maxHeaderRatio = Math.min(0.3, s.canvas.headerRatio);
  }
  if (changed(p => p.imagery?.gaps) && Number.isFinite(next.imagery?.gaps)) s.canvas.imageGap = clamp(Math.round(next.imagery.gaps), 0, 24);
  return s;
}

/** Settings for a stored version 1 profile (migration: its values on top of the defaults). */
export function settingsFromLegacyProfile(stored: Partial<DesignProfile>, defaults: AppSettings): AppSettings {
  const full: DesignProfile = { ...clone(KANYARAASI_DEFAULT_PROFILE), ...(stored as DesignProfile), profileId: DEFAULT_PROFILE_ID };
  return applyLegacyProfile(defaults, full, KANYARAASI_DEFAULT_PROFILE);
}

/**
 * DesignSpecifications from a version 1 profile (optionally overriding the English font), WITHOUT a
 * settings snapshot: the renderer uses its original constants. New memes use designFromSettings().
 */
export function profileToDesignSpecs(p: DesignProfile, englishFontOverride?: string): DesignSpecifications {
  const englishFont = englishFontOverride && ENGLISH_FONTS.includes(englishFontOverride) ? englishFontOverride : p.typography.englishFont;
  return {
    fontFamily: englishFont,
    teluguFontFamily: p.typography.teluguFont,
    canvasPreset: p.canvas.preset,
    width: p.canvas.width,
    height: p.canvas.height,
    primaryTextColor: p.colors.primary,
    secondaryTextColor: p.colors.secondary,
    headerBgColor: p.colors.headerBackground,
    headerTextColor: p.colors.headerText,
    outlineColor: p.colors.outline,
    outlineThickness: p.effects.outlineThickness,
    shadowColor: p.colors.shadow,
    shadowBlur: p.effects.shadowBlur,
    shadowOffsetX: p.effects.shadowOffsetX,
    shadowOffsetY: p.effects.shadowOffsetY,
    fontSizeScale: p.typography.fontSizeScale,
    textScales: { ...p.typography.textScales },
    textAlignment: 'center'
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba?\(\s*[0-9.\s,%]+\)$/i;

/** Validates a partial profile update (unknown keys are rejected; nothing else changes). */
export function mergeProfileUpdate(current: DesignProfile, body: unknown): DesignProfile {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Profile update must be a JSON object');
  const b = body as Record<string, any>;
  const errors: string[] = [];
  const next: DesignProfile = JSON.parse(JSON.stringify(current));
  const allowedTop = ['name', 'typography', 'colors', 'effects', 'canvas', 'layout'];
  for (const k of Object.keys(b)) if (!allowedTop.includes(k)) errors.push(`"${k}" cannot be changed`);

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) errors.push('name must be 1-80 characters');
    else next.name = b.name.trim();
  }
  if (b.typography) {
    const t = b.typography;
    if (t.englishFont !== undefined) {
      if (!ENGLISH_FONTS.includes(t.englishFont)) errors.push(`englishFont must be one of ${ENGLISH_FONTS.join(', ')}`);
      else next.typography.englishFont = t.englishFont;
    }
    if (t.teluguFont !== undefined) {
      if (!TELUGU_FONTS.includes(t.teluguFont)) errors.push(`teluguFont must be one of ${TELUGU_FONTS.join(', ')}`);
      else next.typography.teluguFont = t.teluguFont;
    }
    if (t.fontSizeScale !== undefined) {
      if (typeof t.fontSizeScale !== 'number' || t.fontSizeScale < 0.6 || t.fontSizeScale > 1.6) errors.push('fontSizeScale must be 0.6-1.6');
      else next.typography.fontSizeScale = t.fontSizeScale;
    }
  }
  if (b.colors) {
    for (const k of ['primary', 'secondary', 'headerBackground', 'headerText', 'outline'] as const) {
      if (b.colors[k] !== undefined) {
        if (typeof b.colors[k] !== 'string' || !HEX.test(b.colors[k])) errors.push(`colors.${k} must be #RRGGBB`);
        else next.colors[k] = b.colors[k].toUpperCase();
      }
    }
    if (b.colors.shadow !== undefined) {
      if (typeof b.colors.shadow !== 'string' || !(HEX.test(b.colors.shadow) || RGBA.test(b.colors.shadow))) errors.push('colors.shadow must be #RRGGBB or rgba()');
      else next.colors.shadow = b.colors.shadow;
    }
  }
  if (b.effects) {
    const e = b.effects;
    const n = (v: unknown, lo: number, hi: number, name: string, set: (x: number) => void) => {
      if (v === undefined) return;
      if (typeof v !== 'number' || v < lo || v > hi) errors.push(`${name} must be ${lo}-${hi}`);
      else set(v);
    };
    n(e.outlineThickness, 2, 16, 'outlineThickness', x => (next.effects.outlineThickness = x));
    n(e.shadowBlur, 0, 30, 'shadowBlur', x => (next.effects.shadowBlur = x));
  }
  if (b.canvas?.preset !== undefined) {
    if (typeof b.canvas.preset === 'string' && CANVAS_SIZES[b.canvas.preset as CanvasAspect]) {
      const preset = b.canvas.preset as CanvasAspect;
      next.canvas = { preset, ...CANVAS_SIZES[preset] };
    } else errors.push('canvas.preset must be portrait_4_5, square_1_1 or story_9_16');
  }
  if (b.layout?.headerHeightRatio !== undefined) {
    const v = b.layout.headerHeightRatio;
    if (typeof v !== 'number' || v < 0.06 || v > 0.2) errors.push('layout.headerHeightRatio must be 0.06-0.2');
    else next.layout.headerHeightRatio = v;
  }
  if (errors.length) throw new BadRequestException(errors.join('; '));
  next.updatedAt = new Date().toISOString();
  return next;
}
