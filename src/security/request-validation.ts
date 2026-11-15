/**
 * Request validation for every endpoint that accepts client data.
 * Hand-written (no extra dependencies). Every failure is a 400 with a readable message; nothing
 * reaches the database or the filesystem unless its type, size and value have been checked.
 *
 * User text (headline, statement, punchline...) is validated for type and length only: it is
 * never modified, so the exact punchline is preserved.
 */
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import {
  MemeContent,
  UploadedAsset,
  DesignSpecifications,
  LayoutConfiguration,
  SectionRole
} from '../types/meme.types';
import { sanitizeDisplayName } from './path-guard';
import { ReactionFraming, parseReactionFraming } from '../services/reaction-framing';

export const MEME_TYPES = ['facts_collage', 'comparison', 'trending_news', 'movie_update', 'custom'] as const;
export const ARRANGEMENTS = ['auto', 'side_by_side', 'columns_3', 'columns_4', 'grid_2x2', 'stacked_rows', 'single_hero'] as const;
const CANVAS_PRESETS = ['portrait_4_5', 'square_1_1', 'story_9_16'];
const ALIGNMENTS = ['center', 'left', 'right'];
const ROLES: SectionRole[] = ['header', 'subject_primary', 'subject_secondary', 'subject_item', 'reaction_punchline'];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[0-9.\s,%]+\))$/;
const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_ASSETS = 12;
export const MAX_PAYLOAD_JSON_BYTES = 100 * 1024;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Errors {
  readonly list: string[] = [];
  add(msg: string) { if (this.list.length < 10) this.list.push(msg); }
  throwIfAny(): void {
    if (this.list.length) throw new BadRequestException(this.list.join('; '));
  }
}

function str(o: Obj, key: string, max: number, e: Errors, opts: { required?: boolean; label?: string } = {}): string | undefined {
  const label = opts.label || key;
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) e.add(`${label} is required`);
    return undefined;
  }
  if (typeof v !== 'string') { e.add(`${label} must be a string`); return undefined; }
  if (v.includes('\0')) { e.add(`${label} contains invalid characters`); return undefined; }
  if (v.length > max) { e.add(`${label} is too long (max ${max} characters)`); return undefined; }
  return v;
}

function strArray(o: Obj, key: string, maxItems: number, maxLen: number, e: Errors): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) { e.add(`${key} must be an array`); return undefined; }
  if (v.length > maxItems) { e.add(`${key} has too many items (max ${maxItems})`); return undefined; }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || item.includes('\0') || item.length > maxLen) {
      e.add(`${key} items must be strings up to ${maxLen} characters`);
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function num(o: Obj, key: string, min: number, max: number, e: Errors): number | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < min || n > max) { e.add(`${key} must be a number between ${min} and ${max}`); return undefined; }
  return n;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], e: Errors): T | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    e.add(`${key} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return v as T;
}

function color(o: Obj, key: string, e: Errors): string | undefined {
  const v = str(o, key, 60, e);
  if (v === undefined) return undefined;
  if (!COLOR_RE.test(v.trim())) { e.add(`${key} must be a hex colour like #FFE500 or an rgb()/rgba() value`); return undefined; }
  return v.trim();
}

function font(o: Obj, key: string, e: Errors): string | undefined {
  const v = str(o, key, 60, e);
  if (v === undefined) return undefined;
  if (!FONT_RE.test(v)) { e.add(`${key} contains invalid characters`); return undefined; }
  return v;
}

function defined<T extends object>(o: T): T {
  Object.keys(o).forEach(k => (o as Record<string, unknown>)[k] === undefined && delete (o as Record<string, unknown>)[k]);
  return o;
}

// -----------------------------------------------------------------------------------------------

