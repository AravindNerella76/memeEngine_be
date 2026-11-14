/**
 * Subject identity resolution and image-relevance scoring.
 *
 * Design rules (see tests in src/tests/identity-matching.test.ts and identity-v2.test.ts):
 *  1. Names are matched as WHOLE PHRASES on word boundaries, never as substrings or single tokens.
 *  2. Only a canonical/professional name or a VERIFIED alias resolves to a known person.
 *  3. Bare names that many people share (e.g. "Vijay", "Pawan", "Boss") are AMBIGUOUS. They are
 *     never mapped to a "default star". They resolve only when the reference context contains
 *     explicit evidence (the person's full name, a verified alias, or a specific film/party cue).
 *  4. Compound names that are not verified (e.g. "Vijay Deverakonda") never map to a known person.
 *     They are searched literally and verified literally.
 *  5. Image candidates are SCORED (full name > verified alias > ambiguous name + cue) and
 *     penalised when they name a commonly confused person.
 *  6. Common spelling variants (doubled letters, w/v, aspirated consonants) are matched through a
 *     conservative spelling fold applied to BOTH sides of every comparison.
 *  7. Film character names map to the actor only through the verified character table, and names
 *     that also mean real people or deities require the film to be named in the reference.
 *
 * The data lives in src/identity/identity-registry.data.ts.
 */
import {
  CHARACTER_ENTRIES,
  CharacterEntry,
  KNOWN_SUBJECT_ENTITIES,
  KnownSubjectEntry
} from '../identity/identity-registry.data';

export type IdentityStatus = 'resolved' | 'ambiguous' | 'unknown';
export type IdentityMatchType =
  | 'canonical'
  | 'verified_alias'
  | 'context_evidence'
  | 'character_mapping'
  | 'ai_identification'
  | 'literal';

export interface AmbiguityInfo {
  input: string;
  candidates: string[];   // known people this name could refer to
  alsoUsedBy: string[];   // other well-known people sharing the name (from collision lists)
  reason: string;
}

export interface SubjectProfile {
  canonicalName: string;
  professionalName: string;
  aliases: string[];              // VERIFIED aliases only
  searchQueries: string[];
  verificationTokens: string[];   // informational: for unknown subjects these are the required name words
  isKnownEntity: boolean;
  category?: 'actor' | 'politician' | 'deity' | 'producer' | 'director' | 'general';

  status: IdentityStatus;
  matchType?: IdentityMatchType;
  ambiguity?: AmbiguityInfo;
  /** Set when the name was a film character mapped to this actor. */
  character?: { name: string; film: string };
}

export type { KnownSubjectEntry, CharacterEntry };

// ---------------------------------------------------------------------------------------------
// Normalisation and phrase matching primitives
// ---------------------------------------------------------------------------------------------

/** Lower-cases, strips Latin diacritics, zero-width joiners and punctuation, and splits into whole-word tokens. */
export function normalizeForMatch(text: string): string[] {
  return (text || '')
    .replace(/[​-‍⁠﻿]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Conservative spelling fold for romanised Indian names (applied to both sides of every match):
 * w->v, doubled letters collapsed, aa/ee/ii/oo/uu shortened, aspirates th/dh/bh/kh/gh/sh dropped to
 * the plain consonant. Vowel changes (e/a, final y/i) are NOT folded: they can separate different
 * names (e.g. "Thalapathy" the alias vs "Thalapathi" the 1991 film).
 */
export function foldToken(t: string): string {
  if (!/^[a-z0-9]+$/.test(t)) return t;
  let s = t.replace(/w/g, 'v');
  s = s.replace(/ee/g, 'i').replace(/oo/g, 'u');
  s = s.replace(/([a-z])\1+/g, '$1');
  s = s.replace(/th/g, 't').replace(/dh/g, 'd').replace(/bh/g, 'b').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/sh/g, 's');
  return s;
}

/** Normalised AND folded tokens: the form used for every comparison. */
export function matchTokens(text: string): string[] {
  return normalizeForMatch(text).map(foldToken);
}

const HONORIFICS = new Set(['garu', 'shri', 'sri', 'shree', 'mr', 'mrs', 'ms', 'dr', 'sir', 'hon', 'honourable', 'anna'].map(foldToken));
const GENERIC_NAME_WORDS = new Set(['entity', 'person', 'actor', 'image', 'photo', 'unknown', 'random'].map(foldToken));

interface Span { start: number; end: number; }

function findSpans(tokens: string[], phrase: string[]): Span[] {
  const spans: Span[] = [];
  if (phrase.length === 0 || phrase.length > tokens.length) return spans;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) { ok = false; break; }
    }
    if (ok) spans.push({ start: i, end: i + phrase.length });
  }
  return spans;
}

