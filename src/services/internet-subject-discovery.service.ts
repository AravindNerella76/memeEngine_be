import { Injectable, BadRequestException, Logger, Optional, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { UploadedAsset } from '../types/meme.types';
import {
  ImageValidationError,
  MAX_UPLOAD_BYTES,
  VerifiedImage,
  verifyImageBuffer
} from '../security/image-verify';
import {
  resolveSubjectIdentity,
  buildSubjectSearchQueries,
  getSubjectVerificationTokens,
  scoreSubjectRelevance,
  formatAmbiguityMessage,
  RELEVANCE_ACCEPT_THRESHOLD,
  SubjectProfile
} from './subject-alias-resolver';
import { getConfig, getEnvConfig } from '../config/app-config';
import { politeFetch } from '../security/polite-fetch';
import { VisionCliRunner } from '../vision/vision-cli.runner';
import { DiscoveryEngine, DiscoveryRunResult, SlotProgressListener, rightsForCandidate } from '../discovery/discovery-engine';
import { rightsAllowed } from '../discovery/rights';
import { ImageCandidate } from '../discovery/discovery.types';
import { SlotDiscoveryPlan, ImageSearchProvider } from '../discovery/discovery.types';
import { AgyVisualVerifier } from '../discovery/visual-verifier';
import { WikidataGrounding, WikimediaRightsLookup } from '../discovery/providers/wikimedia.providers';
import { createProviderSet, describeProviders } from '../discovery/providers';
import { InMemoryProviderUsageStore, ProviderUsageService, UsageGuard } from '../discovery/provider-usage';

export interface InternetImageCandidate {
  title: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  license?: string;
  attribution?: string;
  sourceDomain: string;
  /** Identity relevance score (0-100) assigned by scoreSubjectRelevance(). */
  relevanceScore?: number;
}

@Injectable()
export class InternetSubjectDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(InternetSubjectDiscoveryService.name);
  private readonly storageDir = path.join(__dirname, '..', '..', 'uploads', 'internet-discovered');
  private readonly userAgent = 'MemeAdaptationEngine/2.0 (local meme layout tool; non-commercial)';
  private providers: ImageSearchProvider[] | null = null;
  private guards: UsageGuard[] = [];
  private readonly grounding = new WikidataGrounding();
  private readonly rightsLookup = new WikimediaRightsLookup();

  constructor(@Optional() private readonly runner?: VisionCliRunner, @Optional() private readonly usage?: ProviderUsageService) {
    this.ensureStorageDir();
  }

  async onModuleInit() {
    this.probePaidProviders();
  }

  private probePaidProviders() {
    for (const p of this.getProviders()) {
      if (typeof (p as any).probe === 'function') {
        (p as any).probe().catch((err: any) => {
          this.logger.warn(`Provider probe for ${p.id} failed: ${err?.message || err}`);
        });
      }
    }
  }

  private getProviders(): ImageSearchProvider[] {
    if (!this.providers) {
      // Monthly caps of paid providers are persisted in MongoDB when available.
      const set = createProviderSet(getConfig, undefined, this.usage || new InMemoryProviderUsageStore());
      this.providers = set.providers;
      this.guards = set.guards;
    }
    return this.providers;
  }

  /** Enabled/disabled state of every provider (for the status endpoint and reports). */
  describeProviders() {
    this.probePaidProviders();
    const envEnabled = getEnvConfig().discovery.enabledProviders;
    const effective = getConfig().discovery.enabledProviders;
    return describeProviders(this.getProviders()).map(p => ({
      ...p,
      // allowed by .env but switched off in Settings (as opposed to a missing key or a provider error)
      turnedOffInSettings: envEnabled.includes(p.id) && !effective.includes(p.id)
    }));
  }

  /**
   * "Find another image online": a free-text search through the same enabled providers (and their
   * monthly caps) the discovery uses. Returns candidates only; nothing is downloaded or verified by
   * the AI here, and the user's choice is recorded as the user's own selection.
   */
  async searchForUser(query: string, limit = 16): Promise<{ candidates: ImageCandidate[]; providers: string[]; errors: string[] }> {
    const cfg = getConfig().discovery;
    const providers = this.getProviders().filter(p => p.isEnabled() && (p.capability || 'text') === 'text');
    if (!providers.length) throw new BadRequestException('No image search source is available right now (see Settings > Image Discovery).');
    const plan: any = {
      slotId: 'user-search',
      index: 0,
      identity: { status: 'resolved', searchName: query, profile: undefined, candidates: [], reasons: [], warnings: [] },
      subjectName: query,
      subjectKind: 'person',
      desiredImageType: 'portrait',
      context: { movieTitle: null, eventName: null, characterName: null, evidence: 'none' },
      label: null,
      visualPurpose: '',
      visualCharacteristics: [],
      orientation: 'portrait',
      targetWidth: 540,
      targetHeight: 720,
      aiSearchTerms: [],
      groundingText: query
    };
    const deadline = cfg.requestTimeoutMs * 2 + 2000;
    const settled = await Promise.allSettled(
      providers.map(p =>
        Promise.race([
          p.search({ query, plan, limit, mode: 'text' }),
          new Promise<ImageCandidate[]>((_, rej) => setTimeout(() => rej(new Error('timed out')), deadline))
        ])
      )
    );
    const out: ImageCandidate[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push(`${providers[i].label}: ${String((r.reason as Error)?.message || r.reason).slice(0, 120)}`);
        return;
      }
      for (const c of r.value) {
        const rights = rightsForCandidate(c);
        if (!rightsAllowed(cfg.rightsPolicy, rights.classification)) continue;
        const key = c.imageUrl.split('?')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...c, rights });
      }
    });
    return { candidates: out.slice(0, limit * 2), providers: providers.map(p => p.id), errors };
  }

  /** Safe, size-capped download (private/loopback addresses refused; redirects re-validated). */
  async downloadForUser(url: string): Promise<Buffer> {
    const cfg = getConfig().discovery;
    return (await politeFetch(url, { timeoutMs: cfg.downloadTimeoutMs, maxBytes: Math.min(MAX_UPLOAD_BYTES, getConfig().limits.maxUploadBytes), userAgent: cfg.userAgent })).body;
  }

  /** This month's usage of the paid providers against their caps (no secrets). */
  async describeUsage(): Promise<{ provider: string; used: number | null; limit: number; month: string | null; error?: string }[]> {
    this.getProviders();
    return Promise.all(
      this.guards.map(g =>
        g.status().catch((e: any) => ({ provider: g.providerId, used: null, limit: NaN, month: null, error: String(e?.message || e).slice(0, 120) }))
      )
    );
  }

  /**
   * v2 discovery used by the viral adaptation pipeline: per-slot planning, multi-provider search,
   * metadata ranking, safe downloads, duplicate detection and visual verification.
   * Throws SlotDiscoveryError (with the per-slot report) when a slot cannot be filled safely.
   */
  async discoverForSlots(
    plans: SlotDiscoveryPlan[],
    referencePath: string | null,
    enabledProviderIds?: string[],
    onSlot?: SlotProgressListener
  ): Promise<DiscoveryRunResult> {
    const cfg = getConfig();
    let providers = this.getProviders();
    if (enabledProviderIds && enabledProviderIds.length > 0) {
      const allowed = new Set(enabledProviderIds.map(s => s.toLowerCase()));
      const filtered = providers.filter(p => allowed.has(p.id.toLowerCase()) && p.isEnabled());
      if (filtered.length === 0) {
        throw new BadRequestException('None of the selected search providers are currently enabled or available on the server.');
      }
      providers = filtered;
    }
    this.logger.log(`Active discovery providers for this run: ${providers.map(p => p.id).join(', ')}`);
    const engine = new DiscoveryEngine({
      providers,
      grounding: this.grounding,
      verifier: cfg.vision.verifyCandidates === 'off' || !this.runner ? null : new AgyVisualVerifier(this.runner),
      download: async url => (await politeFetch(url, { timeoutMs: cfg.discovery.downloadTimeoutMs, maxBytes: MAX_UPLOAD_BYTES, userAgent: cfg.discovery.userAgent })).body,
      config: cfg.discovery,
      verifyMode: cfg.vision.verifyCandidates,
      storageDir: this.storageDir,
      log: m => this.logger.log(m),
      rightsLookup: this.rightsLookup
    });
    return engine.run(plans, referencePath, onSlot);
  }

  /**
   * Discovers and retrieves high-resolution subject images EXCLUSIVELY from the internet.
   * Does NOT query MongoDB, server/uploads, or server/test-assets.
   * Intelligently resolves alternate names, nicknames, and spelling variations.
   *
   * @param identifiedSubjects Array of subject names identified by AI vision (e.g. "Anna Konidala", "Power Star")
   * @param targetCount Number of subject-image slots in the meme layout
   * @param context Optional contextual hint (e.g. movie name or headline)
   * @param itemLabels Optional per-slot labels
   */
  async discoverSubjectImages(
    identifiedSubjects: string[],
    targetCount: number,
    context?: string,
    itemLabels?: string[]
  ): Promise<UploadedAsset[]> {
    if (!identifiedSubjects || identifiedSubjects.length === 0) {
      throw new BadRequestException('No subjects were identified to discover on the internet.');
    }

    const countToDiscover = Math.max(1, targetCount || identifiedSubjects.length);
    const selectedAssets: UploadedAsset[] = [];
    const usedUrls = new Set<string>();

    this.logger.log(`Starting internet image discovery for ${countToDiscover} subject slots (Raw Subjects: ${identifiedSubjects.join(', ')})`);

    // Pre-flight: resolve every slot's identity BEFORE any network call. If any subject is
    // ambiguous we stop here (fail safe) instead of searching for a guessed person.
    const slotPlans = Array.from({ length: countToDiscover }, (_, i) => {
      const rawSubjectName = identifiedSubjects[i] || identifiedSubjects[identifiedSubjects.length - 1];
      const slotLabel = itemLabels && itemLabels[i] ? itemLabels[i] : undefined;
      const evidence = [context, slotLabel].filter(v => typeof v === 'string' && v.trim()).join(' ');
      return { rawSubjectName, slotLabel, profile: resolveSubjectIdentity(rawSubjectName, evidence) };
    });

    const ambiguous = slotPlans.filter(p => p.profile.status === 'ambiguous');
    if (ambiguous.length > 0) {
      const message = ambiguous.map(p => formatAmbiguityMessage(p.profile)).join(' ');
      this.logger.warn(`Aborting discovery: ${message}`);
      throw new BadRequestException(message);
    }

    for (let i = 0; i < countToDiscover; i++) {
      const { rawSubjectName, slotLabel, profile } = slotPlans[i];

      this.logger.log(`\n[Slot ${i + 1}/${countToDiscover}] Resolving and searching internet for subject: "${rawSubjectName}"`);

      const asset = await this.discoverSingleSubject(rawSubjectName, context, slotLabel, i, usedUrls, profile);

      usedUrls.add(asset.sourceUrl || asset.path);
      selectedAssets.push(asset);
    }

    this.logger.log(`Internet image discovery completed successfully: ${selectedAssets.length} verified assets retrieved.`);
    return selectedAssets;
  }

  /**
   * Multi-provider discovery for a single subject:
   * 1. Resolves alias / nickname / alternate spelling to canonical profile.
   * 2. Generates multiple contextual search queries.
   * 3. Queries multi-tier providers:
   *    - Tier 1: Wikimedia Commons API (High-res, CC / Public Domain)
   *    - Tier 2: Wikipedia PageImages API (Official portraits)
   *    - Tier 3: DuckDuckGo Image Search (Movie stills, press photos)
   *    - Optional Paid Tiers: Google CSE / Bing Image Search if keys are configured.
   * 4. Downloads, decodes with Skia Canvas, checks resolution/quality, and verifies subject identity.
   */
  private async discoverSingleSubject(
    rawSubjectName: string,
    context: string | undefined,
    label: string | undefined,
    slotIndex: number,
    usedUrls: Set<string>,
    resolvedProfile?: SubjectProfile
  ): Promise<UploadedAsset> {
    // 1. Strict Subject Identity Resolution (whole-phrase, verified aliases only)
    const profile: SubjectProfile = resolvedProfile
      || resolveSubjectIdentity(rawSubjectName, [context, label].filter(Boolean).join(' '));
    if (profile.status === 'ambiguous') {
      throw new BadRequestException(formatAmbiguityMessage(profile));
    }
    const searchQueries: string[] = buildSubjectSearchQueries(rawSubjectName, context, label);
    const verificationTokens: string[] = getSubjectVerificationTokens(rawSubjectName, profile);

    this.logger.log(`  Resolved Identity: "${rawSubjectName}" -> Canonical: "${profile.canonicalName}" (Known: ${profile.isKnownEntity}, Match: ${profile.matchType})`);
    this.logger.log(`  Generated Search Variations (${searchQueries.length}): ${searchQueries.map(q => `"${q}"`).join(', ')}`);
    this.logger.log(`  Identity name words: ${verificationTokens.join(', ')}`);

    const attemptedProviders = new Set<string>();
    let candidates: InternetImageCandidate[] = [];

    // 2. Query Providers Across Generated Variations
    for (const q of searchQueries) {
      // Optional: Google Programmable Search (if configured)
      if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
        attemptedProviders.add('Google Programmable Search');
        try {
          const googleResults = await this.searchGoogleCSE(q);
          candidates.push(...googleResults);
        } catch (err: any) {
          this.logger.warn(`Google CSE search notice for "${q}": ${err.message}`);
        }
      }

      // Optional: Bing Image Search (if configured)
      if (process.env.BING_SEARCH_API_KEY) {
        attemptedProviders.add('Bing Image Search');
        try {
          const bingResults = await this.searchBingImages(q);
          candidates.push(...bingResults);
        } catch (err: any) {
          this.logger.warn(`Bing search notice for "${q}": ${err.message}`);
        }
      }

      // Tier 1: Wikimedia Commons API
      attemptedProviders.add('Wikimedia Commons API');
      try {
        const commonsResults = await this.searchWikimediaCommons(q);
        candidates.push(...commonsResults);
      } catch (err: any) {
        this.logger.warn(`Wikimedia Commons search notice for "${q}": ${err.message}`);
      }

      // Tier 2: Wikipedia PageImages API
      attemptedProviders.add('Wikipedia PageImages API');
      try {
        const wikiResults = await this.searchWikipediaPageImages(q);
        candidates.push(...wikiResults);
      } catch (err: any) {
        this.logger.warn(`Wikipedia search notice for "${q}": ${err.message}`);
      }

      if (candidates.length >= 6) break;
    }

    // Tier 3: DuckDuckGo Fallback (for specific movie stills, posters, or recent events)
    if (candidates.length < 3) {
      attemptedProviders.add('DuckDuckGo Web Search');
      for (const q of searchQueries) {
        try {
          const ddgResults = await this.searchDuckDuckGo(q, profile);
          candidates.push(...ddgResults);
          if (candidates.length >= 4) break;
        } catch (err: any) {
          this.logger.warn(`DuckDuckGo search notice for "${q}": ${err.message}`);
        }
      }
    }

    // Filter out previously used URLs for deduplication
    const freshCandidates = candidates.filter(c => !usedUrls.has(c.sourceUrl));

    // Score every candidate's identity relevance (never use unrelated or uncertain images).
    // Best score first; Array.sort is stable so equal scores keep provider order.
    let rejectedLogged = 0;
    const relevantCandidates = freshCandidates
      .map(c => {
        const result = scoreSubjectRelevance(c, profile);
        c.relevanceScore = result.score;
        if (!result.accepted && rejectedLogged < 8) {
          rejectedLogged++;
          this.logger.log(`  ✗ Rejected (score ${result.score} < ${RELEVANCE_ACCEPT_THRESHOLD}): "${c.title}" - ${result.reasons.join('; ')}`);
        }
        return { candidate: c, result };
      })
      .filter(x => x.result.accepted)
      .sort((a, b) => b.result.score - a.result.score)
      .map(x => x.candidate);

    this.logger.log(`  Discovered ${candidates.length} total candidates -> ${relevantCandidates.length} relevant (score >= ${RELEVANCE_ACCEPT_THRESHOLD}) and fresh.`);

    if (relevantCandidates.length === 0) {
      throw new BadRequestException(
        `Could not discover a reliable internet image for subject "${rawSubjectName}". ` +
        `Resolved identity: "${profile.canonicalName}". ` +
        `Attempted ${searchQueries.length} search variations: [${searchQueries.map(q => `"${q}"`).join(', ')}] ` +
        `across providers: [${Array.from(attemptedProviders).join(', ')}]. ` +
        `The meme generator will not use unrelated, uncertain, or guessed images.`
      );
    }

    // Download, verify decode with Skia Canvas, check resolution/quality
    for (const candidate of relevantCandidates) {
      try {
        const downloaded = await this.downloadAndVerifyCandidate(candidate);
        if (downloaded) {
          return {
            id: randomUUID(),
            originalName: candidate.title || `${profile.canonicalName}.jpg`,
            filename: path.basename(downloaded.savedPath),
            path: downloaded.savedPath,
            mimeType: downloaded.mimeType,
            width: downloaded.width,
            height: downloaded.height,
            aspectRatio: downloaded.aspectRatio,
            orientation: downloaded.aspectRatio > 1.15 ? 'landscape' : (downloaded.aspectRatio < 0.85 ? 'portrait' : 'square'),
            role: slotIndex === 0 ? 'subject_primary' : (slotIndex === 1 ? 'subject_secondary' : 'subject_item'),
            orderIndex: slotIndex,
            label: label,
            sourceUrl: candidate.sourceUrl,
            attribution: candidate.attribution,
            license: candidate.license
          };
        }
      } catch (err: any) {
        this.logger.warn(`  Candidate rejected (${candidate.sourceUrl}): ${err.message}`);
      }
    }

    throw new BadRequestException(
      `Could not download and verify any of the candidate images for subject "${rawSubjectName}" (Resolved: "${profile.canonicalName}"). ` +
      `Attempted search variations: [${searchQueries.map(q => `"${q}"`).join(', ')}]. ` +
      `None met the resolution (>=250x250) or quality (>=20KB) requirements.`
    );
  }

  /**
   * Downloads remote image, decodes with @napi-rs/canvas loadImage(),
   * checks minimum quality (>20KB, dimensions >= 250x250), and saves to isolated storage.
   */
  private async downloadAndVerifyCandidate(
    candidate: InternetImageCandidate
  ): Promise<{ savedPath: string; mimeType: string; width: number; height: number; aspectRatio: number } | null> {
    // The timeout covers the whole download (headers AND body), and the body is size-capped so a
    // hostile or huge remote file cannot exhaust memory or hang the request.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let buffer: Buffer;
    try {
      const res = await fetch(candidate.sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        throw new Error(`Remote file too large (${declared} bytes), limit ${MAX_UPLOAD_BYTES}.`);
      }
      buffer = await this.readBodyCapped(res, MAX_UPLOAD_BYTES);
    } finally {
      clearTimeout(timeout);
    }

    if (buffer.length < 20000) {
      throw new Error(`File size too small (${buffer.length} bytes), minimum 20KB required.`);
    }

    // Content verification (magic bytes, sane dimensions BEFORE decoding, real decode): JPEG, PNG or WebP only
    let verified: VerifiedImage;
    try {
      verified = await verifyImageBuffer(buffer);
    } catch (err: any) {
      throw new Error(err instanceof ImageValidationError ? err.message : `Image verification failed: ${err.message}`);
    }
    if (verified.width < 250 || verified.height < 250) {
      throw new Error(`Invalid resolution (${verified.width}x${verified.height}); minimum 250x250 required.`);
    }

    const ext = verified.ext.slice(1);
    const mimeType = verified.mime;
    const width = verified.width;
    const height = verified.height;
    const aspectRatio = Number((width / height).toFixed(4));

    // Save verified image to isolated storage directory
    const filename = `internet_${randomUUID()}.${ext}`;
    const savedPath = path.join(this.storageDir, filename);
    fs.writeFileSync(savedPath, buffer);

    this.logger.log(`  ✓ Image verified & saved: ${savedPath} (${width}x${height}, ${(buffer.length / 1024).toFixed(1)} KB, Provider: ${candidate.sourceDomain})`);
    return {
      savedPath,
      mimeType,
      width,
      height,
      aspectRatio
    };
  }

  /** Reads a response body, aborting as soon as it exceeds maxBytes. */
  private async readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Remote file exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Tier 1: Search Wikimedia Commons API
   */
  private async searchWikimediaCommons(query: string): Promise<InternetImageCandidate[]> {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=6&prop=imageinfo&iiprop=url|size|mime|extmetadata`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return [];

    const data = await res.json();
    const pages = data.query?.pages || {};
    const results: InternetImageCandidate[] = [];

    for (const k in pages) {
      const p = pages[k];
      const info = p.imageinfo?.[0];
      if (info && info.url && info.mime?.startsWith('image/') && !info.mime?.includes('svg')) {
        results.push({
          title: p.title?.replace(/^File:/, '') || query,
          sourceUrl: info.url,
          thumbnailUrl: info.url,
          width: info.width,
          height: info.height,
          license: info.extmetadata?.LicenseShortName?.value || 'CC Attribution / Free License',
          attribution: (info.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').trim() || 'Wikimedia Commons',
          sourceDomain: 'commons.wikimedia.org'
        });
      }
    }

    return results;
  }

  /**
   * Tier 2: Search Wikipedia PageImages API
   */
  private async searchWikipediaPageImages(query: string): Promise<InternetImageCandidate[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages|imageinfo&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=4&pithumbsize=1200&iiprop=url|size|mime`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return [];

    const data = await res.json();
    const pages = data.query?.pages || {};
    const results: InternetImageCandidate[] = [];

    for (const k in pages) {
      const p = pages[k];
      if (p.thumbnail && p.thumbnail.source && !p.thumbnail.source.endsWith('.svg')) {
        results.push({
          title: p.title,
          sourceUrl: p.thumbnail.source,
          thumbnailUrl: p.thumbnail.source,
          width: p.thumbnail.width,
          height: p.thumbnail.height,
          license: 'Wikipedia / Editorial & Educational Attribution',
          attribution: 'Wikipedia',
          sourceDomain: 'en.wikipedia.org'
        });
      }
    }

    return results;
  }

  /**
   * Tier 3: Search DuckDuckGo Images
   */
  private async searchDuckDuckGo(query: string, profile: SubjectProfile): Promise<InternetImageCandidate[]> {
    try {
      const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const html = await tokenRes.text();
      const vqdMatch = html.match(/vqd=([\"']?)([\d-]+)\1/) || html.match(/vqd=([\d-]+)/);
      const vqd = vqdMatch ? (vqdMatch[2] || vqdMatch[1]) : null;

      if (!vqd) return [];

      const imgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;
      const imgRes = await fetch(imgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://duckduckgo.com/'
        }
      });
      const data = await imgRes.json();
      const rawResults = (data.results || []).slice(0, 8);

      return rawResults
        .filter((r: any) => scoreSubjectRelevance({ title: r.title, sourceUrl: r.image }, profile).accepted)
        .map((r: any) => ({
          title: r.title,
          sourceUrl: r.image,
          thumbnailUrl: r.thumbnail,
          width: r.width,
          height: r.height,
          license: 'Web Editorial / Press Source',
          attribution: r.url ? new URL(r.url).hostname : 'Web',
          sourceDomain: r.url ? new URL(r.url).hostname : 'web'
        }));
    } catch (err: any) {
      return [];
    }
  }

  /**
   * Optional: Google Programmable Search Engine (Custom Search JSON API)
   * Enabled only if GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX environment variables exist.
   */
  private async searchGoogleCSE(query: string): Promise<InternetImageCandidate[]> {
    const key = process.env.GOOGLE_SEARCH_API_KEY;
    const cx = process.env.GOOGLE_SEARCH_CX;
    if (!key || !cx) return [];

    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&key=${key}&cx=${cx}&num=5`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    return (data.items || []).map((item: any) => ({
      title: item.title,
      sourceUrl: item.link,
      thumbnailUrl: item.image?.thumbnailLink,
      width: item.image?.width,
      height: item.image?.height,
      license: 'Web Source (via Google Custom Search)',
      attribution: item.displayLink || 'Google CSE',
      sourceDomain: item.displayLink || 'google'
    }));
  }

  /**
   * Optional: Bing Image Search API
   * Enabled only if BING_SEARCH_API_KEY environment variable exists.
   */
  private async searchBingImages(query: string): Promise<InternetImageCandidate[]> {
    const key = process.env.BING_SEARCH_API_KEY;
    if (!key) return [];

    const url = `https://api.bing.microsoft.com/v7.0/images/search?q=${encodeURIComponent(query)}&count=5`;
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': key }
    });
    if (!res.ok) return [];

    const data = await res.json();
    return (data.value || []).map((val: any) => ({
      title: val.name,
      sourceUrl: val.contentUrl,
      thumbnailUrl: val.thumbnailUrl,
      width: val.width,
      height: val.height,
      license: 'Web Source (via Bing Search)',
      attribution: val.hostPageDisplayUrl || 'Bing',
      sourceDomain: val.hostPageDisplayUrl || 'bing'
    }));
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }
}