export function validateContent(raw: unknown, e: Errors, requirePunchline = true): MemeContent {
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && !isObj(raw)) e.add('content must be an object');

  const punchline = str(o, 'punchline', 1000, e, { required: requirePunchline, label: 'content.punchline' });
  const headline = str(o, 'headline', 300, e, { label: 'content.headline' });
  const statement = str(o, 'statement', 1500, e, { label: 'content.statement' });
  const topic = str(o, 'topic', 300, e, { label: 'content.topic' });

  return defined({
    // topic is stored metadata (never rendered); default it so a headline-only request does not fail the DB schema
    topic: (topic && topic.trim()) || headline || statement || 'Untitled meme',
    headline,
    subHeadline: str(o, 'subHeadline', 300, e, { label: 'content.subHeadline' }),
    statement,
    supportingText: str(o, 'supportingText', 1500, e, { label: 'content.supportingText' }),
    bulletPoints: strArray(o, 'bulletPoints', 12, 300, e),
    reactionContext: str(o, 'reactionContext', 300, e, { label: 'content.reactionContext' }),
    punchline: punchline as string,
    itemLabels: strArray(o, 'itemLabels', MAX_ASSETS, 300, e)
  }) as MemeContent;
}

/** The optional "how to frame the reaction image" choice (JSON text from a form field, or an object). Undefined when absent. */
export function validateReactionFraming(input: unknown): ReactionFraming | undefined {
  try {
    return parseReactionFraming(input);
  } catch (err: any) {
    throw new BadRequestException(String(err?.message || 'reactionFraming is not valid'));
  }
}

export function validateDesign(raw: unknown, e: Errors): Partial<DesignSpecifications> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) { e.add('design must be an object'); return undefined; }
  return defined({
    fontFamily: font(raw, 'fontFamily', e),
    teluguFontFamily: font(raw, 'teluguFontFamily', e),
    canvasPreset: oneOf(raw, 'canvasPreset', CANVAS_PRESETS, e) as DesignSpecifications['canvasPreset'] | undefined,
    primaryTextColor: color(raw, 'primaryTextColor', e),
    secondaryTextColor: color(raw, 'secondaryTextColor', e),
    headerBgColor: color(raw, 'headerBgColor', e),
    headerTextColor: color(raw, 'headerTextColor', e),
    outlineColor: color(raw, 'outlineColor', e),
    shadowColor: color(raw, 'shadowColor', e),
    outlineThickness: num(raw, 'outlineThickness', 0, 30, e),
    shadowBlur: num(raw, 'shadowBlur', 0, 40, e),
    fontSizeScale: num(raw, 'fontSizeScale', 0.5, 1.6, e),
    textAlignment: oneOf(raw, 'textAlignment', ALIGNMENTS, e) as DesignSpecifications['textAlignment'] | undefined,
    customInstructions: str(raw, 'customInstructions', 500, e, { label: 'design.customInstructions' }),
    reactionFraming: (() => {
      try {
        return parseReactionFraming(raw.reactionFraming);
      } catch (err: any) {
        e.add(`design.${String(err?.message || 'reactionFraming is not valid')}`);
        return undefined;
      }
    })()
  }) as Partial<DesignSpecifications>;
}

export function validateLayout(raw: unknown, e: Errors): Partial<LayoutConfiguration> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) { e.add('layout must be an object'); return undefined; }
  return defined({
    memeType: oneOf(raw, 'memeType', MEME_TYPES, e),
    arrangement: oneOf(raw, 'arrangement', ARRANGEMENTS, e),
    reactionHeightRatio: num(raw, 'reactionHeightRatio', 0.15, 0.6, e),
    headerHeightRatio: num(raw, 'headerHeightRatio', 0, 0.3, e),
    gapSize: num(raw, 'gapSize', 0, 20, e)
  }) as Partial<LayoutConfiguration>;
}