function containsSpan(outer: Span, inner: Span): boolean {
  const outerLen = outer.end - outer.start;
  const innerLen = inner.end - inner.start;
  return outerLen > innerLen && outer.start <= inner.start && outer.end >= inner.end;
}

function titleCase(phrase: string): string {
  return phrase.replace(/\b\p{L}/gu, c => c.toUpperCase());
}

function stripHonorifics(tokens: string[]): string[] {
  let s = 0;
  let e = tokens.length;
  while (e - s > 1 && HONORIFICS.has(tokens[s])) s++;
  while (e - s > 1 && HONORIFICS.has(tokens[e - 1])) e--;
  return tokens.slice(s, e);
}

interface IndexedEntry {
  entry: KnownSubjectEntry;
  strong: string[][];        // canonical + professional names
  alias: string[][];         // verified aliases
  ambiguous: string[][];     // bare / shared names
  cues: string[][];
  collisions: string[][];
  corroboration: string[][];
}

const tokenizeAll = (items: string[]): string[][] =>
  items.map(matchTokens).filter(t => t.length > 0);

const INDEX: IndexedEntry[] = KNOWN_SUBJECT_ENTITIES.map(entry => ({
  entry,
  strong: tokenizeAll([entry.canonicalName, entry.professionalName]),
  alias: tokenizeAll(entry.aliases),
  ambiguous: tokenizeAll(entry.ambiguousAliases),
  cues: tokenizeAll(entry.contextCues),
  collisions: tokenizeAll(entry.collisions),
  corroboration: tokenizeAll(entry.corroboration || [])
}));

const INDEX_BY_CANONICAL = new Map<string, IndexedEntry>(INDEX.map(ix => [ix.entry.canonicalName, ix]));

const EXACT_MAP = new Map<string, { ix: IndexedEntry; type: IdentityMatchType }>();
const AMBIGUOUS_MAP = new Map<string, IndexedEntry[]>();
for (const ix of INDEX) {
  for (const p of ix.strong) EXACT_MAP.set(p.join(' '), { ix, type: 'canonical' });
  for (const p of ix.alias) {
    const key = p.join(' ');
    if (!EXACT_MAP.has(key)) EXACT_MAP.set(key, { ix, type: 'verified_alias' });
  }
  for (const p of ix.ambiguous) {
    const key = p.join(' ');
    const list = AMBIGUOUS_MAP.get(key) || [];
    list.push(ix);
    AMBIGUOUS_MAP.set(key, list);
  }
}

interface IndexedCharacter {
  entry: CharacterEntry;
  noContext: string[][];
  withContext: string[][];
  films: string[][];
}

const CHARACTER_INDEX: IndexedCharacter[] = CHARACTER_ENTRIES.map(entry => ({
  entry,
  noContext: tokenizeAll(entry.aliasesNoContext),
  withContext: tokenizeAll(entry.aliasesWithFilmContext),
  films: tokenizeAll(entry.filmAliases)
}));

/** Looks up a registry entry by canonical name (for query planning and reporting). */
export function getKnownEntity(canonicalName: string): KnownSubjectEntry | undefined {
  return INDEX_BY_CANONICAL.get(canonicalName)?.entry;
}

/** All known people (read-only view, for tests and tooling). */
export function listKnownEntities(): readonly KnownSubjectEntry[] {
  return KNOWN_SUBJECT_ENTITIES;
}

export function listCharacters(): readonly CharacterEntry[] {
  return CHARACTER_ENTRIES;
}

