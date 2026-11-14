/**
 * Non-Wikimedia providers:
 *  - OpenverseProvider     official, free (anonymous, rate-limited); openly licensed images (Flickr etc.)
 *  - DuckDuckGoProvider    UNOFFICIAL (undocumented endpoint, may break or be rate-limited);
 *                          the only free source of film stills / press photos. Can be disabled with
 *                          DISCOVERY_ALLOW_UNOFFICIAL=false.
 *  - GoogleCseProvider     official but CLOSED to new customers and shut down by Google on 2027-01-01;
 *                          kept only for existing keys (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX).
 *  - TmdbProvider          official. TMDB's standard API terms forbid commercial use, use "in connection
 *                          with ... an artificial intelligence (AI) based Application" and making
 *                          derivatives, so it only runs with TMDB_COMMERCIAL_AGREEMENT=true (a written
 *                          agreement that permits this use) plus TMDB_API_KEY / TMDB_READ_ACCESS_TOKEN.
 *                          Gives actor portraits, film backdrops (stills) and posters.
 * Web results from DuckDuckGo and Custom Search are used during the run only (resultStorage 'transient').
 * Brave Image Search and Google Cloud Vision reverse image search live in their own files.
 * (Bing Image Search was retired by Microsoft on 2025-08-11 and has been removed.)
 */
import { ImageCandidate, ImageSearchProvider, ProviderSearchRequest } from '../discovery.types';
import { matchTokens } from '../../services/subject-alias-resolver';
import { candidateId, defaultProviderHttp, isAcceptedImageUrl, isFreeLicense, ProviderHttp, stripHtml } from './provider-http';

const folded = (s: string) => matchTokens(s).join(' ');
const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).hostname : undefined;
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------------------------------------
// Openverse
// ------------------------------------------------------------------------------------------------

export interface OpenverseResult {
  id?: string;
  title?: string;
  url?: string;
  width?: number;
  height?: number;
  license?: string;
  license_version?: string;
  license_url?: string;
  creator?: string;
  source?: string;
  foreign_landing_url?: string;
  filetype?: string;
  tags?: { name?: string }[];
}

export function openverseToCandidates(results: OpenverseResult[], query: string, reliability: number): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  for (const r of results || []) {
    if (!r.url || !isAcceptedImageUrl(r.url)) continue;
    if (r.filetype && !/^(jpe?g|png|webp)$/i.test(r.filetype)) continue;
    const license = r.license ? `CC ${String(r.license).toUpperCase()} ${r.license_version || ''}`.replace(/^CC (PDM|CC0)/, '$1').trim() : undefined;
    out.push({
      id: candidateId('openverse', r.url),
      provider: 'openverse',
      providerKind: 'official_api',
      providerReliability: reliability,
      query,
      title: stripHtml(r.title, 200) || '',
      imageUrl: r.url,
      pageUrl: r.foreign_landing_url,
      width: r.width,
      height: r.height,
      license,
      licenseUrl: r.license_url,
      licenseKnown: Boolean(license),
      // CC BY-NC / BY-ND are open licences that do not cover edited, monetised memes
      licenseFree: isFreeLicense(license),
      attribution: [stripHtml(r.creator, 120), r.source].filter(Boolean).join(' via '),
      tags: (r.tags || []).map(t => String(t.name || '')).filter(Boolean).slice(0, 25),
      categories: [],
      identityEvidence: { kind: 'none' },
      typeHints: [],
      resultStorage: 'full'
    });
  }
  return out;
}

export class OpenverseProvider implements ImageSearchProvider {
  readonly id = 'openverse';
  readonly label = 'Openverse';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.75;
  readonly supportsEntityMode = false;
  private blockedUntil = 0;

  constructor(private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp) {}