/** Rebuilds an asset from only the fields we accept. `path` is verified later against approved storage. */
function sanitizeAsset(raw: unknown, index: number, kind: 'subject' | 'reaction', e: Errors): UploadedAsset | undefined {
  const label = kind === 'reaction' ? 'assets.reactionImage' : `assets.subjectImages[${index}]`;
  if (!isObj(raw)) { e.add(`${label} must be an object`); return undefined; }
  const p = str(raw, 'path', 1024, e, { required: true, label: `${label}.path` });
  if (p === undefined) return undefined;

  const role = typeof raw.role === 'string' && (ROLES as string[]).includes(raw.role) ? (raw.role as SectionRole) : undefined;
  const orderIndex = typeof raw.orderIndex === 'number' && Number.isInteger(raw.orderIndex) && raw.orderIndex >= 0 && raw.orderIndex < 100
    ? raw.orderIndex : index;
  const sourceUrl = str(raw, 'sourceUrl', 2048, e, { label: `${label}.sourceUrl` });

  return defined({
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : `asset_${kind}_${index}`,
    originalName: sanitizeDisplayName(raw.originalName),
    filename: '',                       // recomputed from the verified path
    path: p,
    mimeType: '',                       // recomputed from the verified file content
    role: kind === 'reaction' ? 'reaction_punchline'
      : (role && role !== 'reaction_punchline' ? role : (index === 0 ? 'subject_primary' : index === 1 ? 'subject_secondary' : 'subject_item')),
    orderIndex,
    label: str(raw, 'label', 300, e, { label: `${label}.label` }),
    sourceUrl: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : undefined,
    attribution: str(raw, 'attribution', 500, e, { label: `${label}.attribution` }),
    license: str(raw, 'license', 200, e, { label: `${label}.license` })
  }) as UploadedAsset;
}

export interface ValidatedGenerateBody {
  content: MemeContent;
  assets: { subjectImages: UploadedAsset[]; reactionImage?: UploadedAsset };
  design?: Partial<DesignSpecifications>;
  layout?: Partial<LayoutConfiguration>;
}

/** POST /generate and /preview (JSON). */
export function validateGenerateBody(body: unknown): ValidatedGenerateBody {
  const e = new Errors();
  if (!isObj(body)) throw new BadRequestException('Request body must be a JSON object');
  if (!isObj(body.assets)) e.add('assets is required');
  if (!isObj(body.content)) e.add('content is required');

  const content = validateContent(body.content, e);
  const design = validateDesign(body.design, e);
  const layout = validateLayout(body.layout, e);

  const subjectImages: UploadedAsset[] = [];
  let reactionImage: UploadedAsset | undefined;
  if (isObj(body.assets)) {
    const subj = body.assets.subjectImages;
    if (subj !== undefined && !Array.isArray(subj)) e.add('assets.subjectImages must be an array');
    if (Array.isArray(subj)) {
      if (subj.length > MAX_ASSETS) e.add(`assets.subjectImages has too many items (max ${MAX_ASSETS})`);
      else subj.forEach((s, i) => { const a = sanitizeAsset(s, i, 'subject', e); if (a) subjectImages.push(a); });
    }
    if (body.assets.reactionImage !== undefined && body.assets.reactionImage !== null) {
      reactionImage = sanitizeAsset(body.assets.reactionImage, 99, 'reaction', e);
    }
  }
  e.throwIfAny();
  return { content, assets: { subjectImages, reactionImage }, design, layout };
}

export interface ValidatedUploadPayload {
  content: MemeContent;
  design?: Partial<DesignSpecifications>;
  layout?: Partial<LayoutConfiguration>;
  subjectLabels: (string | undefined)[];
}

/** The multipart "payload" field of POST /upload-and-generate. */
export function validateUploadPayload(rawPayload: unknown): ValidatedUploadPayload {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    throw new BadRequestException('JSON payload is required with form upload');
  }
  if (Buffer.byteLength(rawPayload) > MAX_PAYLOAD_JSON_BYTES) {
    throw new BadRequestException('Payload is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new BadRequestException('Invalid JSON payload');
  }
  if (!isObj(parsed)) throw new BadRequestException('Payload must be a JSON object');

  const e = new Errors();
  const content = validateContent(parsed.content, e);
  const design = validateDesign(parsed.design, e);
  const layout = validateLayout(parsed.layout, e);
  const labels = isObj(parsed) ? strArray(parsed, 'subjectLabels', MAX_ASSETS, 300, e) : undefined;
  e.throwIfAny();
  return { content, design, layout, subjectLabels: labels || [] };
}

