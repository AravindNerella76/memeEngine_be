/**
 * Metadata ranking of image candidates (before any download). Every number is explainable and
 * stored in the generation report.
 *
 *   total = 0.40 identity + 0.15 context + 0.15 type + 0.10 resolution + 0.08 aspect
 *         + 0.07 source + 0.05 reference - penalties          (0-100)
 *
 * "reference" rewards reverse-image-search evidence that the candidate is the same picture as the
 * reference slot. Rights (licence) are recorded but never change the ranking: the rights policy
 * decides what may be used, the scores decide what fits best.
 *
 * Identity below RELEVANCE_ACCEPT_THRESHOLD (70) is a hard rejection: an image is never used
 * just because nothing better was found.
 */
import { ReferenceImageType } from '../analysis/reference-analysis.types';
import { getKnownEntity, matchTokens, RELEVANCE_ACCEPT_THRESHOLD, scoreSubjectRelevance, textNamesCollision } from '../services/subject-alias-resolver';
import { listCharacters } from '../services/subject-alias-resolver';
import { ImageCandidate, ScoreBreakdown, SlotDiscoveryPlan } from './discovery.types';

export const IDENTITY_MIN = RELEVANCE_ACCEPT_THRESHOLD;

const has = (re: RegExp, s: string) => re.test(s);

/** Text used for the CONTEXT score (includes context hints; identity uses title/description only). */
function blobOf(c: ImageCandidate): string {
  return [c.title, c.description || '', c.categories.join(' '), c.tags.join(' '), c.mediaTitle || '', (c.contextHints || []).join(' . ')].join(' ').toLowerCase();
}

/** Best guess of the picture type from provider hints and text. */
export function inferCandidateType(c: ImageCandidate, film?: string | null): string {
  const hints = c.typeHints.map(h => h.toLowerCase());
  if (hints.includes('profile')) return 'portrait';
  if (hints.includes('still') || hints.includes('backdrop')) return 'still';
  if (hints.includes('poster')) return 'poster';
  // The TITLE decides first; descriptions/categories only count for explicit phrases. (Live runs
  // showed Commons descriptions such as "screenshot from a YouTube video" on rally photos.)
  const title = `${c.title} ${c.mediaTitle || ''}`.toLowerCase();
  const rest = `${c.description || ''} ${c.categories.join(' ')} ${c.tags.join(' ')}`.toLowerCase();
  if (has(LOGO_RE, title)) return 'logo';
  if (has(/\b(movie still|film still|stills?|scenes?)\b/, title)) return 'still';
  if (has(EVENT_RE, title)) return 'event';
  if (has(/\b(poster|posters|first ?look|title ?look|motion poster)\b/, title)) return 'poster';
  if (has(/\b(trailer|teaser|song|screen ?grab|screenshot|frame)\b/, title)) return 'still';
  if (film && title.includes(` in ${film.toLowerCase()}`)) return 'still';
  if (has(/\bwallpapers?\b/, title)) return 'wallpaper';
  if (has(/\b(crowd|gathering|massive|lakh|sea of)\b/, title)) return 'crowd';
  if (has(/\b(portrait|headshot|official photo|cropped)\b/, title)) return 'portrait';
  if (has(/\b(movie still|film still)\b/, rest)) return 'still';
  if (has(/\b(official poster|film poster|movie poster)\b/, rest)) return 'poster';
  if (has(EVENT_RE, rest)) return 'event';
  return 'unknown';
}

const LOGO_RE = /\b(logo|emblem|icon|symbol|flag of)\b/;
const EVENT_RE = /\b(audio launch|pre[- ]?release|press meet|event|rally|meeting|launch|festival|award|ceremony|premiere|interview|celebration|campaign|conference|visit|inaugurat\w*|darshan|at the|speech|sworn|oath|assembly|summit|surveys?|addressing|roadshow|meets)\b/;