  isEnabled(): boolean {
    return this.enabled() && Date.now() >= this.blockedUntil;
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'text') return [];
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(req.query)}&page_size=${Math.min(20, req.limit)}&mature=false`;
    try {
      const data = await this.http.getJson<{ results?: OpenverseResult[] }>(url);
      return openverseToCandidates(data?.results || [], req.query, this.reliability);
    } catch (e: any) {
      if (e?.status === 429) this.blockedUntil = Date.now() + 10 * 60 * 1000; // respect the anonymous rate limit
      throw e;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// DuckDuckGo (unofficial)
// ------------------------------------------------------------------------------------------------

export interface DdgResult {
  title?: string;
  image?: string;
  thumbnail?: string;
  url?: string;
  width?: number;
  height?: number;
  source?: string;
}

export function ddgToCandidates(results: DdgResult[], query: string, reliability: number): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  for (const r of results || []) {
    if (!r.image || !isAcceptedImageUrl(r.image)) continue;
    const host = hostOf(r.url) || hostOf(r.image);
    out.push({
      id: candidateId('duckduckgo', r.image),
      provider: 'duckduckgo',
      providerKind: 'unofficial',
      providerReliability: reliability,
      query,
      title: stripHtml(r.title, 200) || '',
      imageUrl: r.image,
      pageUrl: r.url,
      width: r.width,
      height: r.height,
      license: 'Unknown (web image; check the source page before reuse)',
      licenseKnown: false,
      licenseFree: false,
      attribution: host,
      tags: [],
      categories: [],
      identityEvidence: { kind: 'none' },
      typeHints: [],
      resultStorage: 'transient'
    });
  }
  return out;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class DuckDuckGoProvider implements ImageSearchProvider {
  readonly id = 'duckduckgo';
  readonly label = 'DuckDuckGo (unofficial)';
  readonly kind = 'unofficial' as const;
  readonly reliability = 0.5;
  readonly supportsEntityMode = false;
  readonly resultStorage = 'transient' as const;

  constructor(private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp) {}

  isEnabled(): boolean {
    return this.enabled();
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'text') return [];
    const q = encodeURIComponent(req.query);
    const html = await this.http.getText(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, { headers: { 'User-Agent': BROWSER_UA } });
    const m = html.match(/vqd=["']?([\d-]+)["']?/) || html.match(/vqd=([\d-]+)/);
    if (!m) throw new Error('DuckDuckGo token not found (the unofficial endpoint may have changed)');
    const data = await this.http.getJson<{ results?: DdgResult[] }>(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${m[1]}&f=,,,&p=1`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://duckduckgo.com/' }
    });
    return ddgToCandidates((data?.results || []).slice(0, req.limit), req.query, this.reliability);
  }
}

// ------------------------------------------------------------------------------------------------
// Google Programmable Search (deprecated by Google: closed to new customers, off on 2027-01-01)
// ------------------------------------------------------------------------------------------------

export class GoogleCseProvider implements ImageSearchProvider {
  readonly id = 'google-cse';
  readonly label = 'Google Programmable Search (existing keys only, ends 2027-01-01)';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.6;
  readonly supportsEntityMode = false;
  readonly resultStorage = 'transient' as const;

  constructor(private readonly key: () => { apiKey?: string; cx?: string }, private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp) {}