export interface ValidatedViralFields {
  punchline: string;
  reactionContext?: string;
  fontFamily?: string;
  selectedProviders?: string[];
}

/** The three-input viral workflow (plus the optional context tag, font, and enabled search providers). The punchline is only trimmed, never altered. */
export function validateViralFields(input: {
  punchline?: unknown;
  reactionContext?: unknown;
  fontFamily?: unknown;
  selectedProviders?: unknown;
}): ValidatedViralFields {
  const e = new Errors();
  const o: Obj = { punchline: input.punchline, reactionContext: input.reactionContext, fontFamily: input.fontFamily };
  const punchline = str(o, 'punchline', 1000, e, { required: true, label: 'punchline' });
  const reactionContext = str(o, 'reactionContext', 300, e, { label: 'reactionContext' });
  const fontFamily = font(o, 'fontFamily', e);
  if (punchline !== undefined && !punchline.trim()) e.add('punchline is required');

  let selectedProviders: string[] | undefined;
  if (input.selectedProviders !== undefined && input.selectedProviders !== null) {
    let raw: unknown = input.selectedProviders;
    if (typeof raw === 'string') {
      const strVal = raw;
      try {
        raw = JSON.parse(strVal);
      } catch {
        raw = strVal.split(',').map(s => s.trim());
      }
    }
    if (Array.isArray(raw)) {
      const cleaned = raw.map(s => (typeof s === 'string' ? s.trim().toLowerCase() : '')).filter(s => /^[a-z0-9_-]{1,64}$/.test(s));
      if (cleaned.length > 0) {
        selectedProviders = Array.from(new Set(cleaned));
      }
    }
  }

  e.throwIfAny();
  return {
    punchline: (punchline as string).trim(),
    reactionContext: reactionContext?.trim() || undefined,
    fontFamily,
    selectedProviders
  };
}

export interface ValidatedListQuery {
  search?: string;
  type?: string;
  sort?: 'newest' | 'oldest';
}

/** GET /api/memes query string: every value must be a plain string (never an array/object operator). */
export function validateListQuery(q: unknown): ValidatedListQuery {
  const o: Obj = isObj(q) ? q : {};
  const e = new Errors();
  const search = str(o, 'search', 100, e, { label: 'search' });
  const type = oneOf(o, 'type', ['all', ...MEME_TYPES] as const, e);
  const sort = oneOf(o, 'sort', ['newest', 'oldest'] as const, e);
  e.throwIfAny();
  return { search, type, sort };
}

/** Page size limits for the gallery list. */
export const PAGE_DEFAULT = 24;
export const PAGE_MAX = 60;
/** Thumbnail widths the server will make (a fixed set keeps disk use and abuse bounded). */
export const THUMB_WIDTHS = [240, 360, 480, 720] as const;

const intParam = (o: Obj, key: string, min: number, max: number, def: number, e: Errors): number => {
  const raw = o[key];
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) {
    e.add(`${key} must be a whole number`);
    return def;
  }
  const n = parseInt(raw, 10);
  if (n < min || n > max) {
    e.add(`${key} must be between ${min} and ${max}`);
    return def;
  }
  return n;
};

export interface ValidatedPageQuery extends ValidatedListQuery {
  limit: number;
  skip: number;
}

/** GET /api/memes/list: the same filters as the full list, plus paging. */
export function validatePageQuery(q: unknown): ValidatedPageQuery {
  const o: Obj = isObj(q) ? q : {};
  const e = new Errors();
  const search = str(o, 'search', 100, e, { label: 'search' });
  const type = oneOf(o, 'type', ['all', ...MEME_TYPES] as const, e);
  const sort = oneOf(o, 'sort', ['newest', 'oldest'] as const, e);
  const limit = intParam(o, 'limit', 1, PAGE_MAX, PAGE_DEFAULT, e);
  const skip = intParam(o, 'skip', 0, 1_000_000, 0, e);
  e.throwIfAny();
  return { search, type, sort, limit, skip };
}