const TYPE_TABLE: Record<string, Record<string, number>> = {
  movie_still: { still: 100, wallpaper: 70, poster: 40, unknown: 50, portrait: 30, event: 15, crowd: 20, logo: 0 },
  screenshot: { still: 90, wallpaper: 60, poster: 40, unknown: 55, portrait: 35, event: 30, crowd: 30, logo: 0 },
  movie_poster: { poster: 100, wallpaper: 75, still: 60, unknown: 50, portrait: 30, event: 15, crowd: 15, logo: 10 },
  portrait: { portrait: 100, event: 80, unknown: 70, still: 60, wallpaper: 55, poster: 40, crowd: 25, logo: 0 },
  press_photo: { portrait: 95, event: 95, unknown: 70, still: 50, wallpaper: 45, poster: 35, crowd: 35, logo: 0 },
  public_event_photo: { event: 100, portrait: 70, crowd: 75, unknown: 65, still: 40, wallpaper: 40, poster: 30, logo: 0 },
  crowd_photo: { crowd: 100, event: 85, unknown: 55, portrait: 20, still: 30, wallpaper: 30, poster: 20, logo: 0 },
  logo: { logo: 100, unknown: 40, poster: 30, portrait: 10, still: 10, event: 10, crowd: 10, wallpaper: 20 },
  illustration: { unknown: 60, poster: 60, wallpaper: 60, still: 50, portrait: 50, event: 40, crowd: 40, logo: 40 },
  other: { unknown: 60, poster: 60, wallpaper: 60, still: 60, portrait: 60, event: 60, crowd: 60, logo: 40 }
};

export function typeScore(desired: ReferenceImageType, inferred: string): number {
  return (TYPE_TABLE[desired] || TYPE_TABLE.other)[inferred] ?? 50;
}

/** Film names that count as a match for the plan's film (the title, and verified short aliases). */
export function filmAliasesFor(plan: SlotDiscoveryPlan): string[][] {
  const film = plan.context.movieTitle;
  if (!film) return [];
  const out = [matchTokens(film)];
  const filmKey = matchTokens(film).join(' ');
  for (const ch of listCharacters()) {
    if (ch.filmAliases.some(a => matchTokens(a).join(' ') === filmKey)) out.push(...ch.filmAliases.map(matchTokens));
  }
  const entity = plan.identity.profile ? getKnownEntity(plan.identity.profile.canonicalName) : undefined;
  for (const cue of entity?.contextCues || []) {
    const cueTokens = matchTokens(cue);
    // a cue counts as the film's short name only when it is part of the film title (e.g. "OG" in "They Call Him OG")
    if (cueTokens.length && cueTokens.every(t => filmKey.split(' ').includes(t))) out.push(cueTokens);
  }
  return out.filter(a => a.length);
}

function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (!phrase.length || phrase.length > tokens.length) return false;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

export function contextScore(c: ImageCandidate, plan: SlotDiscoveryPlan): { score: number; note?: string } {
  const tokens = matchTokens(blobOf(c));
  const filmMatch = filmAliasesFor(plan).some(a => containsPhrase(tokens, a));
  const event = plan.context.eventName ? matchTokens(plan.context.eventName) : [];
  const eventMatch = event.length > 0 && (containsPhrase(tokens, event) || event.filter(t => t.length > 3).every(t => tokens.includes(t)));
  let score = 60;
  let note: string | undefined;
  const filmType = ['movie_still', 'movie_poster', 'screenshot'].includes(plan.desiredImageType);
  if (filmType && plan.context.movieTitle) {
    score = filmMatch ? 100 : 20;
    note = filmMatch ? `mentions the film "${plan.context.movieTitle}"` : `does not mention the film "${plan.context.movieTitle}"`;
  } else if (event.length) {
    score = eventMatch ? 90 : 45;
    note = eventMatch ? `mentions the event "${plan.context.eventName}"` : undefined;
  } else if (plan.context.movieTitle && filmMatch) {
    score = 75;
    note = `mentions "${plan.context.movieTitle}"`;
  }
  const hasContext = Boolean(plan.context.movieTitle || plan.context.eventName);
  if (hasContext && plan.context.evidence === 'world_knowledge') score = Math.round(50 + (score - 50) * 0.5);
  return { score, note };
}

export function resolutionScore(w: number | undefined, h: number | undefined, tw: number, th: number): number {
  if (!w || !h) return 50;
  const upscale = Math.max(tw / w, th / h);
  if (upscale <= 1) return 100;
  if (upscale <= 1.25) return 85;
  if (upscale <= 1.6) return 65;
  if (upscale <= 2.2) return 40;
  return 10;
}

export function aspectScore(w: number | undefined, h: number | undefined, tw: number, th: number): number {
  if (!w || !h) return 60;
  const a = w / h;
  const s = tw / th;
  return Math.round(100 * Math.min(a / s, s / a));
}

const STRUCTURED_IDENTITY: Record<string, number> = {
  depicts_statement: 100,
  commons_category: 95,
  wikipedia_lead_image: 95,
  tmdb_person_profile: 95,
  tmdb_tagged_image: 95,
  // Only assigned when the picture is the reference's own picture AND the reverse search names the
  // subject (two independent signals); see vision-web.provider.ts.
  reverse_image_match: 95
};

