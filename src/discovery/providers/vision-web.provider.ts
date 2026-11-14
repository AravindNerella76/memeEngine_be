/**
 * Google Cloud Vision API, WEB_DETECTION feature: reverse image search of the slot's crop from the
 * reference (official, paid per image; first 1000 units a month free).
 *
 * This is how discovery looks for the EXACT underlying picture of the reference (often larger and
 * without the other page's text), plus the pages that carry it.
 *
 *  - Off unless GOOGLE_CLOUD_VISION_API_KEY is set; capped by GOOGLE_VISION_MONTHLY_UNIT_LIMIT
 *    (default 1000 = the free tier). The key goes in the X-Goog-Api-Key header, never in a URL.
 *  - Only the subject slot's crop is sent (never the reaction image or the punchline).
 *  - Identity stays strict: an exact or partial match gets structured identity evidence ONLY when
 *    Google's own web entities for the crop also name the subject (two independent signals).
 *    Otherwise the match has to prove identity through its page title like any other candidate.
 *  - "Visually similar" images are not used: they come without any text, so who they show
 *    cannot be checked before download.
 *  - No licence information exists for web images: they are labelled "copyrighted, reuse
 *    permission not confirmed" (Wikimedia-hosted files are re-checked against Commons).
 */
import { ImageCandidate, ImageSearchProvider, ProviderSearchRequest } from '../discovery.types';
import { UsageGuard } from '../provider-usage';
import { matchTokens } from '../../services/subject-alias-resolver';
import { candidateId, defaultProviderHttp, isAcceptedImageUrl, ProviderHttp, stripHtml } from './provider-http';

export const VISION_ANNOTATE_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

export interface WebDetection {
  webEntities?: { entityId?: string; score?: number; description?: string }[];
  fullMatchingImages?: { url?: string; score?: number }[];
  partialMatchingImages?: { url?: string; score?: number }[];
  pagesWithMatchingImages?: {
    url?: string;
    pageTitle?: string;
    score?: number;
    fullMatchingImages?: { url?: string }[];
    partialMatchingImages?: { url?: string }[];
  }[];
  visuallySimilarImages?: { url?: string; score?: number }[];
  bestGuessLabels?: { label?: string; languageCode?: string }[];
}

const folded = (s: string) => matchTokens(s).join(' ');

/** Minimum web-entity score for the subject's name to count as confirmation. */
export const ENTITY_CONFIRM_MIN_SCORE = 0.5;

/** Web Detection -> candidates (pure; unit-tested with fixtures). */
export function webDetectionToCandidates(wd: WebDetection | undefined, req: ProviderSearchRequest, reliability: number): ImageCandidate[] {
  if (!wd) return [];
  const plan = req.plan;
  const names = new Set(
    [plan.subjectName, plan.identity.profile?.canonicalName || '', plan.identity.profile?.professionalName || '', ...(plan.identity.profile?.aliases || [])]
      .filter(n => n && /^[\x20-\x7E]+$/.test(n))
      .map(folded)
      .filter(Boolean)
  );
  const entities = (wd.webEntities || [])
    .filter(e => typeof e.description === 'string' && e.description.trim())
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const topEntities = entities.slice(0, 3);
  const confirming = topEntities.find(e => names.has(folded(String(e.description))) && (e.score || 0) >= ENTITY_CONFIRM_MIN_SCORE);
  const contextTerms = [
    ...entities.slice(0, 8).map(e => stripHtml(e.description, 80) || ''),
    ...(wd.bestGuessLabels || []).map(l => stripHtml(l.label, 80) || '')
  ].filter(Boolean);

  // image URL -> first page that carries it
  const pageOf = new Map<string, { url?: string; title?: string }>();
  for (const p of wd.pagesWithMatchingImages || []) {
    const page = { url: typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url : undefined, title: stripHtml(p.pageTitle, 200) };
    for (const im of [...(p.fullMatchingImages || []), ...(p.partialMatchingImages || [])]) {
      if (im.url && !pageOf.has(im.url)) pageOf.set(im.url, page);
    }
  }
  const matches: { url: string; kind: 'full' | 'partial' }[] = [];
  const add = (url: string | undefined, kind: 'full' | 'partial') => {
    if (url && isAcceptedImageUrl(url) && !matches.some(m => m.url === url)) matches.push({ url, kind });
  };
  for (const m of wd.fullMatchingImages || []) add(m.url, 'full');
  for (const p of wd.pagesWithMatchingImages || []) for (const m of p.fullMatchingImages || []) add(m.url, 'full');
  for (const m of wd.partialMatchingImages || []) add(m.url, 'partial');
  for (const p of wd.pagesWithMatchingImages || []) for (const m of p.partialMatchingImages || []) add(m.url, 'partial');

  return matches.slice(0, 24).map(m => {
    const page = pageOf.get(m.url);
    let host: string | undefined;
    try {
      host = new URL(page?.url || m.url).hostname;
    } catch {
      host = undefined;
    }
    return {
      id: candidateId('google-vision-web', m.url),
      provider: 'google-vision-web',
      providerKind: 'official_api',
      providerReliability: reliability,
      query: 'reverse image search of the reference slot',
      title: page?.title || '',
      imageUrl: m.url,
      pageUrl: page?.url,
      license: 'Unknown (web image found by reverse image search; reuse permission not confirmed)',
      licenseKnown: false,
      licenseFree: false,
      attribution: host,
      // Context only (film / event names for the context score); never identity text.
      contextHints: contextTerms.slice(0, 10),
      tags: [],
      categories: [],
      identityEvidence: confirming
        ? { kind: 'reverse_image_match', detail: `${m.kind === 'full' ? 'same picture' : 'crop or edit of the same picture'} as the reference slot; Google names "${stripHtml(confirming.description, 60)}" (score ${(confirming.score || 0).toFixed(2)})` }
        : { kind: 'none' },
      typeHints: [],
      reverseMatch: m.kind,
      resultStorage: 'full'
    } as ImageCandidate;
  });
}