/** GET /api/memes/:id/thumb?v=<version>&w=<width> */
export function validateThumbQuery(q: unknown): { version?: number; width: number } {
  const o: Obj = isObj(q) ? q : {};
  const e = new Errors();
  const v = o.v === undefined || o.v === '' ? undefined : intParam(o, 'v', 1, 999999, 1, e);
  const width = intParam(o, 'w', 1, 4000, 480, e);
  if (!(THUMB_WIDTHS as readonly number[]).includes(width)) e.add(`w must be one of ${THUMB_WIDTHS.join(', ')}`);
  e.throwIfAny();
  return { version: v, width };
}

export function validateInstruction(v: unknown): string {
  const e = new Errors();
  const s = str({ instruction: v }, 'instruction', 300, e, { required: true, label: 'instruction' });
  if (s !== undefined && !s.trim()) e.add('Regeneration instruction text is required');
  e.throwIfAny();
  return (s as string).trim();
}

/** Version numbers from URLs/queries. */
export function parseVersionNumber(v: unknown): number {
  const s = typeof v === 'string' ? v.trim() : '';
  const n = /^\d{1,6}$/.test(s) ? parseInt(s, 10) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('Valid version number is required');
  return n;
}

/** Escapes a user string for literal use inside a MongoDB $regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Meme IDs are server-generated UUIDs. Anything else is rejected before it reaches a query. */
@Injectable()
export class MemeIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException('Invalid meme id');
    }
    return value;
  }
}

export interface ValidatedViralOverrides {
  draftId?: string;
  overrides?: { slot: number; token: string }[];
}

/**
 * Optional "choose your own pictures" fields of the viral workflow: the id of an earlier analysis and
 * [{ slot, token }] referring to staged (already validated) pictures. Nothing here names a file or URL.
 */
export function validateViralOverrides(input: { draftId?: unknown; slotOverrides?: unknown }): ValidatedViralOverrides {
  const e = new Errors();
  let draftId: string | undefined;
  if (input.draftId !== undefined && input.draftId !== null && input.draftId !== '') {
    if (typeof input.draftId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.draftId)) e.add('draftId is not valid');
    else draftId = input.draftId.toLowerCase();
  }
  let overrides: { slot: number; token: string }[] | undefined;
  if (input.slotOverrides !== undefined && input.slotOverrides !== null && input.slotOverrides !== '') {
    let raw: unknown = input.slotOverrides;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        e.add('slotOverrides must be JSON');
        raw = undefined;
      }
    }
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length > 8) e.add('slotOverrides must be a list of at most 8 items');
      else {
        overrides = [];
        for (const item of raw) {
          const slot = item && typeof item === 'object' ? (item as Record<string, unknown>).slot : undefined;
          const token = item && typeof item === 'object' ? (item as Record<string, unknown>).token : undefined;
          if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > 8 || typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
            e.add('each slot override needs a slot number and a token');
            break;
          }
          overrides.push({ slot, token });
        }
      }
    }
  }
  e.throwIfAny();
  return { draftId, overrides: overrides && overrides.length ? overrides : undefined };
}

// -----------------------------------------------------------------------------------------------
// Reaction library (the owner's own set of reaction pictures, grouped by situation / emotion / subject)
// -----------------------------------------------------------------------------------------------

export const REACTION_PAGE_DEFAULT = 48;
export const REACTION_PAGE_MAX = 120;
export const REACTION_MAX_IDS = 200;
export const REACTION_MAX_TAGS = 12;
// \p{M}: the vowel signs and virama of Telugu (and other scripts) are combining marks, not letters
const CATEGORY_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,39}$/u;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.'-]{0,29}$/u;