export function referenceScore(c: ImageCandidate): number {
  return c.reverseMatch === 'full' ? 100 : c.reverseMatch === 'partial' ? 85 : 50;
}

export function scoreCandidate(c: ImageCandidate, plan: SlotDiscoveryPlan, actual?: { width: number; height: number }): ScoreBreakdown {
  const notes: string[] = [];
  const profile = plan.identity.profile;
  let identity = 0;
  if (profile) {
    const text = scoreSubjectRelevance(
      { title: c.title, sourceUrl: c.imageUrl, description: [c.description, c.categories.join(' . '), c.tags.join(' '), c.mediaTitle].filter(Boolean).join(' . ') },
      profile
    );
    identity = text.score;
    notes.push(`identity(text): ${text.reasons.join('; ')}`);
    const structured = STRUCTURED_IDENTITY[c.identityEvidence.kind];
    if (structured) {
      const collision = profile.isKnownEntity ? textNamesCollision(profile.canonicalName, `${c.title} ${c.description || ''}`) : null;
      const s = collision ? structured - 60 : structured;
      if (s > identity) {
        identity = s;
        notes.push(`identity(structured): ${c.identityEvidence.kind}${c.identityEvidence.detail ? ` (${c.identityEvidence.detail})` : ''}${collision ? `, but names "${collision}"` : ''}`);
      }
    }
  }

  const inferredType = inferCandidateType(c, plan.context.movieTitle);
  const type = typeScore(plan.desiredImageType, inferredType);
  const ctx = contextScore(c, plan);
  if (ctx.note) notes.push(`context: ${ctx.note}`);
  const w = actual?.width ?? c.width;
  const h = actual?.height ?? c.height;
  const resolution = resolutionScore(w, h, plan.targetWidth, plan.targetHeight);
  const aspect = aspectScore(w, h, plan.targetWidth, plan.targetHeight);
  const source = Math.round(c.providerReliability * 100);
  const license = c.licenseFree ? 100 : c.licenseKnown ? 60 : 35; // informational only
  const reference = referenceScore(c);
  if (c.reverseMatch) notes.push(`reference: reverse image search found ${c.reverseMatch === 'full' ? 'the same picture' : 'a crop or edit of the same picture'}`);

  let penalties = 0;
  const text = `${c.title} ${c.description || ''} ${c.pageUrl || ''}`.toLowerCase();
  if (w && h && (w < 300 || h < 300)) {
    penalties += 40;
    notes.push(`penalty: very small (${w}x${h})`);
  }
  if (/\b(meme|memes|collage|edit|edited|fan ?made|fanart|troll|trolls|template|whatsapp status)\b/.test(text)) {
    penalties += 25;
    notes.push('penalty: meme/edit/collage wording');
  }
  if (/(shutterstock|alamy|gettyimages|dreamstime|istockphoto|123rf|depositphotos|bigstock)/.test(text)) {
    penalties += 20;
    notes.push('penalty: watermarked stock preview source');
  }
  if (plan.subjectKind === 'person' && plan.desiredImageType !== 'crowd_photo' && /\b(with|and)\b|&|,\s/.test(c.title.toLowerCase()) && identity < 95) {
    penalties += 10;
    notes.push('penalty: title suggests more than one person');
  }
  if (inferredType === 'logo' && plan.desiredImageType !== 'logo') {
    penalties += 30;
    notes.push('penalty: looks like a logo');
  }

  const total = Math.max(
    0,
    Math.round(0.4 * identity + 0.15 * ctx.score + 0.15 * type + 0.1 * resolution + 0.08 * aspect + 0.07 * source + 0.05 * reference - penalties)
  );
  return { identity, context: ctx.score, type, resolution, aspect, source, license, reference, penalties, total, inferredType, notes };
}

/** Normalised URL key for duplicate detection before download. */
export function urlKey(u: string): string {
  try {
    const x = new URL(u);
    // Wikimedia thumbnails and originals of the same file share the file name
    const m = x.pathname.match(/\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/);
    if ((x.hostname === 'upload.wikimedia.org' || x.hostname === 'thumb.wikimedia.org') && m) return `wm:${decodeURIComponent(m[1]).toLowerCase()}`;
    return `${x.hostname}${x.pathname}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function sameSubjectWords(a: string, b: string): boolean {
  return matchTokens(a).join(' ') === matchTokens(b).join(' ');
}
