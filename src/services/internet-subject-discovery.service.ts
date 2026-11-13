import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { loadImage } from '@napi-rs/canvas';
import { UploadedAsset } from '../types/meme.types';
import {
  resolveSubjectIdentity,
  buildSubjectSearchQueries,
  getSubjectVerificationTokens,
  SubjectProfile
} from './subject-alias-resolver';

export interface InternetImageCandidate {
  title: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  license?: string;
  attribution?: string;
  sourceDomain: string;
}

@Injectable()
export class InternetSubjectDiscoveryService {
  private readonly logger = new Logger(InternetSubjectDiscoveryService.name);
  private readonly storageDir = path.join(__dirname, '..', '..', 'uploads', 'internet-discovered');
  private readonly userAgent = 'TeluguMemeEngine/1.0 (contact: admin@kanyaraasi.local; Automated Meme Studio)';

  constructor() {
    this.ensureStorageDir();
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

    for (let i = 0; i < countToDiscover; i++) {
      // Pick subject name for this slot (or cycle if multiple slots for same subject)
      const rawSubjectName = identifiedSubjects[i] || identifiedSubjects[identifiedSubjects.length - 1];
      const slotLabel = itemLabels && itemLabels[i] ? itemLabels[i] : undefined;

      this.logger.log(`\n[Slot ${i + 1}/${countToDiscover}] Resolving and searching internet for subject: "${rawSubjectName}"`);

      const asset = await this.discoverSingleSubject(rawSubjectName, context, slotLabel, i, usedUrls);

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
    usedUrls: Set<string>
  ): Promise<UploadedAsset> {
    // 1. Intelligent Subject Name Resolution
    const profile: SubjectProfile = resolveSubjectIdentity(rawSubjectName, context);
    const searchQueries: string[] = buildSubjectSearchQueries(rawSubjectName, context, label);
    const verificationTokens: string[] = getSubjectVerificationTokens(rawSubjectName, profile);

    this.logger.log(`  Resolved Identity: "${rawSubjectName}" -> Canonical: "${profile.canonicalName}" (Known: ${profile.isKnownEntity})`);
    this.logger.log(`  Generated Search Variations (${searchQueries.length}): ${searchQueries.map(q => `"${q}"`).join(', ')}`);
    this.logger.log(`  Identity Verification Tokens: ${verificationTokens.join(', ')}`);

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
          const ddgResults = await this.searchDuckDuckGo(q, verificationTokens);
          candidates.push(...ddgResults);
          if (candidates.length >= 4) break;
        } catch (err: any) {
          this.logger.warn(`DuckDuckGo search notice for "${q}": ${err.message}`);
        }
      }
    }

    // Filter out previously used URLs for deduplication
    const freshCandidates = candidates.filter(c => !usedUrls.has(c.sourceUrl));

    // Verify candidate relevance against resolved tokens (never use unrelated or uncertain images)
    const relevantCandidates = freshCandidates.filter(c => this.isCandidateRelevant(c, verificationTokens));

    this.logger.log(`  Discovered ${candidates.length} total candidates -> ${relevantCandidates.length} relevant and fresh.`);

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let res: Response;
    try {
      res = await fetch(candidate.sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 20000) {
      throw new Error(`File size too small (${buffer.length} bytes), minimum 20KB required.`);
    }

    // Verify magic bytes (JPEG, PNG, WEBP)
    let ext = 'jpg';
    let mimeType = 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      ext = 'png';
      mimeType = 'image/png';
    } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      ext = 'webp';
      mimeType = 'image/webp';
    } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      ext = 'jpg';
      mimeType = 'image/jpeg';
    } else {
      throw new Error('Unsupported image format; magic bytes do not match JPEG, PNG, or WEBP.');
    }

    // Canvas Engine verification: Decode with Skia Canvas
    const canvasImg = await loadImage(buffer);
    if (!canvasImg.width || !canvasImg.height || canvasImg.width < 250 || canvasImg.height < 250) {
      throw new Error(`Invalid resolution (${canvasImg.width}x${canvasImg.height}); minimum 250x250 required.`);
    }

    const width = canvasImg.width;
    const height = canvasImg.height;
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
  private async searchDuckDuckGo(query: string, verificationTokens?: string[]): Promise<InternetImageCandidate[]> {
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
        .filter((r: any) => {
          if (!verificationTokens || verificationTokens.length === 0) return false;
          return this.isCandidateRelevant({ title: r.title, sourceUrl: r.image }, verificationTokens);
        })
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

  /**
   * Verifies that the candidate image title, snippet, or URL is strictly relevant to the subject.
   * Compares against all resolved verification tokens (including aliases, canonical name, and nicknames).
   */
  private isCandidateRelevant(
    candidate: Partial<InternetImageCandidate>,
    verificationTokens: string[]
  ): boolean {
    if (!verificationTokens || verificationTokens.length === 0) return false;

    const candidateText = ((candidate.title || '') + ' ' + (candidate.sourceUrl || '')).toLowerCase();

    // Check if at least one meaningful token matches
    return verificationTokens.some(token => {
      const cleanTok = token.toLowerCase().replace(/[^a-z]/g, '');
      if (['ntr', 'cbn', 'pk'].includes(cleanTok)) {
        return candidateText.includes(cleanTok);
      }
      return cleanTok.length >= 4 && candidateText.includes(cleanTok);
    });
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }
}