/** "  Sad   Funny " -> "sad funny". Letters (any language), digits, space, - and _; 1-40 characters. Null when invalid. */
export function normalizeCategory(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return CATEGORY_RE.test(s) ? s : null;
}

/** Free tags (a person, a situation): trimmed, lower-cased, de-duplicated, at most REACTION_MAX_TAGS. */
export function normalizeTags(v: unknown, e: Errors): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const raw = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!raw) { e.add('tags must be a list'); return undefined; }
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') { e.add('tags must be text'); return undefined; }
    const s = t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!s) continue;
    if (!TAG_RE.test(s)) { e.add(`tag "${s.slice(0, 20)}" has characters that are not allowed (30 letters, digits, space . ' - _ at most)`); return undefined; }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > REACTION_MAX_TAGS) { e.add(`at most ${REACTION_MAX_TAGS} tags`); return undefined; }
  return out;
}

export interface ValidatedReactionQuery {
  category?: string;
  search?: string;
  sort: 'recent' | 'used' | 'newest';
  limit: number;
  skip: number;
}

/** GET /api/reactions?category=&search=&sort=&limit=&skip= */
export function validateReactionQuery(q: unknown): ValidatedReactionQuery {
  const o: Obj = isObj(q) ? q : {};
  const e = new Errors();
  let category: string | undefined;
  const rawCat = str(o, 'category', 60, e, { label: 'category' });
  if (rawCat !== undefined && rawCat !== 'all') {
    const c = normalizeCategory(rawCat);
    if (!c) e.add('category has characters that are not allowed');
    else category = c;
  }
  const search = str(o, 'search', 100, e, { label: 'search' })?.trim() || undefined;
  const sort = oneOf(o, 'sort', ['recent', 'used', 'newest'] as const, e) || 'newest';
  const limit = intParam(o, 'limit', 1, REACTION_PAGE_MAX, REACTION_PAGE_DEFAULT, e);
  const skip = intParam(o, 'skip', 0, 1_000_000, 0, e);
  e.throwIfAny();
  return { category, search, sort, limit, skip };
}

export interface ValidatedReactionPatch {
  category?: string;
  name?: string;
  tags?: string[];
}

/** PATCH /api/reactions/:id */
export function validateReactionPatch(body: unknown): ValidatedReactionPatch {
  const o: Obj = isObj(body) ? body : {};
  const e = new Errors();
  const out: ValidatedReactionPatch = {};
  if (o.category !== undefined) {
    const c = normalizeCategory(o.category);
    if (!c) e.add('category must be 1-40 letters, digits, spaces, - or _');
    else out.category = c;
  }
  if (o.name !== undefined) {
    const n = str(o, 'name', 80, e, { label: 'name' });
    out.name = (n ?? '').replace(/\s+/g, ' ').trim();
  }
  const tags = normalizeTags(o.tags, e);
  if (tags !== undefined) out.tags = tags;
  e.throwIfAny();
  return out;
}

/** POST /api/reactions/bulk  { action: 'move' | 'delete', ids: [...], category? } */
export function validateReactionBulk(body: unknown): { action: 'move' | 'delete'; ids: string[]; category?: string } {
  const o: Obj = isObj(body) ? body : {};
  const e = new Errors();
  const action = oneOf(o, 'action', ['move', 'delete'] as const, e);
  if (!action) e.add('action is required (move or delete)');
  const ids = strArray(o, 'ids', REACTION_MAX_IDS, 40, e);
  if (!ids || !ids.length) e.add('ids is required');
  else if (!ids.every(id => UUID_RE.test(id))) e.add('ids must be reaction image ids');
  let category: string | undefined;
  if (action === 'move') {
    const c = normalizeCategory(o.category);
    if (!c) e.add('category is required to move images');
    else category = c;
  }
  e.throwIfAny();
  return { action: action as 'move' | 'delete', ids: ids as string[], category };
}

export const isReactionId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
