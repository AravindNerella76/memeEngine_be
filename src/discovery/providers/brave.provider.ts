/**
 * Brave Image Search API (official, paid per request; https://api-dashboard.search.brave.com).
 *
 *  - Off unless BRAVE_SEARCH_API_KEY is set. Every request is counted against a monthly cap
 *    (BRAVE_MONTHLY_REQUEST_LIMIT, default 1000 = about the $5 monthly free credit).
 *  - The key is sent in the X-Subscription-Token header, never in a URL.
 *  - Brave's terms (3(b)(i)) allow only transient storage of search results, so its titles and
 *    URLs are used during the run but never stored in the meme or the report (resultStorage
 *    'transient'). Brave grants no rights to the images it finds (9(d)): every result is labelled
 *    "copyrighted, reuse permission not confirmed".
 *  - Only the ORIGINAL image on the source website (properties.url) is downloaded. Brave's own
 *    thumbnails are search results and are never used or edited (3(b)(ii)).
 */
import { ImageCandidate, ImageSearchProvider, ProviderSearchRequest } from '../discovery.types';
import { UsageGuard } from '../provider-usage';
import { candidateId, defaultProviderHttp, isAcceptedImageUrl, ProviderHttp, stripHtml } from './provider-http';

export const BRAVE_IMAGES_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';

export interface BraveImageResult {
  type?: string;
  title?: string;
  /** Source page. */
  url?: string;
  source?: string;
  thumbnail?: { src?: string; width?: number; height?: number };
  properties?: { url?: string; placeholder?: string; width?: number; height?: number };
  meta_url?: { hostname?: string; netloc?: string };
  confidence?: string;
}

const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

/** Brave results -> candidates (pure; unit-tested with fixtures). */
export function braveToCandidates(results: BraveImageResult[], query: string, reliability: number): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const r of results || []) {
    const imageUrl = r?.properties?.url;
    if (!imageUrl || !isAcceptedImageUrl(imageUrl) || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    let host: string | undefined;
    try {
      host = r.meta_url?.hostname || (r.url ? new URL(r.url).hostname : undefined) || r.source;
    } catch {
      host = r.source;
    }
    out.push({
      id: candidateId('brave-images', imageUrl),
      provider: 'brave-images',
      providerKind: 'official_api',
      providerReliability: reliability,
      query,
      title: stripHtml(r.title, 200) || '',
      imageUrl,
      pageUrl: typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r.url : undefined,
      width: dim(r.properties?.width),
      height: dim(r.properties?.height),
      license: 'Unknown (web image found by Brave Search; reuse permission not confirmed)',
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

export interface BraveSettings {
  apiKey?: string;
  country: string;
}

export class BraveImageProvider implements ImageSearchProvider {
  readonly id = 'brave-images';
  readonly label = 'Brave Image Search';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.7;
  readonly supportsEntityMode = false;
  readonly capability = 'text' as const;
  readonly resultStorage = 'transient' as const;
  public disabledReason: string | null = null;
  private pausedUntil = 0;

  constructor(
    private readonly settings: () => BraveSettings,
    private readonly enabled: () => boolean,
    private readonly guard: UsageGuard,
    private readonly http: ProviderHttp = defaultProviderHttp
  ) {}

  isEnabled(): boolean {
    return this.enabled() && Boolean(this.settings().apiKey) && !this.disabledReason && !this.guard.isBlocked() && Date.now() >= this.pausedUntil;
  }

  isKeyConfigured(): boolean {
    return Boolean(this.settings().apiKey);
  }

  buildUrl(query: string): string {
    const s = this.settings();
    const params = new URLSearchParams({ q: query.slice(0, 380), count: '50', safesearch: 'strict', spellcheck: 'false' });
    if (s.country) params.set('country', s.country);
    return `${BRAVE_IMAGES_ENDPOINT}?${params.toString()}`;
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'text') return [];
    const { apiKey } = this.settings();
    if (!apiKey) return [];
    await this.guard.consume(1);
    try {
      const data = await this.http.getJson<{ results?: BraveImageResult[] }>(this.buildUrl(req.query), {
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' }
      });
      return braveToCandidates(data?.results || [], req.query, this.reliability);
    } catch (e: any) {
      const status = e?.status;
      if (status === 401 || status === 403) this.disabledReason = `Brave rejected the API key (HTTP ${status})`;
      else if (status === 402) this.disabledReason = 'Brave reports a billing or credit problem (HTTP 402)';
      else if (status === 429) this.pausedUntil = Date.now() + 60_000;
      throw e;
    }
  }
}
