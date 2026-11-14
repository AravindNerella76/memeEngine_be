/**
 * Search query planning per slot, in rounds:
 *   round 1  precise: subject + film/event/character + requested picture type; grounded AI terms
 *   round 2  identity: canonical, professional and verified alias names (and registry queries)
 *   round 3  broad: label words and remaining grounded terms
 *
 * Grounding: every word of an AI-suggested search term must appear in the reference analysis
 * (its text and per-slot context), in the verified identity data, or in a small list of generic
 * picture words. Terms with other words are dropped (no invented associations).
 */
import { getKnownEntity, matchTokens } from '../services/subject-alias-resolver';
import { PlannedQuery, QueryRound, SlotDiscoveryPlan } from './discovery.types';

const GENERIC_WORDS = [
  'movie', 'film', 'still', 'stills', 'scene', 'scenes', 'poster', 'posters', 'photo', 'photos', 'image', 'images', 'picture',
  'portrait', 'press', 'event', 'events', 'meet', 'launch', 'audio', 'trailer', 'teaser', 'song', 'shooting', 'set', 'hd',
  'closeup', 'close', 'up', 'crowd', 'fans', 'official', 'actor', 'actress', 'politician', 'cinema', 'telugu', 'tamil',
  'hindi', 'indian', 'latest', 'character', 'role', 'look', 'in', 'at', 'the', 'of', 'and', 'with', 'a', 'an', 'for', 'on',
  'from', 'to', 'his', 'her', 'as', 'speech', 'speaking', 'smiling', 'stylish', 'mass', 'action', 'face', 'chief', 'minister',
  'cm', 'deputy', 'leader', 'party', 'public', 'interview', 'stage', 'background', 'wallpaper', 'getup', 'first'
];
const GENERIC = new Set(GENERIC_WORDS.map(w => matchTokens(w)[0]).filter(Boolean));

export function sanitizeQuery(q: string): string {
  return q
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}\s&'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
    .trim();
}

export function buildGroundingVocabulary(plan: SlotDiscoveryPlan): Set<string> {
  const entity = plan.identity.profile ? getKnownEntity(plan.identity.profile.canonicalName) : undefined;
  const parts = [
    plan.groundingText,
    plan.subjectName,
    plan.identity.profile?.professionalName || '',
    ...(plan.identity.profile?.aliases || []),
    plan.context.movieTitle || '',
    plan.context.eventName || '',
    plan.context.otherContext || '',
    plan.context.characterName || '',
    plan.label || '',
    // Names only: the person's OTHER films (registry context cues) must not ground a search term,
    // otherwise an unrelated film could be attached to this meme.
    ...(entity ? [entity.canonicalName, entity.professionalName, ...entity.aliases] : [])
  ];
  const vocab = new Set<string>();
  for (const p of parts) for (const t of matchTokens(p)) vocab.add(t);
  for (const g of GENERIC) vocab.add(g);
  return vocab;
}

/** Returns the AI terms that are fully grounded, and the ones that were dropped. */
export function groundSearchTerms(plan: SlotDiscoveryPlan): { kept: string[]; dropped: string[] } {
  const vocab = buildGroundingVocabulary(plan);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of plan.aiSearchTerms) {
    const q = sanitizeQuery(raw);
    if (!q) continue;
    const tokens = matchTokens(q);
    if (tokens.length && tokens.every(t => vocab.has(t) || /^\d{1,4}$/.test(t))) kept.push(q);
    else dropped.push(q);
  }
  return { kept, dropped };
}

function typeWords(plan: SlotDiscoveryPlan): string {
  switch (plan.desiredImageType) {
    case 'movie_still':
    case 'screenshot':
      return 'movie still';
    case 'movie_poster':
      return 'poster';
    case 'public_event_photo':
      return plan.context.eventName ? '' : 'event';
    case 'crowd_photo':
      return 'crowd';
    case 'portrait':
    case 'press_photo':
      return '';
    default:
      return '';
  }
}

/** Plans the queries of one round (deduplicated against `already`). */
export function planQueries(plan: SlotDiscoveryPlan, round: QueryRound, already: Set<string> = new Set()): PlannedQuery[] {
  const name = plan.subjectName;
  const film = plan.context.movieTitle;
  const event = plan.context.eventName;
  const out: PlannedQuery[] = [];
  const add = (q: string, intent: PlannedQuery['intent']) => {
    const s = sanitizeQuery(q);
    if (!s) return;
    const key = matchTokens(s).join(' ');
    if (!key || already.has(key)) return;
    already.add(key);
    out.push({ query: s, round, intent });
  };

  if (round === 1) {
    const tw = typeWords(plan);
    if (film && ['movie_still', 'movie_poster', 'screenshot'].includes(plan.desiredImageType)) {
      add(`${name} ${film} ${tw}`, 'context');
      add(`${name} ${film}`, 'context');
      if (plan.context.characterName) add(`${plan.context.characterName} ${film}`, 'context');
    }
    if (event) add(`${name} ${event}`, 'context');
    for (const t of groundSearchTerms(plan).kept.slice(0, 2)) add(t, 'ai_suggested');
    add(tw ? `${name} ${tw}` : name, 'identity');
  } else if (round === 2) {
    add(name, 'identity');
    const p = plan.identity.profile;
    if (p?.professionalName && p.professionalName !== name) add(p.professionalName, 'identity');
    const entity = p ? getKnownEntity(p.canonicalName) : undefined;
    for (const q of (entity?.searchQueries || []).slice(0, 3)) add(q, 'identity');
    for (const a of (p?.aliases || []).filter(a => /^[\x20-\x7E]+$/.test(a) && a.split(' ').length >= 2).slice(0, 2)) add(a, 'identity');
    if (film) add(`${name} ${film}`, 'context');
  } else {
    for (const t of groundSearchTerms(plan).kept.slice(2)) add(t, 'ai_suggested');
    if (plan.label) {
      const labelWords = matchTokens(plan.label).filter(t => t.length > 2 && !/^\d+$/.test(t)).slice(0, 4).join(' ');
      if (labelWords) add(`${name} ${labelWords}`, 'broad');
    }
    add(`${name} photo`, 'broad');
    if (film) add(`${film} ${typeWords(plan) || 'movie still'}`, 'broad');
  }
  return out.slice(0, 6);
}