  isEnabled(): boolean {
    const k = this.key();
    return this.enabled() && Boolean(k.apiKey && k.cx) && Date.now() < Date.parse('2027-01-01T00:00:00Z');
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'text') return [];
    const { apiKey, cx } = this.key();
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(req.query)}&searchType=image&num=10&key=${encodeURIComponent(apiKey || '')}&cx=${encodeURIComponent(cx || '')}`;
    const data = await this.http.getJson<{ items?: { title?: string; link?: string; displayLink?: string; image?: { contextLink?: string; width?: number; height?: number } }[] }>(url);
    return (data?.items || [])
      .filter(i => i.link && isAcceptedImageUrl(i.link))
      .map(i => ({
        id: candidateId(this.id, i.link as string),
        provider: this.id,
        providerKind: this.kind,
        providerReliability: this.reliability,
        query: req.query,
        title: stripHtml(i.title, 200) || '',
        imageUrl: i.link as string,
        pageUrl: i.image?.contextLink,
        width: i.image?.width,
        height: i.image?.height,
        license: 'Unknown (web image; check the source page before reuse)',
        licenseKnown: false,
        licenseFree: false,
        attribution: i.displayLink,
        tags: [],
        categories: [],
        identityEvidence: { kind: 'none' as const },
        typeHints: [],
        resultStorage: 'transient' as const
      }));
  }
}

// ------------------------------------------------------------------------------------------------
// TMDB (optional; needs a key AND a written agreement with TMDB that permits this use)
// ------------------------------------------------------------------------------------------------

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/original';

export class TmdbProvider implements ImageSearchProvider {
  readonly id = 'tmdb';
  readonly label = 'TMDB (written agreement required)';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.85;
  readonly supportsEntityMode = true;
  private readonly personCache = new Map<string, number | null>();

  /**
   * @param key   API key / read token, plus `agreement`: true only when a written TMDB agreement
   *              permits commercial, AI-based and derivative use (TMDB_COMMERCIAL_AGREEMENT=true).
   *              TMDB's standard terms forbid all three, so a key alone never enables this provider.
   */
  constructor(private readonly key: () => { apiKey?: string; token?: string; agreement?: boolean }, private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp) {}

  isEnabled(): boolean {
    const k = this.key();
    return this.enabled() && Boolean(k.apiKey || k.token) && k.agreement === true;
  }

  private get<T>(pathAndQuery: string): Promise<T> {
    const { apiKey, token } = this.key();
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `${TMDB_API}${pathAndQuery}${token ? '' : `${sep}api_key=${encodeURIComponent(apiKey || '')}`}`;
    return this.http.getJson<T>(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  }

  private candidate(filePath: string, kind: string, title: string, req: ProviderSearchRequest, w?: number, h?: number, identity?: ImageCandidate['identityEvidence'], mediaTitle?: string): ImageCandidate {
    const url = `${TMDB_IMG}${filePath}`;
    return {
      id: candidateId(this.id, url),
      provider: this.id,
      providerKind: this.kind,
      providerReliability: this.reliability,
      query: req.query,
      title,
      imageUrl: url,
      pageUrl: 'https://www.themoviedb.org/',
      width: w,
      height: h,
      license: 'TMDB image (rights belong to the studio; used under your written TMDB agreement)',
      licenseKnown: false,
      licenseFree: false,
      attribution: 'TMDB',
      tags: [],
      categories: [],
      identityEvidence: identity || { kind: 'none' },
      typeHints: [kind],
      mediaTitle
    };
  }

  private async personId(name: string): Promise<number | null> {
    const key = folded(name);
    if (this.personCache.has(key)) return this.personCache.get(key) as number | null;
    const data = await this.get<{ results?: { id: number; name?: string; original_name?: string; known_for_department?: string }[] }>(`/search/person?query=${encodeURIComponent(name)}`);
    const match = (data?.results || []).find(r => folded(r.name || '') === key || folded(r.original_name || '') === key);
    const id = match ? match.id : null;
    this.personCache.set(key, id);
    return id;
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode === 'image' || !this.isEnabled()) return [];
    const out: ImageCandidate[] = [];
    const film = req.plan.context.movieTitle;
    const isPerson = req.plan.subjectKind === 'person' || req.plan.subjectKind === 'movie_character';

    if (isPerson) {
      const pid = await this.personId(req.plan.subjectName);
      if (pid) {
        const evidence = { kind: 'tmdb_person_profile' as const, detail: `TMDB person ${pid}` };
        const tagged = await this.get<{ results?: { file_path?: string; width?: number; height?: number; image_type?: string; media?: { title?: string; original_title?: string; name?: string } }[] }>(`/person/${pid}/tagged_images?page=1`);
        for (const t of tagged?.results || []) {
          if (!t.file_path) continue;
          const mt = t.media?.title || t.media?.original_title || t.media?.name;
          out.push(this.candidate(t.file_path, t.image_type === 'poster' ? 'poster' : 'still', `${req.plan.subjectName} in ${mt || 'a film'} (TMDB ${t.image_type || 'image'})`, req, t.width, t.height, { kind: 'tmdb_tagged_image', detail: `tagged ${req.plan.subjectName}` }, mt));
        }
        const imgs = await this.get<{ profiles?: { file_path?: string; width?: number; height?: number }[] }>(`/person/${pid}/images`);
        for (const p of (imgs?.profiles || []).slice(0, 10)) {
          if (p.file_path) out.push(this.candidate(p.file_path, 'profile', `${req.plan.subjectName} (TMDB profile photo)`, req, p.width, p.height, evidence));
        }
      }
    }
    if (film && (req.plan.desiredImageType === 'movie_still' || req.plan.desiredImageType === 'movie_poster')) {
      const movies = await this.get<{ results?: { id: number; title?: string; original_title?: string }[] }>(`/search/movie?query=${encodeURIComponent(film)}`);
      const m = (movies?.results || []).find(r => folded(r.title || '') === folded(film) || folded(r.original_title || '') === folded(film));
      if (m) {
        const imgs = await this.get<{ backdrops?: { file_path?: string; width?: number; height?: number }[]; posters?: { file_path?: string; width?: number; height?: number }[] }>(`/movie/${m.id}/images?include_image_language=null,en,te`);
        for (const b of (imgs?.backdrops || []).slice(0, 12)) if (b.file_path) out.push(this.candidate(b.file_path, 'still', `${m.title} (TMDB film still)`, req, b.width, b.height, undefined, m.title));
        for (const p of (imgs?.posters || []).slice(0, 4)) if (p.file_path) out.push(this.candidate(p.file_path, 'poster', `${m.title} (TMDB poster)`, req, p.width, p.height, undefined, m.title));
      }
    }
    return out.slice(0, Math.max(req.limit, 10));
  }
}