/** Data self-check, exercised by the tests: returns human-readable problems in the alias tables. */
export function validateAliasTables(): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const ix of INDEX) {
    const verified = [...ix.strong, ...ix.alias].map(p => p.join(' '));
    for (const key of verified) {
      const owner = seen.get(key);
      if (owner && owner !== ix.entry.canonicalName) {
        problems.push(`"${key}" is a verified name of both ${owner} and ${ix.entry.canonicalName}`);
      }
      seen.set(key, ix.entry.canonicalName);
      if (AMBIGUOUS_MAP.has(key)) problems.push(`"${key}" is both verified and ambiguous`);
    }
    for (const c of ix.collisions) {
      if (verified.includes(c.join(' '))) {
        problems.push(`${ix.entry.canonicalName}: collision "${c.join(' ')}" equals one of its own verified names`);
      }
    }
  }
  for (const ch of CHARACTER_INDEX) {
    if (!INDEX_BY_CANONICAL.has(ch.entry.actor)) problems.push(`character "${ch.entry.character}": unknown actor "${ch.entry.actor}"`);
    for (const p of [...ch.noContext, ...ch.withContext]) {
      const owner = seen.get(p.join(' '));
      if (owner && owner !== ch.entry.actor) problems.push(`character alias "${p.join(' ')}" is a verified name of ${owner}`);
    }
    if (ch.films.length === 0) problems.push(`character "${ch.entry.character}": no film aliases`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------------------------

function profileFromEntry(ix: IndexedEntry, matchType: IdentityMatchType): SubjectProfile {
  const e = ix.entry;
  return {
    canonicalName: e.canonicalName,
    professionalName: e.professionalName,
    aliases: [...e.aliases],
    searchQueries: [...e.searchQueries],
    verificationTokens: Array.from(new Set(ix.strong.flat())),
    isKnownEntity: true,
    category: e.category,
    status: 'resolved',
    matchType
  };
}

function literalProfile(raw: string, tokens: string[]): SubjectProfile {
  const clean = raw.trim().replace(/\s+/g, ' ');
  const stripped = stripHonorifics(tokens);
  let required = stripped.filter(t => t.length >= 2 && !GENERIC_NAME_WORDS.has(t));
  if (required.length === 0) required = tokens.filter(t => !GENERIC_NAME_WORDS.has(t));
  return {
    canonicalName: clean,
    professionalName: clean,
    aliases: [],
    searchQueries: clean ? [clean] : [],
    verificationTokens: required,
    isKnownEntity: false,
    category: 'general',
    status: 'unknown',
    matchType: 'literal'
  };
}

interface ContextEvidence { score: number; hits: string[]; conflict: boolean; }

function evaluateContextEvidence(ix: IndexedEntry, ctxTokens: string[]): ContextEvidence {
  let score = 0;
  const hits: string[] = [];
  const positive: Span[] = [];

  for (const p of [...ix.strong, ...ix.alias]) {
    const spans = findSpans(ctxTokens, p);
    if (spans.length) { score += 3; hits.push(`name "${p.join(' ')}"`); positive.push(...spans); }
  }
  for (const p of ix.cues) {
    const spans = findSpans(ctxTokens, p);
    if (spans.length) { score += 1; hits.push(`cue "${p.join(' ')}"`); positive.push(...spans); }
  }

  let conflict = false;
  for (const p of ix.collisions) {
    for (const span of findSpans(ctxTokens, p)) {
      if (!positive.some(pos => containsSpan(pos, span))) conflict = true;
    }
  }
  return { score, hits, conflict };
}

/**
 * Maps a film character name to the actor (verified character table only).
 * `filmEvidence` should be reference text OTHER than the name itself (headline, other labels, the
 * analysed movie title), so that a name cannot be its own evidence.
 */
export function resolveCharacterName(name: string, filmEvidence?: string): SubjectProfile | null {
  const tokens = matchTokens(name);
  if (tokens.length === 0) return null;
  const key = tokens.join(' ');
  const evidence = matchTokens(filmEvidence || '');
  for (const ch of CHARACTER_INDEX) {
    const unique = ch.noContext.some(p => p.join(' ') === key);
    const needsFilm = ch.withContext.some(p => p.join(' ') === key);
    if (!unique && !needsFilm) continue;
    if (needsFilm && !unique && !ch.films.some(f => findSpans(evidence, f).length > 0)) continue;
    const actor = INDEX_BY_CANONICAL.get(ch.entry.actor);
    if (!actor) continue;
    return { ...profileFromEntry(actor, 'character_mapping'), character: { name: ch.entry.character, film: ch.entry.film } };
  }
  return null;
}

/**
 * Resolves a raw subject name from the vision analysis to a verified identity.
 * Never guesses: an ambiguous name stays ambiguous unless the context gives explicit evidence.
 */
export function resolveSubjectIdentity(rawSubject: string, context?: string): SubjectProfile {
  const raw = (rawSubject || '').trim();
  const tokens = matchTokens(raw);
  if (tokens.length === 0) return literalProfile(raw, tokens);

  const stripped = stripHonorifics(tokens);
  const keys = Array.from(new Set([tokens.join(' '), stripped.join(' ')]));

  // 1. Exact canonical / professional / verified-alias phrase
  for (const key of keys) {
    const hit = EXACT_MAP.get(key);
    if (hit) return profileFromEntry(hit.ix, hit.type);
  }

  // 2. Ambiguous bare name: resolve only with explicit context evidence
  for (const key of keys) {
    const candidates = AMBIGUOUS_MAP.get(key);
    if (!candidates) continue;

    const ctxTokens = matchTokens(context || '');
    const evaluated = candidates.map(ix => ({ ix, ev: evaluateContextEvidence(ix, ctxTokens) }));
    const supported = evaluated.filter(x => x.ev.score > 0);
    const alsoUsedBy = Array.from(new Set(candidates.flatMap(ix => ix.entry.collisions)))
      .slice(0, 4)
      .map(titleCase);
    const candidateNames = candidates.map(ix => ix.entry.canonicalName);

    if (supported.length === 1 && !supported[0].ev.conflict) {
      return profileFromEntry(supported[0].ix, 'context_evidence');
    }

    let reason: string;
    if (supported.length > 1) {
      reason = `the context points to more than one person (${supported.map(s => s.ix.entry.canonicalName).join(', ')})`;
    } else if (supported.length === 1) {
      reason = `the context also mentions a commonly confused name, so the evidence conflicts`;
    } else {
      reason = 'the reference context has no verified evidence (full name, verified alias, or a film/party name)';
    }
    return {
      canonicalName: raw,
      professionalName: raw,
      aliases: [],
      searchQueries: [],
      verificationTokens: [],
      isKnownEntity: false,
      category: 'general',
      status: 'ambiguous',
      ambiguity: { input: raw, candidates: candidateNames, alsoUsedBy, reason }
    };
  }

  // 3. Verified film character (unique names always; shared names only with the film in context)
  const character = resolveCharacterName(raw, context);
  if (character) return character;

  // 4. Anything else (including compound names such as "Vijay Deverakonda") is matched literally
  return literalProfile(raw, tokens);
}

export function formatAmbiguityMessage(profile: SubjectProfile): string {
  const a = profile.ambiguity;
  if (!a) return `Subject "${profile.canonicalName}" is ambiguous.`;
  const others = a.alsoUsedBy.length ? ` (the name is also used by: ${a.alsoUsedBy.join(', ')})` : '';
  return (
    `Subject "${a.input}" is ambiguous and was not guessed. It could refer to: ${a.candidates.join(', ')}${others}. ` +
    `Reason: ${a.reason}. ` +
    `Use a reference that shows the full name or a verified alias, or whose headline names the film/party, so the person can be identified safely.`
  );
}

/** True if the text names one of the person's commonly confused look-alikes (whole phrase). */
export function textNamesCollision(canonicalName: string, text: string): string | null {
  const ix = INDEX_BY_CANONICAL.get(canonicalName);
  if (!ix) return null;
  const tokens = matchTokens(text);
  const own = [...ix.strong, ...ix.alias].flatMap(p => findSpans(tokens, p));
  for (const c of ix.collisions) {
    for (const span of findSpans(tokens, c)) {
      if (!own.some(o => containsSpan(o, span))) return c.join(' ');
    }
  }
  return null;
}

/** Tokens shared between a free-text name and a known person's verified names (folded). */
export function sharedNameTokens(canonicalName: string, text: string): string[] {
  const ix = INDEX_BY_CANONICAL.get(canonicalName);
  const tokens = new Set(matchTokens(text));
  if (!ix) return [];
  const names = new Set([...ix.strong, ...ix.alias, ...ix.ambiguous].flat());
  return Array.from(tokens).filter(t => names.has(t) && !HONORIFICS.has(t));
}

// ---------------------------------------------------------------------------------------------
// Image relevance scoring
// ---------------------------------------------------------------------------------------------

export const RELEVANCE_ACCEPT_THRESHOLD = 70;

export interface RelevanceInput {
  title?: string;
  sourceUrl?: string;
  description?: string;
}

export interface RelevanceResult {
  score: number;
  accepted: boolean;
  reasons: string[];
}

interface TextField { name: string; tokens: string[]; weight: number; }

function filenameTokens(url?: string): string[] {
  if (!url) return [];
  let p = url;
  try { p = new URL(url).pathname; } catch { /* keep raw */ }
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  const last = p.split('/').filter(Boolean).pop() || '';
  return matchTokens(last.replace(/\.[a-z0-9]{2,5}$/i, ''));
}

function candidateFields(c: RelevanceInput): TextField[] {
  const fields: TextField[] = [{ name: 'title', tokens: matchTokens(c.title || ''), weight: 1 }];
  const fn = filenameTokens(c.sourceUrl);
  if (fn.length) fields.push({ name: 'filename', tokens: fn, weight: 0.9 });
  if (c.description) fields.push({ name: 'description', tokens: matchTokens(c.description), weight: 0.8 });
  return fields.filter(f => f.tokens.length > 0);
}

function anyPhrase(tokens: string[], phrases: string[][]): { phrase: string[]; span: Span }[] {
  const out: { phrase: string[]; span: Span }[] = [];
  for (const p of phrases) for (const span of findSpans(tokens, p)) out.push({ phrase: p, span });
  return out;
}

function scoreKnownEntity(fields: TextField[], ix: IndexedEntry): RelevanceResult {
  let best = -1;
  let bestReason = '';
  const ownPositive: { fieldName: string; span: Span }[] = [];

  for (const f of fields) {
    const strong = anyPhrase(f.tokens, ix.strong);
    const alias = anyPhrase(f.tokens, ix.alias);
    const amb = anyPhrase(f.tokens, ix.ambiguous);
    const cues = anyPhrase(f.tokens, ix.cues);
    const corro = anyPhrase(f.tokens, ix.corroboration);

    [...strong, ...alias, ...amb].forEach(h => ownPositive.push({ fieldName: f.name, span: h.span }));

    let s = 0;
    let reason = '';
    if (strong.length) {
      const needsCorro = ix.entry.requiresCorroboration && strong.every(h => h.phrase.length === 1);
      if (needsCorro && corro.length === 0 && cues.length === 0) {
        s = 60;
        reason = `single-word name "${strong[0].phrase.join(' ')}" without corroboration`;
      } else {
        s = 100;
        reason = `full name "${strong[0].phrase.join(' ')}"`;
      }
    }
    if (alias.length && s < 85) {
      s = 85;
      reason = `verified alias "${alias[0].phrase.join(' ')}"`;
    }
    if (amb.length && cues.length && s < 70) {
      s = 70;
      reason = `ambiguous name "${amb[0].phrase.join(' ')}" + context cue "${cues[0].phrase.join(' ')}"`;
    }
    if (s === 0 && amb.length) {
      reason = `only the ambiguous name "${amb[0].phrase.join(' ')}"`;
    }

    const weighted = Math.round(s * f.weight);
    if (weighted > best) {
      best = weighted;
      bestReason = `${f.name}: ${reason || 'no name evidence'}`;
    }
  }

  best = Math.max(best, 0);
  const reasons: string[] = [bestReason || 'no name evidence'];
  let penalty = 0;

  // Commonly confused people / things named in the same text
  for (const f of fields) {
    const own = ownPositive.filter(o => o.fieldName === f.name).map(o => o.span);
    for (const hit of anyPhrase(f.tokens, ix.collisions)) {
      if (!own.some(o => containsSpan(o, hit.span))) {
        penalty += 60;
        reasons.push(`${f.name}: commonly confused name "${hit.phrase.join(' ')}"`);
        break;
      }
    }
  }

  // Another known person's full name in the text means the image is of someone else or a group
  for (const other of INDEX) {
    if (other === ix) continue;
    for (const f of fields) {
      const own = ownPositive.filter(o => o.fieldName === f.name).map(o => o.span);
      const hits = anyPhrase(f.tokens, other.strong).filter(h => !own.some(o => containsSpan(o, h.span)));
      if (hits.length) {
        penalty += 35;
        reasons.push(`${f.name}: also names ${other.entry.canonicalName}`);
        break;
      }
    }
  }

  const score = Math.max(0, best - penalty);
  return { score, accepted: score >= RELEVANCE_ACCEPT_THRESHOLD, reasons };
}

function scoreLiteralName(fields: TextField[], required: string[]): RelevanceResult {
  if (required.length === 0) return { score: 0, accepted: false, reasons: ['no name words to verify'] };
  let best = 0;
  let reason = 'no name words found';

  for (const f of fields) {
    const present = required.filter(t => f.tokens.includes(t));
    let s = 0;
    let r = '';
    if (present.length === required.length) {
      const contiguous = findSpans(f.tokens, required).length > 0;
      if (required.length === 1) {
        s = 80;
        r = `single name word "${required[0]}" (weak identity)`;
      } else {
        s = contiguous ? 100 : 85;
        r = contiguous ? `full name "${required.join(' ')}"` : `all name words present (${required.join(', ')})`;
      }
    } else if (present.length > 0) {
      s = Math.floor(60 * present.length / required.length);
      r = `only ${present.length}/${required.length} name words (${present.join(', ')})`;
    }
    const weighted = Math.round(s * f.weight);
    if (weighted > best) { best = weighted; reason = `${f.name}: ${r}`; }
  }
  return { score: best, accepted: best >= RELEVANCE_ACCEPT_THRESHOLD, reasons: [reason] };
}

/** Scores how strongly an image candidate's text identifies the resolved subject. */
export function scoreSubjectRelevance(candidate: RelevanceInput, profile: SubjectProfile): RelevanceResult {
  if (profile.status === 'ambiguous') {
    return { score: 0, accepted: false, reasons: ['subject identity is ambiguous'] };
  }
  const fields = candidateFields(candidate);
  if (fields.length === 0) return { score: 0, accepted: false, reasons: ['candidate has no text to verify'] };

  if (profile.isKnownEntity) {
    const ix = INDEX_BY_CANONICAL.get(profile.canonicalName);
    if (ix) return scoreKnownEntity(fields, ix);
  }
  return scoreLiteralName(fields, profile.verificationTokens);
}

// ---------------------------------------------------------------------------------------------
// Search queries (legacy helper; the v2 pipeline uses discovery/query-planner.ts)
// ---------------------------------------------------------------------------------------------

function evidenceText(context?: string, label?: string): string {
  return [context, label].filter(v => typeof v === 'string' && v.trim()).join(' ');
}

/**
 * Builds an array of distinct, prioritized search queries combining:
 * 1. Resolved canonical name
 * 2. Professional / official name
 * 3. Exact raw input name
 * 4. Predefined high-yield search queries from the knowledge base
 * 5. Context-aware queries (e.g. subject + movie title or event)
 * Returns [] for an ambiguous subject: nothing should be searched until the identity is safe.
 */
export function buildSubjectSearchQueries(
  rawSubject: string,
  context?: string,
  label?: string
): string[] {
  const profile = resolveSubjectIdentity(rawSubject, evidenceText(context, label));
  if (profile.status === 'ambiguous') return [];
  const queries = new Set<string>();

  queries.add(profile.canonicalName);

  if (profile.professionalName && profile.professionalName !== profile.canonicalName) {
    queries.add(profile.professionalName);
  }

  if (rawSubject.trim() && rawSubject.trim() !== profile.canonicalName) {
    queries.add(rawSubject.trim());
  }

  profile.searchQueries.forEach(q => queries.add(q));

  if (context && typeof context === 'string') {
    const cleanContext = context
      .replace(/viral|adaptation|meme|report|censor/gi, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim();

    const contextKeywords = cleanContext.split(/\s+/).filter(w => w.length >= 3 && !['movie', 'update', 'news'].includes(w.toLowerCase()));

    if (contextKeywords.length > 0) {
      const topKeyword = contextKeywords[0];
      queries.add(`${profile.canonicalName} ${topKeyword} movie still`);
      queries.add(`${profile.canonicalName} ${topKeyword}`);
    }
  }

  if (label && typeof label === 'string' && label.length > 3) {
    const cleanLabel = label.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (cleanLabel.length > 3 && !cleanLabel.toLowerCase().includes(profile.canonicalName.toLowerCase())) {
      queries.add(`${profile.canonicalName} ${cleanLabel}`);
    }
  }

  return Array.from(queries);
}

/**
 * Informational only (used for logging): the name words that identify this subject.
 * Relevance decisions are made by scoreSubjectRelevance(), not by token membership.
 */
export function getSubjectVerificationTokens(rawSubject: string, profile?: SubjectProfile): string[] {
  const resolved = profile || resolveSubjectIdentity(rawSubject);
  return resolved.verificationTokens;
}
