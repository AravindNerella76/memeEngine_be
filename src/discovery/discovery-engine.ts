/**
 * Provider-independent subject-image discovery for every slot of a meme.
 *
 * Per slot (bounded rounds, bounded time):
 *   1. ground the identity (Wikidata: QID + Commons category) when possible;
 *   2. plan queries (precise -> identity -> broad), search the enabled providers, cache results;
 *   3. rank candidates on metadata; identity below threshold is rejected outright;
 *   4. download ONLY the shortlist (SSRF-safe, size-capped), verify the bytes are a real image,
 *      check resolution for the slot, reject duplicates (sha256 / dHash, also across slots);
 *   5. visually verify the shortlist with the vision model (inconclusive = rejected);
 *   6. select the best verified image; keep the other verified ones as alternates (metadata only).
 * If nothing verifies, the slot fails with an explanation: nothing is ever filled with an
 * unverified or unrelated image.
 *
 * Rights (see rights.ts): every candidate is labelled openly licensed / restricted / copyrighted.
 * The rights policy decides what may be used (default: copyrighted images allowed); rights never
 * change identity, verification, relevance or quality checks.
 *
 * Reference match: the slot's crop from the reference is used for reverse image search (when a
 * provider is configured) and for a picture-hash comparison. Among VERIFIED candidates the exact
 * underlying picture is preferred, then the same scene, and clean pictures before ones with
 * overlaid text or watermarks.
 *
 * Provider terms: results from providers that allow only transient storage (e.g. Brave) are used
 * during the run but their titles and URLs are never written to the meme or the report.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DiscoveryConfig, VisionVerifyMode } from '../config/app-config';
import { ImageValidationError, verifyImageBuffer } from '../security/image-verify';
import { UploadedAsset } from '../types/meme.types';
import { VisionCallMeta } from '../vision/vision-cli.runner';
import { cropRegionToJpeg } from '../vision/vision-image-prep';
import { IDENTITY_MIN, scoreCandidate, urlKey } from './candidate-ranker';
import {
  EvaluatedCandidate,
  GroundedEntity,
  ImageCandidate,
  ImageSearchProvider,
  PlannedQuery,
  QueryRound,
  ReferenceMatchInfo,
  ReferenceMatchLevel,
  SlotDiscoveryPlan,
  SlotDiscoveryReport,
  SlotReportCandidate
} from './discovery.types';
import { dHash, DUPLICATE_HAMMING, hamming, sha256 } from './image-fingerprint';
import { groundSearchTerms, planQueries } from './query-planner';
import { isVisuallyAccepted, VisualVerifier } from './visual-verifier';
import { matchTokens } from '../services/subject-alias-resolver';
import { buildRightsInfo, classifyLicense, RightsInfo, rightsAllowed, WIKIMEDIA_FILE_HOSTS } from './rights';
import type { WikimediaFileRights } from './providers/wikimedia.providers';

export interface EntityGrounder {
  ground(primaryName: string, otherNames: string[], kind: 'person' | 'deity' | 'film' | 'other'): Promise<GroundedEntity | null>;
}

export interface DiscoveryEngineDeps {
  providers: ImageSearchProvider[];
  grounding: EntityGrounder | null;
  verifier: VisualVerifier | null;
  download: (url: string) => Promise<Buffer>;
  config: DiscoveryConfig;
  verifyMode: VisionVerifyMode;
  storageDir: string;
  log?: (msg: string) => void;
  /** Reads the real licence of Wikimedia-hosted files found by web / reverse image search. */
  rightsLookup?: { lookup(imageUrl: string): Promise<WikimediaFileRights | null> } | null;
}

export class SlotDiscoveryError extends Error {
  constructor(message: string, public readonly failedSlotId: string, public readonly reports: SlotDiscoveryReport[], public readonly visionCalls: VisionCallMeta[]) {
    super(message);
    this.name = 'SlotDiscoveryError';
  }
}

export interface DiscoveryRunResult {
  assets: UploadedAsset[];
  reports: SlotDiscoveryReport[];
  visionCalls: VisionCallMeta[];
  warnings: string[];
}

interface DownloadInfo {
  buf: Buffer;
  width: number;
  height: number;
  mime: string;
  ext: string;
  sha256: string;
  dhash: string;
}

const WEB_PROVIDERS = new Set(['duckduckgo', 'google-cse', 'openverse', 'brave-images']);
const WIKIMEDIA_PROVIDERS = new Set(['wikimedia-commons', 'wikipedia']);
const MAX_DOWNLOADS_PER_SLOT = 14;
const MAX_VERIFY_BATCHES_PER_SLOT = 4;
const MIN_IMAGE_SIDE = 250;
const MAX_UPSCALE = 2.5;

/**
 * Per-run limits from the configuration (Settings > Image Discovery / Image Processing), bounded so
 * that no setting can accept smaller or more enlarged images, or download without limit.
 */
