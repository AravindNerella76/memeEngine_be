/**
 * The visual style the renderer and layout engine use for one meme.
 *
 *  - New memes carry a snapshot of the settings in design.style, taken at generation time. Later
 *    settings changes therefore never alter an existing meme or any of its versions.
 *  - Memes created before settings existed have no snapshot: legacyRenderStyle() reproduces the
 *    renderer's original constants exactly (pixel-identical output, checked by tests).
 *  - Regeneration keeps editing the meme's own flat design fields (font, colours, outline, scales).
 *    Those act as overrides ("knobs") on top of the snapshot: when one differs from the value the
 *    snapshot recorded, it is applied to every text role, as it always was.
 */
import type { DesignSpecifications } from '../types/meme.types';
import { ENGLISH_FONTS, TELUGU_FONTS } from './fonts';
import { AppSettings, CANVAS_SIZES, CanvasSettings, hexToRgba, ImageProcessingSettings, parseCssColor, RoleEffects, RoleTypography, TEXT_ROLES, TextRoleId, WatermarkSettings } from './settings';

export interface StyleKnobs {
  fontFamily: string;
  teluguFontFamily: string;
  primaryTextColor: string;
  secondaryTextColor: string;
  headerTextColor: string;
  headerBgColor: string;
  outlineColor: string;
  outlineThickness: number;
  shadowColor: string;
  shadowBlur: number;
}

export type StyleImageSettings = Pick<
  ImageProcessingSettings,
  'subjectFit' | 'reactionFit' | 'portraitAnchorY' | 'landscapeAnchorY' | 'reactionAnchorY' | 'useFocalPoint' | 'jpegQuality' | 'primaryFormat' | 'trimBorders'
>;