export class GoogleVisionWebProvider implements ImageSearchProvider {
  readonly id = 'google-vision-web';
  readonly label = 'Google Cloud Vision reverse image search';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.8;
  readonly supportsEntityMode = false;
  readonly capability = 'image' as const;
  readonly resultStorage = 'full' as const;
  public disabledReason: string | null = null;
  private probed = false;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly enabled: () => boolean,
    private readonly guard: UsageGuard,
    private readonly http: ProviderHttp = defaultProviderHttp
  ) {}

  isEnabled(): boolean {
    return this.enabled() && Boolean(this.apiKey()) && !this.disabledReason && !this.guard.isBlocked();
  }

  isKeyConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  static buildRequest(image: Buffer) {
    return {
      requests: [
        {
          image: { content: image.toString('base64') },
          features: [{ type: 'WEB_DETECTION', maxResults: 30 }],
          imageContext: { webDetectionParams: { includeGeoResults: false } }
        }
      ]
    };
  }

  async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    const key = this.apiKey();
    if (!key || !this.enabled()) return;
    try {
      // 1x1 transparent GIF to probe key and billing status without quota impact
      const tiny1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      await this.http.postJson(VISION_ANNOTATE_ENDPOINT, GoogleVisionWebProvider.buildRequest(tiny1x1), { headers: { 'X-Goog-Api-Key': key } });
      this.disabledReason = null;
    } catch (e: any) {
      this.handleApiError(e);
    }
  }

  private handleApiError(e: any): void {
    const msg = String(e?.message || '');
    if (e?.status === 401 || e?.status === 403 || e?.status === 400) {
      if (/billing/i.test(msg) || /BILLING_DISABLED/i.test(msg)) {
        this.disabledReason = 'Billing is disabled on Google Cloud project #1087502754651. Even though 1,000 requests/mo are free, Google requires a billing account to be linked.';
      } else {
        this.disabledReason = `Google Cloud Vision rejected the key or the API is not enabled for its project: ${msg.slice(0, 160)}`;
      }
    }
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'image' || !req.image?.length) return [];
    const key = this.apiKey();
    if (!key) return [];
    await this.guard.consume(1);
    let data: { responses?: { webDetection?: WebDetection; error?: { code?: number; message?: string } }[] };
    try {
      data = await this.http.postJson(VISION_ANNOTATE_ENDPOINT, GoogleVisionWebProvider.buildRequest(req.image), { headers: { 'X-Goog-Api-Key': key } });
    } catch (e: any) {
      this.handleApiError(e);
      throw e;
    }
    const res = data?.responses?.[0];
    if (res?.error) throw new Error(`Cloud Vision error ${res.error.code ?? ''}: ${String(res.error.message || '').slice(0, 120)}`);
    return webDetectionToCandidates(res?.webDetection, req, this.reliability);
  }
}