export function discoveryLimits(cfg: Partial<DiscoveryConfig>) {
  const n = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    maxDownloads: Math.min(30, Math.max(4, Math.round(n(cfg.maxDownloadsPerSlot, MAX_DOWNLOADS_PER_SLOT)))),
    minSide: Math.max(MIN_IMAGE_SIDE, n(cfg.minImageSide, MIN_IMAGE_SIDE)),
    maxUpscale: Math.min(MAX_UPSCALE, n(cfg.maxUpscale, MAX_UPSCALE)),
    duplicateHamming: Math.min(10, Math.max(4, Math.round(n(cfg.duplicateHamming, DUPLICATE_HAMMING)))),
    visualMinConfidence: Math.max(0.6, n(cfg.visualMinConfidence, 0.6)),
    rejectWatermarked: cfg.watermarkPolicy === 'reject'
  };
}
/** Minimum size (px) of the reference crop for reverse image search. */
const MIN_REVERSE_CROP_SIDE = 100;
/** Picture-hash distance at or below which a candidate counts as the reference's own picture. */
export const REFERENCE_HASH_MATCH = 10;

const MATCH_RANK: Record<ReferenceMatchLevel, number> = { same_picture: 3, same_scene: 2, unknown: 1, different: 0 };

/** How a verified candidate relates to the reference picture (vision verdict, reverse search, picture hash). */
export function referenceMatchOf(ev: EvaluatedCandidate, hasReference: boolean): ReferenceMatchInfo {
  const evidence: string[] = [];
  let level: ReferenceMatchLevel = 'unknown';
  const raise = (l: ReferenceMatchLevel) => {
    if (MATCH_RANK[l] > MATCH_RANK[level]) level = l;
  };
  const vm = ev.visual?.referenceMatch;
  if (vm === 'same_picture' || vm === 'same_scene') {
    raise(vm);
    evidence.push(`vision check: ${vm === 'same_picture' ? 'same picture' : 'same scene'} as the reference`);
  }
  if (ev.candidate.reverseMatch) {
    raise('same_picture');
    evidence.push(`reverse image search: ${ev.candidate.reverseMatch === 'full' ? 'same picture' : 'crop or edit of the same picture'}`);
  }
  if (typeof ev.referenceHashDistance === 'number' && ev.referenceHashDistance <= REFERENCE_HASH_MATCH) {
    raise('same_picture');
    evidence.push(`picture hash distance ${ev.referenceHashDistance} (near-identical picture)`);
  }
  if (vm === 'different' && level === 'unknown') {
    level = 'different';
    evidence.push('vision check: a different picture from the reference');
  }
  if (!evidence.length) evidence.push(hasReference ? 'no evidence either way' : 'no reference picture to compare with');
  return { level, evidence };
}