export interface StyleSnapshot {
  version: 2;
  /**
   * Text rules in force when the snapshot was taken. 2 (2026-11-24): a number stays on the line of the word after it
   * ("4 TRILLION", never "OVER 4" / "TRILLION"). Missing on older snapshots, which keep wrapping as they did.
   */
  rev?: number;
  roles: Record<TextRoleId, { typography: RoleTypography; effects: RoleEffects }>;
  canvas: CanvasSettings;
  image: StyleImageSettings;
  /** The flat design values the snapshot corresponds to (see the module comment). */
  knobs: StyleKnobs;
  takenAt: string;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** The flat design values that correspond to settings (also shown by the legacy profile API). */
export function knobsFromSettings(s: AppSettings): StyleKnobs {
  const r = s.typography.roles;
  const e = s.effects.roles;
  return {
    fontFamily: r.heading.englishFont,
    teluguFontFamily: r.punchline.teluguFont,
    primaryTextColor: e.punchline.highlight.color,
    secondaryTextColor: e.punchline.fill.color,
    headerTextColor: e.heading.highlight.color,
    headerBgColor: s.canvas.headerBackground,
    outlineColor: e.punchline.stroke.color,
    outlineThickness: e.punchline.stroke.enabled ? e.punchline.stroke.width : 0,
    shadowColor: hexToRgba(e.punchline.shadow.color, e.punchline.shadow.opacity),
    shadowBlur: e.punchline.shadow.blur
  };
}

export function styleSnapshotFromSettings(s: AppSettings): StyleSnapshot {
  const ip = s.imageProcessing;
  return {
    version: 2,
    rev: 2,
    roles: Object.fromEntries(TEXT_ROLES.map(r => [r, { typography: clone(s.typography.roles[r]), effects: clone(s.effects.roles[r]) }])) as StyleSnapshot['roles'],
    canvas: clone(s.canvas),
    image: {
      subjectFit: ip.subjectFit,
      reactionFit: ip.reactionFit,
      portraitAnchorY: ip.portraitAnchorY,
      landscapeAnchorY: ip.landscapeAnchorY,
      reactionAnchorY: ip.reactionAnchorY,
      useFocalPoint: ip.useFocalPoint,
      trimBorders: ip.trimBorders,
      jpegQuality: ip.jpegQuality,
      primaryFormat: ip.primaryFormat
    },
    knobs: knobsFromSettings(s),
    takenAt: new Date().toISOString()
  };
}

/**
 * DesignSpecifications for a new meme from the current settings, with the style snapshot attached.
 * `englishFontOverride` (an installed font chosen for this one meme) applies to all English text.
 */
export function designFromSettings(s: AppSettings, englishFontOverride?: string): DesignSpecifications {
  const k = knobsFromSettings(s);
  const size = CANVAS_SIZES[s.canvas.aspect];
  const shadow = s.effects.roles.punchline.shadow;
  return {
    fontFamily: englishFontOverride && ENGLISH_FONTS.includes(englishFontOverride) ? englishFontOverride : k.fontFamily,
    teluguFontFamily: k.teluguFontFamily,
    canvasPreset: s.canvas.aspect,
    width: size.width,
    height: size.height,
    primaryTextColor: k.primaryTextColor,
    secondaryTextColor: k.secondaryTextColor,
    headerBgColor: k.headerBgColor,
    headerTextColor: k.headerTextColor,
    outlineColor: k.outlineColor,
    outlineThickness: k.outlineThickness,
    shadowColor: k.shadowColor,
    shadowBlur: shadow.blur,
    shadowOffsetX: shadow.offsetX,
    shadowOffsetY: shadow.offsetY,
    fontSizeScale: s.typography.fontSizeScale,
    textScales: { ...(s.typography.textScales || {}) },
    textAlignment: 'center',
    style: styleSnapshotFromSettings(s)
  };
}

// ------------------------------------------------------------------------------------------------
// Resolved style for the renderer
// ------------------------------------------------------------------------------------------------

export type TextElementId = 'headline' | 'labels' | 'statement' | 'bullets' | 'reactionContext' | 'punchline';

export interface ElementStyle {
  englishFont: string;
  teluguFont: string;
  weight: 'normal' | 'bold';
  /** Base size in px before the meme's global/per-element scales. */
  size: number;
  /** Labels only: base size in comparison memes (larger). */
  comparisonSize?: number;
  minSize: number;
  maxSize: number;
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  position: 'top' | 'middle' | 'bottom';
  fillCss: string;
  /** null = highlighting off (every line uses the fill colour). */
  highlightCss: string | null;
  /** Heading and supporting text: highlight only the first line, or every other line. */
  highlightPattern: 'first' | 'alternate';
  /** Opacity of the dark shade behind the text (0 = none). */
  shadeAlpha: number;
  /** A number is never left at the end of a line: it moves down with the word it counts. */
  keepNumbersWithWords: boolean;
  /** null = no outline. */
  strokeCss: string | null;
  strokeWidth: number;
  /** null = no shadow. */
  shadowCss: string | null;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

export interface RenderStyle {
  legacy: boolean;
  elements: Record<TextElementId, ElementStyle>;
  canvas: { background: string; headerBackground: string; cornerRadius: number; outputScale: number; punchlineMaxGrowRatio: number; maxHeaderRatio: number; punchlineSetupScale: number };
  image: { subjectFit: 'cover' | 'contain'; reactionFit: 'cover' | 'contain'; portraitAnchorY: number; landscapeAnchorY: number; reactionAnchorY: number; useFocalPoint: boolean; jpegQuality: number | null; trimBorders: boolean };
  /** The page's logo on the finished meme; null = none (older memes, or switched off). */
  watermark: WatermarkSettings | null;
}

/** The renderer's original constants (memes without a style snapshot). Do not change: old memes must render identically. */
export function legacyRenderStyle(specs: DesignSpecifications): RenderStyle {
  const primary = specs.primaryTextColor || '#FFE500';
  const secondary = specs.secondaryTextColor || '#FFFFFF';
  const el = (size: number, minSize: number, lineHeight: number, highlight: string): ElementStyle => ({
    englishFont: specs.fontFamily || 'Arial Black',
    teluguFont: specs.teluguFontFamily || 'Ramabhadra',
    weight: 'bold',
    size,
    minSize,
    maxSize: Infinity,
    lineHeight,
    letterSpacing: 0,
    align: 'center',
    position: 'middle',
    fillCss: secondary,
    highlightCss: highlight,
    highlightPattern: 'first',
    shadeAlpha: 0,
    keepNumbersWithWords: false,
    strokeCss: specs.outlineColor || '#000000',
    strokeWidth: specs.outlineThickness || 8,
    shadowCss: specs.shadowColor || 'rgba(0, 0, 0, 0.95)',
    shadowBlur: specs.shadowBlur !== undefined ? specs.shadowBlur : 8,
    shadowOffsetX: 3,
    shadowOffsetY: 3
  });
  return {
    legacy: true,
    elements: {
      headline: el(48, 26, 1.08, specs.headerTextColor || specs.primaryTextColor || '#FFE500'),
      labels: { ...el(33, 18, 1.2, primary), comparisonSize: 36 },
      statement: el(38, 22, 1.17, primary),
      // bullets were drawn with the renderer's built-in shadow, not the design's
      bullets: { ...el(42, 22, 1.2, primary), shadowCss: 'rgba(0,0,0,0.92)', shadowBlur: 8 },
      reactionContext: { ...el(34, 20, 1.1, primary), strokeWidth: specs.outlineThickness || 7 },
      punchline: {
        ...el(46, 24, 1.15, primary),
        strokeWidth: typeof specs.outlineThickness === 'number' ? specs.outlineThickness : 4,
        shadowBlur: typeof specs.shadowBlur === 'number' ? specs.shadowBlur : 13,
        shadowOffsetX: 0,
        shadowOffsetY: 0
      }
    },
    canvas: { background: '#000000', headerBackground: specs.headerBgColor || '#000000', cornerRadius: 0, outputScale: 1, punchlineMaxGrowRatio: 0.62, maxHeaderRatio: 0.2, punchlineSetupScale: 0.74 },
    image: { subjectFit: specs.subjectFit || 'cover', reactionFit: 'cover', portraitAnchorY: 0.28, landscapeAnchorY: 0.4, reactionAnchorY: 0.36, useFocalPoint: true, jpegQuality: null, trimBorders: false },
    watermark: null
  };
}

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
const same = (a: unknown, b: unknown) => norm(a) === norm(b);

/** Snapshot roles with the meme's own flat design fields applied where they differ from the snapshot's knobs. */
function rolesWithKnobs(specs: DesignSpecifications, snap: StyleSnapshot) {
  const roles = clone(snap.roles);
  const k = snap.knobs;
  const all = (fn: (r: TextRoleId) => void) => TEXT_ROLES.forEach(fn);
  if (specs.fontFamily && ENGLISH_FONTS.includes(specs.fontFamily) && !same(specs.fontFamily, k.fontFamily)) all(r => (roles[r].typography.englishFont = specs.fontFamily));
  if (specs.teluguFontFamily && TELUGU_FONTS.includes(specs.teluguFontFamily) && !same(specs.teluguFontFamily, k.teluguFontFamily)) all(r => (roles[r].typography.teluguFont = specs.teluguFontFamily));
  if (specs.primaryTextColor && !same(specs.primaryTextColor, k.primaryTextColor)) all(r => r !== 'heading' && (roles[r].effects.highlight.color = specs.primaryTextColor));
  if (specs.headerTextColor && !same(specs.headerTextColor, k.headerTextColor)) roles.heading.effects.highlight.color = specs.headerTextColor;
  if (specs.secondaryTextColor && !same(specs.secondaryTextColor, k.secondaryTextColor)) all(r => (roles[r].effects.fill.color = specs.secondaryTextColor));
  if (specs.outlineColor && !same(specs.outlineColor, k.outlineColor)) all(r => (roles[r].effects.stroke.color = specs.outlineColor));
  if (typeof specs.outlineThickness === 'number' && specs.outlineThickness !== k.outlineThickness) {
    const t = specs.outlineThickness;
    all(r => {
      const st = roles[r].effects.stroke;
      if (k.outlineThickness > 0 && st.enabled) st.width = Math.round(((st.width * t) / k.outlineThickness) * 10) / 10;
      else {
        st.width = t;
        st.enabled = t > 0;
      }
    });
  }
  if (typeof specs.shadowBlur === 'number' && specs.shadowBlur !== k.shadowBlur) all(r => (roles[r].effects.shadow.blur = specs.shadowBlur));
  if (specs.shadowColor && k.shadowColor !== undefined && !same(specs.shadowColor, k.shadowColor)) {
    const c = parseCssColor(specs.shadowColor, { color: '', opacity: 1 });
    if (c.color) all(r => Object.assign(roles[r].effects.shadow, { color: c.color, opacity: c.opacity }));
  }
  return roles;
}

function snapshotRenderStyle(specs: DesignSpecifications, snap: StyleSnapshot): RenderStyle {
  const roles = rolesWithKnobs(specs, snap);
  const el = (role: TextRoleId, sizeFactor = 1, lineHeightFactor = 1): ElementStyle => {
    const t = roles[role].typography;
    const e = roles[role].effects;
    return {
      englishFont: t.englishFont,
      teluguFont: t.teluguFont,
      weight: t.weight,
      size: t.size * sizeFactor,
      minSize: t.minSize,
      maxSize: t.maxSize,
      lineHeight: t.lineHeight * lineHeightFactor,
      letterSpacing: t.letterSpacing,
      align: t.align,
      position: t.position,
      fillCss: hexToRgba(e.fill.color, e.fill.opacity),
      highlightCss: e.highlight.enabled ? hexToRgba(e.highlight.color, e.fill.opacity) : null,
      // snapshots taken before these existed have neither: first line only, no shade (they render as they always did)
      highlightPattern: e.highlight.pattern === 'alternate' ? 'alternate' : 'first',
      shadeAlpha: e.shade?.enabled ? Math.max(0, Math.min(1, Number(e.shade.opacity) || 0)) : 0,
      keepNumbersWithWords: (snap.rev || 0) >= 2,
      strokeCss: e.stroke.enabled && e.stroke.width > 0 ? hexToRgba(e.stroke.color, e.stroke.opacity) : null,
      strokeWidth: e.stroke.width,
      shadowCss: e.shadow.enabled ? hexToRgba(e.shadow.color, e.shadow.opacity) : null,
      shadowBlur: e.shadow.blur,
      shadowOffsetX: e.shadow.offsetX,
      shadowOffsetY: e.shadow.offsetY
    };
  };
  const labels = el('labels');
  const c = snap.canvas;
  return {
    legacy: false,
    elements: {
      headline: el('heading'),
      labels: { ...labels, comparisonSize: labels.size * (36 / 33) },
      statement: el('supporting'),
      // review bullets keep their slightly larger size and looser spacing relative to the statement
      bullets: el('supporting', 42 / 38, 1.2 / 1.17),
      reactionContext: el('caption'),
      punchline: el('punchline')
    },
    canvas: {
      background: c.background,
      headerBackground: specs.headerBgColor && !same(specs.headerBgColor, snap.knobs.headerBgColor) ? specs.headerBgColor : c.headerBackground,
      cornerRadius: c.cornerRadius,
      outputScale: c.outputScale,
      punchlineMaxGrowRatio: c.punchlineMaxGrowRatio,
      maxHeaderRatio: c.maxHeaderRatio,
      punchlineSetupScale: typeof c.punchlineSetupScale === 'number' ? c.punchlineSetupScale : 0.74
    },
    image: { ...snap.image, trimBorders: snap.image.trimBorders === true, ...(specs.subjectFit ? { subjectFit: specs.subjectFit } : {}) },
    // snapshots taken before the watermark existed have none: those memes stay exactly as they were made
    watermark: c.watermark?.enabled ? { ...c.watermark } : null
  };
}

export function isStyleSnapshot(v: unknown): v is StyleSnapshot {
  const s = v as StyleSnapshot;
  return Boolean(s && s.version === 2 && s.roles && s.canvas && s.image && s.knobs && TEXT_ROLES.every(r => s.roles[r]?.typography && s.roles[r]?.effects));
}

export function resolveRenderStyle(specs: DesignSpecifications): RenderStyle {
  return isStyleSnapshot(specs.style) ? snapshotRenderStyle(specs, specs.style) : legacyRenderStyle(specs);
}

// ------------------------------------------------------------------------------------------------
// Layout geometry
// ------------------------------------------------------------------------------------------------

export interface LayoutStyle {
  safeMargin: number;
  imageGap: number;
  sectionGap: number;
  minSlotSize: number;
  punchlineRatio: number;
  defaultHeaderRatio: number | null;
}

/** Layout geometry of a meme's snapshot; undefined for older memes (the layout engine's original values). */
export function layoutStyleFromDesign(specs: DesignSpecifications | undefined): LayoutStyle | undefined {
  const s = specs?.style;
  if (!isStyleSnapshot(s)) return undefined;
  return {
    safeMargin: s.canvas.safeMargin,
    imageGap: s.canvas.imageGap,
    sectionGap: s.canvas.sectionGap,
    minSlotSize: s.canvas.minSlotSize,
    punchlineRatio: s.canvas.punchlineRatio,
    defaultHeaderRatio: s.canvas.headerRatio
  };
}