/** Order of VERIFIED candidates: clean before overlaid text/watermark (except posters), then reference match, then score. */
export function selectionOrder(a: EvaluatedCandidate, b: EvaluatedCandidate, posterSlot: boolean): number {
  const overlaid = (e: EvaluatedCandidate) => (!posterSlot && e.visual?.hasOverlaidText ? 1 : 0);
  const rank = (e: EvaluatedCandidate) => MATCH_RANK[e.referenceMatch?.level || 'unknown'];
  return overlaid(a) - overlaid(b) || rank(b) - rank(a) || (b.finalScore || 0) - (a.finalScore || 0);
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => {
      clearTimeout(t);
      resolve(v);
    }, e => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (e: any) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/** Report entry; titles/URLs of providers that allow only transient storage are left out. */
function reportCandidate(e: EvaluatedCandidate): SlotReportCandidate {
  const c = e.candidate;
  const stored = c.resultStorage !== 'transient';
  return {
    title: stored ? c.title.slice(0, 160) : undefined,
    provider: c.provider,
    sourceUrl: stored ? c.imageUrl : undefined,
    pageUrl: stored ? c.pageUrl : undefined,
    license: c.license,
    attribution: stored ? c.attribution : undefined,
    score: e.finalScore ?? e.score.total,
    reason: e.rejection,
    rights: c.rights?.classification,
    stored
  };
}

/** Rights record of a candidate (from its licence metadata; conservative when there is none). */
export function rightsForCandidate(c: ImageCandidate, providerLabel?: string): RightsInfo {
  const cls = classifyLicense(c.license, { nonFree: c.nonFree });
  const transient = c.resultStorage === 'transient';
  const basis =
    cls.classification === 'copyrighted_unconfirmed'
      ? c.nonFree
        ? 'the source marks this file as non-free'
        : c.licenseKnown
          ? `the source's licence "${String(c.license).slice(0, 60)}" is not an open licence`
          : 'the source gives no licence information'
      : `licence metadata from ${providerLabel || c.provider}`;
  return buildRightsInfo({
    classification: cls,
    license: c.license,
    licenseUrl: c.licenseUrl,
    attribution: transient ? undefined : c.attribution,
    provider: c.provider,
    basis,
    sourceStored: !transient,
    storageNote: transient ? `${providerLabel || c.provider}'s API terms allow only temporary storage of search results, so the source link was not kept` : undefined
  });
}

export class DiscoveryEngine {
  private readonly searchCache = new Map<string, Promise<ImageCandidate[]>>();
  private readonly downloadCache = new Map<string, Promise<DownloadInfo>>();

  constructor(private readonly deps: DiscoveryEngineDeps) {}

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  async run(plans: SlotDiscoveryPlan[], referencePath: string | null): Promise<DiscoveryRunResult> {
    const runDir = path.join(this.deps.storageDir, `.run-${randomUUID()}`);
    fs.mkdirSync(runDir, { recursive: true });
    const reports: SlotDiscoveryReport[] = [];
    const visionCalls: VisionCallMeta[] = [];
    const selected: { slotId: string; plan: SlotDiscoveryPlan; ev: EvaluatedCandidate; info: DownloadInfo; url: string }[] = [];
    try {
      for (const plan of plans) {
        const r = await this.discoverSlot(plan, referencePath, runDir, selected, visionCalls);
        reports.push(r.report);
        if (!r.chosen) {
          throw new SlotDiscoveryError(this.failureMessage(plan, r.report), plan.slotId, reports, visionCalls);
        }
        selected.push({ slotId: plan.slotId, plan, ev: r.chosen.ev, info: r.chosen.info, url: r.chosen.ev.candidate.imageUrl });
      }
      // Commit: write the selected images to permanent storage.
      const assets: UploadedAsset[] = selected.map(({ plan, ev, info }) => {
        const filename = `internet_${randomUUID()}.${info.ext}`;
        const finalPath = path.join(this.deps.storageDir, filename);
        fs.writeFileSync(finalPath, info.buf);
        // Provider terms: a transient-only result's title/URLs are not kept (the picture itself is
        // the website's content, not the search provider's result).
        const stored = ev.candidate.resultStorage !== 'transient';
        return {
          id: randomUUID(),
          originalName: (stored && ev.candidate.title.slice(0, 120)) || `${plan.subjectName}.${info.ext}`,
          filename,
          path: finalPath,
          mimeType: info.mime,
          width: info.width,
          height: info.height,
          aspectRatio: Number((info.width / info.height).toFixed(4)),
          orientation: info.width / info.height > 1.15 ? 'landscape' : info.width / info.height < 0.85 ? 'portrait' : 'square',
          role: plan.index === 0 ? 'subject_primary' : plan.index === 1 ? 'subject_secondary' : 'subject_item',
          orderIndex: plan.index,
          label: plan.label || undefined,
          sourceUrl: stored ? ev.candidate.imageUrl : undefined,
          sourcePage: stored ? ev.candidate.pageUrl : undefined,
          attribution: stored ? ev.candidate.attribution : undefined,
          license: ev.candidate.license,
          sha256: info.sha256,
          focalX: ev.visual?.subjectFocus?.x,
          focalY: ev.visual?.subjectFocus?.y,
          provider: ev.candidate.provider,
          rights: ev.candidate.rights || rightsForCandidate(ev.candidate),
          referenceMatch: ev.referenceMatch?.level,
          sourceType: 'ai_discovery',
          selectedBy: 'ai',
          aiVerified: Boolean(ev.visual && ev.visual.verdict === 'accept')
        } as UploadedAsset;
      });
      return { assets, reports, visionCalls, warnings: reports.flatMap(r => r.warnings.map(w => `${r.slotId}: ${w}`)) };
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  private failureMessage(plan: SlotDiscoveryPlan, report: SlotDiscoveryReport): string {
    const tried = report.queries.map(q => `"${q.query}"`).slice(0, 8).join(', ');
    const best = report.rejected.slice(0, 3).map(r => `${r.title ? `"${r.title}"` : 'a web result'} (${r.provider}): ${r.reason}`).join(' | ');
    const filmOptions = [
      this.deps.providers.some(p => p.id === 'google-vision-web' && p.isEnabled()) ? null : 'add a Google Cloud Vision key for reverse image search of the reference (GOOGLE_CLOUD_VISION_API_KEY)',
      this.deps.providers.some(p => p.id === 'brave-images' && p.isEnabled()) ? null : 'add a Brave Search API key for web image search (BRAVE_SEARCH_API_KEY)',
      'allow a verified photo of the same person instead (DISCOVERY_ALLOW_TYPE_FALLBACK=true)',
      'TMDB film stills only with a written TMDB agreement (its standard terms forbid AI-based and derivative use)'
    ].filter(Boolean);
    return (
      `Could not find a verified ${plan.desiredImageType.replace(/_/g, ' ')} of "${plan.subjectName}"` +
      `${plan.context.movieTitle ? ` from "${plan.context.movieTitle}"` : ''} for slot ${plan.index + 1}. ` +
      `Searched ${report.providersUsed.join(', ') || 'no provider'} with ${tried || 'no queries'}; ` +
      `${report.candidatesConsidered} candidates considered, ${report.visualChecks} visually checked. ` +
      (best ? `Closest candidates and why they were rejected: ${best}. ` : '') +
      `No unverified image was used.` +
      (['movie_still', 'movie_poster', 'screenshot'].includes(plan.desiredImageType)
        ? ` Film stills and posters are rarely available from the free open-licence sources (Wikimedia, Openverse). Options: ${filmOptions.join('; ')}.`
        : '')
    );
  }

  private search(provider: ImageSearchProvider, req: { query: string; mode: 'text' | 'entity' | 'image'; plan: SlotDiscoveryPlan; entity?: GroundedEntity; image?: Buffer }): Promise<ImageCandidate[]> {
    const key = `${provider.id}|${req.mode}|${req.mode === 'image' ? `${req.plan.slotId}:${req.image ? sha256(req.image) : ''}` : matchTokens(req.query).join(' ')}|${req.entity?.qid || ''}|${req.plan.context.movieTitle || ''}`;
    let p = this.searchCache.get(key);
    if (!p) {
      p = withTimeout(provider.search({ ...req, limit: 25 }), this.deps.config.requestTimeoutMs * 2 + 2000, `${provider.id} search`);
      this.searchCache.set(key, p);
      p.catch(() => this.searchCache.delete(key));
    }
    return p;
  }

  private providersFor(q: PlannedQuery, openverseUsed: { used: boolean }, braveBudget: { used: number }): ImageSearchProvider[] {
    return this.deps.providers.filter(p => {
      if (!p.isEnabled() || p.id === 'tmdb' || p.capability === 'image') return false;
      if (p.id === 'brave-images') {
        // paid per request: a small number of the most precise queries per slot
        if (braveBudget.used >= (this.deps.config.braveMaxQueriesPerSlot || 2) || q.intent === 'broad') return false;
        braveBudget.used++;
        return true;
      }
      if (p.id === 'wikipedia') return q.intent === 'identity' || q.intent === 'context';
      if (p.id === 'openverse') {
        if (openverseUsed.used || q.intent !== 'identity') return false; // anonymous quota is tiny: one query per slot
        openverseUsed.used = true;
        return true;
      }
      if (q.intent === 'context' || q.intent === 'ai_suggested') return WEB_PROVIDERS.has(p.id) || p.id === 'wikimedia-commons';
      return true;
    });
  }

  private download(c: ImageCandidate): Promise<DownloadInfo> {
    const key = urlKey(c.imageUrl);
    let p = this.downloadCache.get(key);
    if (!p) {
      p = (async () => {
        const buf = await this.deps.download(c.imageUrl);
        if (buf.length < 12_000) throw new ImageValidationError(`file too small (${buf.length} bytes)`);
        const v = await verifyImageBuffer(buf);
        return { buf, width: v.width, height: v.height, mime: v.mime, ext: v.ext.slice(1), sha256: sha256(buf), dhash: await dHash(buf) };
      })();
      this.downloadCache.set(key, p);
    }
    return p;
  }

  private async discoverSlot(
    plan: SlotDiscoveryPlan,
    referencePath: string | null,
    runDir: string,
    selectedSoFar: { slotId: string; info: DownloadInfo; url: string }[],
    visionCalls: VisionCallMeta[],
    isFallback = false
  ): Promise<{ report: SlotDiscoveryReport; chosen?: { ev: EvaluatedCandidate; info: DownloadInfo } }> {
    const cfg = this.deps.config;
    const limits = discoveryLimits(cfg);
    const started = Date.now();
    const deadline = started + cfg.slotTimeoutMs;
    const report: SlotDiscoveryReport = {
      slotId: plan.slotId,
      subject: plan.subjectName,
      desiredImageType: plan.desiredImageType,
      context: { movieTitle: plan.context.movieTitle, eventName: plan.context.eventName, characterName: plan.context.characterName, evidence: plan.context.evidence },
      queries: [],
      droppedSearchTerms: [],
      providersUsed: [],
      providerErrors: [],
      rounds: 0,
      candidatesConsidered: 0,
      downloads: 0,
      visualChecks: 0,
      alternates: [],
      rejected: [],
      rightsPolicy: cfg.rightsPolicy || 'allow_copyrighted',
      notes: [],
      warnings: [],
      durationMs: 0
    };
    const providersUsed = new Set<string>();
    const pool = new Map<string, EvaluatedCandidate>();
    const downloaded = new Map<string, DownloadInfo>();
    const usedQueries = new Set<string>();
    const openverseUsed = { used: false };
    const braveBudget = { used: 0 };
    let verifyFailures = 0;
    const strictFilm = !isFallback && ['movie_still', 'movie_poster', 'screenshot'].includes(plan.desiredImageType);
    const policy = cfg.rightsPolicy || 'allow_copyrighted';

    // The slot's own picture in the reference: for reverse image search and picture-hash matching.
    // Only the subject slot is cropped (never the reference's reaction panel or punchline).
    let refCrop: { buffer: Buffer; width: number; height: number } | null = null;
    let refHash: string | null = null;
    if (referencePath && plan.referenceBox) {
      try {
        refCrop = await cropRegionToJpeg(referencePath, plan.referenceBox, { maxSide: 1024, minSide: 48 });
        if (refCrop) refHash = await dHash(refCrop.buffer);
      } catch (e: any) {
        report.warnings.push(`could not crop the reference slot: ${String(e.message).slice(0, 100)}`);
      }
    }

    // 1. Identity grounding (structured evidence: Wikidata QID + Commons category)
    let entity: GroundedEntity | undefined;
    const kind = plan.subjectKind === 'person' || plan.subjectKind === 'movie_character' ? 'person' : plan.subjectKind === 'film' ? 'film' : 'other';
    const isDeity = plan.identity.profile?.category === 'deity';
    if (this.deps.grounding && (kind === 'person' || isDeity)) {
      const others = [plan.identity.profile?.professionalName || '', ...(plan.identity.profile?.aliases || [])].filter(a => /^[\x20-\x7E]+$/.test(a));
      try {
        entity = (await withTimeout(this.deps.grounding.ground(plan.subjectName, others, isDeity ? 'deity' : 'person'), cfg.requestTimeoutMs * 2 + 2000, 'Wikidata grounding')) || undefined;
        if (entity) report.entity = entity;
      } catch (e: any) {
        report.warnings.push(`identity grounding unavailable: ${String(e.message).slice(0, 120)}`);
      }
    }

    const addCandidates = (cands: ImageCandidate[], provider?: ImageSearchProvider) => {
      for (const c of cands) {
        const key = urlKey(c.imageUrl);
        if (pool.has(key)) continue;
        if (selectedSoFar.some(s => urlKey(s.url) === key)) continue;
        c.resultStorage = c.resultStorage || provider?.resultStorage || 'full';
        c.rights = rightsForCandidate(c, provider?.label);
        c.licenseFree = c.rights.classification === 'open_license';
        const score = scoreCandidate(c, plan);
        const ev: EvaluatedCandidate = { candidate: c, score, stage: 'metadata' };
        if (score.identity < IDENTITY_MIN) {
          ev.stage = 'rejected';
          ev.rejection = `identity not verified (${score.identity}/100): ${score.notes[0] || ''}`.slice(0, 220);
        } else if (c.width && c.height && (c.width < MIN_IMAGE_SIDE || c.height < MIN_IMAGE_SIDE)) {
          ev.stage = 'rejected';
          ev.rejection = `too small (${c.width}x${c.height})`;
        } else if (!rightsAllowed(policy, c.rights.classification)) {
          ev.stage = 'rejected';
          ev.rejection = `rights policy: only openly licensed images are allowed (DISCOVERY_RIGHTS_POLICY=open_license_only); this one is labelled "${c.rights.label}"`.slice(0, 220);
        }
        pool.set(key, ev);
      }
    };

    for (let round = 1 as QueryRound; round <= cfg.maxRounds && round <= 3; round = (round + 1) as QueryRound) {
      if (Date.now() > deadline) {
        report.warnings.push('slot time budget exhausted');
        break;
      }
      report.rounds = round;
      const queries = planQueries(plan, round, usedQueries);
      if (round === 1) report.droppedSearchTerms = groundSearchTerms(plan).dropped;
      report.queries.push(...queries);

      const tasks: { provider: ImageSearchProvider; run: () => Promise<ImageCandidate[]>; query: string }[] = [];
      if (round === 1 && refCrop && refCrop.width >= MIN_REVERSE_CROP_SIDE && refCrop.height >= MIN_REVERSE_CROP_SIDE) {
        // Reverse image search: the exact underlying picture of the reference, and pages carrying it.
        const crop = refCrop.buffer;
        for (const p of this.deps.providers.filter(p => p.isEnabled() && p.capability === 'image')) {
          tasks.push({ provider: p, query: 'reverse image search of the reference slot', run: () => this.search(p, { query: 'reverse image search', mode: 'image', plan, entity, image: crop }) });
        }
      }
      if (round === 1) {
        for (const p of this.deps.providers.filter(p => p.isEnabled() && p.supportsEntityMode)) {
          if (p.id === 'tmdb' || entity) {
            tasks.push({ provider: p, query: `entity:${entity?.qid || plan.subjectName}`, run: () => this.search(p, { query: `entity:${entity?.qid || plan.subjectName}`, mode: 'entity', plan, entity }) });
          }
        }
      }
      for (const q of queries) {
        for (const p of this.providersFor(q, openverseUsed, braveBudget)) {
          tasks.push({ provider: p, query: q.query, run: () => this.search(p, { query: q.query, mode: 'text', plan, entity }) });
        }
      }
      const settled = await runPool(tasks.map(t => t.run), 4);
      settled.forEach((r, i) => {
        const t = tasks[i];
        providersUsed.add(t.provider.label);
        if (r.status === 'fulfilled') addCandidates(r.value, t.provider);
        else {
          const msg = String(r.reason?.message || r.reason).slice(0, 220);
          report.providerErrors.push({ provider: t.provider.id, query: t.query, error: msg.slice(0, 160) });
          // monthly caps of paid providers are reported once, so they are visible in the report
          if (r.reason?.name === 'ProviderLimitError' && !report.warnings.includes(msg)) report.warnings.push(msg);
        }
      });

      // Shortlist -> download -> verify, a few batches per round (re-evaluates remaining candidates first).
      for (let batch = 0; batch < 2; batch++) {
        if (Date.now() > deadline || report.downloads >= limits.maxDownloads || report.visualChecks >= MAX_VERIFY_BATCHES_PER_SLOT) break;
        // Strict film pass: asking the vision model whether an event photo is a film still wastes
        // a call. Only candidates whose metadata suggests a still/poster, or that name the film, are
        // verified, plus reverse-image matches of the reference's own picture (which is a film still).
        // Reverse-image matches are verified first: the exact underlying picture is preferred.
        const shortlist = Array.from(pool.values())
          .filter(e => e.stage === 'metadata' && (!strictFilm || Boolean(e.candidate.reverseMatch) || e.score.context >= 75 || ['still', 'poster', 'wallpaper'].includes(e.score.inferredType)))
          .sort((a, b) => (b.candidate.reverseMatch ? 1 : 0) - (a.candidate.reverseMatch ? 1 : 0) || b.score.total - a.score.total)
          .slice(0, cfg.shortlistSize);
        if (!shortlist.length) break;

        const ready: EvaluatedCandidate[] = [];
        for (const ev of shortlist) {
          if (report.downloads >= limits.maxDownloads) break;
          report.downloads++;
          try {
            const info = await withTimeout(this.download(ev.candidate), cfg.downloadTimeoutMs + 5000, 'download');
            const upscale = Math.max(plan.targetWidth / info.width, plan.targetHeight / info.height);
            if (info.width < limits.minSide || info.height < limits.minSide || upscale > limits.maxUpscale) {
              throw new Error(`resolution too low for the slot (${info.width}x${info.height}, would be enlarged ${upscale.toFixed(1)}x)`);
            }
            const dupOther = selectedSoFar.find(s => s.info.sha256 === info.sha256 || hamming(s.info.dhash, info.dhash) <= limits.duplicateHamming);
            if (dupOther) throw new Error(`same picture already used in slot ${dupOther.slotId}`);
            const dupHere = Array.from(downloaded.values()).find(d => d.sha256 === info.sha256 || hamming(d.dhash, info.dhash) <= limits.duplicateHamming);
            if (dupHere) throw new Error('duplicate of another candidate for this slot');
            const filePath = path.join(runDir, `${randomUUID()}.${info.ext}`);
            fs.writeFileSync(filePath, info.buf);
            ev.download = { path: filePath, width: info.width, height: info.height, mime: info.mime, sha256: info.sha256, dhash: info.dhash, bytes: info.buf.length };
            if (refHash) ev.referenceHashDistance = hamming(refHash, info.dhash);
            ev.score = scoreCandidate(ev.candidate, plan, { width: info.width, height: info.height });
            ev.stage = 'downloaded';
            downloaded.set(ev.candidate.id, info);
            ready.push(ev);
          } catch (e: any) {
            ev.stage = 'rejected';
            ev.rejection = `${e instanceof ImageValidationError ? 'not a usable image' : 'download/check failed'}: ${String(e.message).slice(0, 160)}`;
          }
        }
        if (!ready.length) continue;

        let accepted: EvaluatedCandidate[] = [];
        if (this.deps.verifyMode === 'off' || !this.deps.verifier) {
          accepted = ready.filter(ev => ev.score.identity >= 85 && ev.score.total >= 55);
          ready.filter(ev => !accepted.includes(ev)).forEach(ev => {
            ev.stage = 'rejected';
            ev.rejection = 'metadata evidence too weak without visual verification';
          });
          if (accepted.length) report.warnings.push('selected WITHOUT visual verification (VISION_VERIFY_CANDIDATES=off)');
        } else {
          report.visualChecks++;
          try {
            const result = await this.deps.verifier.verify(
              plan,
              referencePath,
              ready.map(ev => ({
                id: ev.candidate.id,
                path: ev.download!.path,
                title: ev.candidate.title,
                provider: ev.candidate.provider,
                identityEvidence: ev.candidate.identityEvidence.kind === 'none' ? 'title text only' : `${ev.candidate.identityEvidence.kind} ${ev.candidate.identityEvidence.detail || ''}`
              }))
            );
            visionCalls.push(...result.calls);
            for (const ev of ready) {
              ev.visual = result.verdicts.get(ev.candidate.id);
              const decision = isVisuallyAccepted(ev.visual, plan, cfg.allowImageTypeFallback, limits.visualMinConfidence);
              if (decision.ok && limits.rejectWatermarked && plan.desiredImageType !== 'movie_poster' && ev.visual?.hasOverlaidText) {
                ev.stage = 'rejected';
                ev.rejection = 'visual check: overlaid text or watermark (Settings: watermarked pictures are rejected)';
              } else if (decision.ok) {
                ev.stage = 'verified';
                accepted.push(ev);
              } else {
                ev.stage = 'rejected';
                ev.rejection = `visual check: ${decision.reason}`.slice(0, 240);
              }
            }
          } catch (e: any) {
            verifyFailures++;
            if (e?.calls) visionCalls.push(...e.calls);
            for (const ev of ready) {
              ev.stage = 'rejected';
              ev.rejection = `visual verification failed: ${String(e.message).slice(0, 160)}`;
            }
            report.warnings.push(`visual verification failed: ${String(e.message).slice(0, 160)}`);
            if (verifyFailures >= 2) break;
          }
        }

        if (accepted.length) {
          for (const ev of accepted) {
            const v = ev.visual;
            ev.finalScore = Math.round(0.6 * ev.score.total + 0.4 * (v ? v.suitability * 100 * Math.max(0.5, v.confidence) : ev.score.total));
            ev.referenceMatch = referenceMatchOf(ev, Boolean(refCrop));
          }
          // Among VERIFIED candidates only: clean pictures first, then the exact underlying picture,
          // then the same scene, then the best score. Acceptance rules are not affected.
          const posterSlot = plan.desiredImageType === 'movie_poster';
          accepted.sort((a, b) => selectionOrder(a, b, posterSlot));
          const chosen = accepted[0];
          const info = downloaded.get(chosen.candidate.id)!;
          await this.enrichWikimediaRights(chosen);
          const c = chosen.candidate;
          const stored = c.resultStorage !== 'transient';
          const rights = c.rights || rightsForCandidate(c);
          report.selected = {
            title: stored ? c.title : undefined,
            provider: c.provider,
            sourceUrl: stored ? c.imageUrl : undefined,
            pageUrl: stored ? c.pageUrl : undefined,
            license: c.license,
            licenseFree: rights.classification === 'open_license',
            attribution: stored ? c.attribution : undefined,
            width: info.width,
            height: info.height,
            sha256: info.sha256,
            scores: chosen.score,
            visual: chosen.visual,
            finalScore: chosen.finalScore || chosen.score.total,
            identityEvidence: c.identityEvidence.kind,
            rights,
            referenceMatch: chosen.referenceMatch!
          };
          if (!posterSlot && chosen.visual?.hasOverlaidText) {
            report.warnings.push('the chosen picture may carry overlaid text or a watermark from its source (no clean verified alternative was found)');
          }
          // Alternates are re-downloaded later from their stored URL, so only storable results qualify.
          const others = accepted.slice(1);
          const storable = others.filter(ev => ev.candidate.resultStorage !== 'transient');
          if (storable.length < others.length) {
            report.notes!.push(`${others.length - storable.length} verified alternate(s) were not kept: their search provider's terms allow only temporary storage of results`);
          }
          report.alternates = storable.slice(0, 3).map(ev => ({
            ...reportCandidate(ev),
            sourceUrl: ev.candidate.imageUrl,
            sha256: ev.download!.sha256,
            width: ev.download!.width,
            height: ev.download!.height,
            finalScore: ev.finalScore || ev.score.total,
            focus: ev.visual?.subjectFocus,
            referenceMatch: ev.referenceMatch
          }));
          this.finish(report, pool, providersUsed, started);
          this.log(`slot ${plan.slotId}: selected ${stored ? `"${c.title}" ` : ''}from ${c.provider} (score ${chosen.finalScore}, ${rights.classification}, reference match ${chosen.referenceMatch?.level})`);
          return { report, chosen: { ev: chosen, info } };
        }
        if (verifyFailures >= 2) break;
      }
      if (verifyFailures >= 2) {
        report.warnings.push('stopped: the vision model could not verify candidates (twice)');
        break;
      }
    }
    if (strictFilm) {
      for (const e of pool.values()) {
        if (e.stage === 'metadata') {
          e.stage = 'rejected';
          e.rejection = `not a film still or poster according to its source (${e.score.inferredType}), so it was not used for a ${plan.desiredImageType.replace(/_/g, ' ')} slot`;
        }
      }
    }
    this.finish(report, pool, providersUsed, started);

    // Opt-in fallback (DISCOVERY_ALLOW_TYPE_FALLBACK=true): no verified film still/poster exists, so
    // look for a verified photo of the SAME person instead. Identity rules stay exactly as strict;
    // only the picture type changes, and the report says so.
    const filmType = ['movie_still', 'movie_poster', 'screenshot'].includes(plan.desiredImageType);
    if (!isFallback && filmType && cfg.allowImageTypeFallback && verifyFailures < 2) {
      const fallbackPlan: SlotDiscoveryPlan = {
        ...plan,
        desiredImageType: 'press_photo',
        context: { ...plan.context, movieTitle: null, evidence: 'none' }
      };
      const fb = await this.discoverSlot(fallbackPlan, referencePath, runDir, selectedSoFar, visionCalls, true);
      fb.report.desiredImageType = plan.desiredImageType;
      fb.report.context = report.context;
      fb.report.queries = [...report.queries, ...fb.report.queries];
      fb.report.rejected = [...report.rejected, ...fb.report.rejected].slice(0, 16);
      fb.report.notes = Array.from(new Set([...(report.notes || []), ...(fb.report.notes || [])]));
      fb.report.candidatesConsidered += report.candidatesConsidered;
      fb.report.downloads += report.downloads;
      fb.report.visualChecks += report.visualChecks;
      fb.report.rounds += report.rounds;
      fb.report.durationMs += report.durationMs;
      fb.report.warnings.unshift(
        fb.chosen
          ? `No verified ${plan.desiredImageType.replace(/_/g, ' ')} of ${plan.subjectName}${plan.context.movieTitle ? ` from "${plan.context.movieTitle}"` : ''} was found; a verified photo of the same person was used instead (DISCOVERY_ALLOW_TYPE_FALLBACK=true).`
          : `Fallback to a photo of the same person was tried and also found nothing verifiable.`,
        ...report.warnings
      );
      return fb;
    }
    return { report };
  }

  /**
   * A web or reverse-search result that is a Wikimedia-hosted file: read its real licence from the
   * Commons / Wikipedia API. That data comes from Wikimedia (which allows storing it), so the file
   * and page links from Wikimedia are kept even when the finding provider allows transient use only.
   */
  private async enrichWikimediaRights(ev: EvaluatedCandidate): Promise<void> {
    const c = ev.candidate;
    if (!this.deps.rightsLookup || WIKIMEDIA_PROVIDERS.has(c.provider) || c.provider === 'openverse') return;
    if (!WIKIMEDIA_FILE_HOSTS.has(hostOf(c.imageUrl))) return;
    try {
      const r = await withTimeout(this.deps.rightsLookup.lookup(c.imageUrl), this.deps.config.requestTimeoutMs + 2000, 'licence lookup');
      if (!r) return;
      const cls = classifyLicense(r.license, { nonFree: r.nonFree });
      c.license = r.nonFree ? `Non-free (${r.license || 'fair use'} on Wikipedia; reuse permission not confirmed)` : r.license || c.license;
      c.licenseUrl = r.licenseUrl;
      c.licenseKnown = Boolean(r.license);
      c.nonFree = r.nonFree;
      c.licenseFree = cls.classification === 'open_license';
      if (r.fileUrl) c.imageUrl = r.fileUrl;
      c.pageUrl = r.pageUrl || c.pageUrl;
      c.attribution = r.attribution;
      if (r.title) c.title = r.title;
      c.resultStorage = 'full';
      c.rights = buildRightsInfo({
        classification: cls,
        license: r.license,
        licenseUrl: r.licenseUrl,
        attribution: r.attribution,
        provider: c.provider,
        basis: `licence read from the Wikimedia file page (the file was found by ${c.provider})`,
        sourceStored: true
      });
    } catch {
      // keep the conservative label
    }
  }

  private finish(report: SlotDiscoveryReport, pool: Map<string, EvaluatedCandidate>, providersUsed: Set<string>, started: number) {
    const transient = new Map<string, number>();
    for (const e of pool.values()) if (e.candidate.resultStorage === 'transient') transient.set(e.candidate.provider, (transient.get(e.candidate.provider) || 0) + 1);
    report.notes = (report.notes || []).filter(n => !/were used for this search but not stored/.test(n));
    for (const [prov, n] of transient) {
      report.notes.push(`${n} result(s) from ${prov} were used for this search but not stored (its API terms allow only temporary storage of results)`);
    }
    report.providersUsed = Array.from(providersUsed);
    report.candidatesConsidered = pool.size;
    report.rejected = Array.from(pool.values())
      .filter(e => e.stage === 'rejected')
      .sort((a, b) => (b.download ? 1 : 0) - (a.download ? 1 : 0) || b.score.total - a.score.total)
      .slice(0, 12)
      .map(reportCandidate);
    report.durationMs = Date.now() - started;
  }
}
