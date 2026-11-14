/**
 * Wikimedia family (official, free APIs):
 *  - WikimediaCommonsProvider: free-text search, plus structured lookups by Commons category and
 *    by "depicts" (P180) statements, which identify the person independently of file titles.
 *  - WikipediaProvider: lead images of matching articles, with the real licence of each file.
 *  - WikidataGrounding: finds the person's Wikidata item (label/alias + description must match),
 *    giving the Commons category and the QID used for the structured lookups.
 */
import { ImageCandidate, ImageSearchProvider, ProviderSearchRequest, GroundedEntity } from '../discovery.types';
import { matchTokens } from '../../services/subject-alias-resolver';
import { wikimediaFileFromUrl } from '../rights';
import { candidateId, defaultProviderHttp, isAcceptedMime, isFreeLicense, ProviderHttp, stripHtml } from './provider-http';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ENWIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const EXT_FILTER = 'LicenseShortName|LicenseUrl|Artist|ImageDescription|Categories|UsageTerms|NonFree';

/** Wikipedia marks fair-use files (film posters, screenshots) as non-free. */
function isNonFreeFile(meta: Record<string, { value?: string }>, categories: string[], license?: string): boolean {
  if (/^(true|1|yes)$/i.test(String(meta.NonFree?.value || '').trim())) return true;
  if (license && /fair use|non-?free/i.test(license)) return true;
  return categories.some(c => /^all non-free media$|non-free (files|media)/i.test(c));
}

const qs = (params: Record<string, string | number>) =>
  Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

const folded = (s: string) => matchTokens(s).join(' ');

interface CommonsPage {
  title?: string;
  imageinfo?: {
    url?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    mime?: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    extmetadata?: Record<string, { value?: string }>;
  }[];
  categories?: { title?: string }[];
}

/** Converts a MediaWiki imageinfo page into a candidate (pure; unit-tested with fixtures). */
export function commonsPageToCandidate(
  page: CommonsPage,
  ctx: { provider: string; providerKind: 'official_api'; reliability: number; query: string; identityKind?: ImageCandidate['identityEvidence']['kind']; identityDetail?: string; subjectCategory?: string }
): ImageCandidate | null {
  const info = page.imageinfo?.[0];
  if (!info?.url || !isAcceptedMime(info.mime) || !info.mime) return null;
  const meta = info.extmetadata || {};
  const license = stripHtml(meta.LicenseShortName?.value, 80);
  const categoriesFromMeta = (meta.Categories?.value || '').split('|').map(s => s.trim()).filter(Boolean);
  const categories = Array.from(new Set([...(page.categories || []).map(c => String(c.title || '').replace(/^Category:/, '')), ...categoriesFromMeta])).slice(0, 40);
  const title = String(page.title || '').replace(/^File:/, '');
  const nonFree = isNonFreeFile(meta, categories, license);
  const useThumb = Boolean(info.thumburl && info.width && info.width > 1600);
  let identityEvidence: ImageCandidate['identityEvidence'] = { kind: ctx.identityKind || 'none', detail: ctx.identityDetail };
  if (identityEvidence.kind === 'none' && ctx.subjectCategory) {
    const want = folded(ctx.subjectCategory);
    if (categories.some(c => folded(c) === want)) identityEvidence = { kind: 'commons_category', detail: ctx.subjectCategory };
  }
  return {
    id: candidateId(ctx.provider, info.url),
    provider: ctx.provider,
    providerKind: ctx.providerKind,
    providerReliability: ctx.reliability,
    query: ctx.query,
    title,
    imageUrl: useThumb ? (info.thumburl as string) : info.url,
    pageUrl: info.descriptionurl,
    width: useThumb ? info.thumbwidth : info.width,
    height: useThumb ? info.thumbheight : info.height,
    mime: info.mime,
    license: nonFree ? `Non-free (${license || 'fair use'} on Wikipedia; reuse permission not confirmed)` : license || 'Unknown (check source page)',
    licenseUrl: stripHtml(meta.LicenseUrl?.value, 300),
    licenseKnown: Boolean(license),
    licenseFree: !nonFree && isFreeLicense(license),
    attribution: stripHtml(meta.Artist?.value, 200),
    description: stripHtml(meta.ImageDescription?.value, 400),
    tags: [],
    categories,
    identityEvidence,
    typeHints: [],
    nonFree,
    resultStorage: 'full'
  };
}

export class WikimediaCommonsProvider implements ImageSearchProvider {
  readonly id = 'wikimedia-commons';
  readonly label = 'Wikimedia Commons';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.9;
  readonly supportsEntityMode = true;

  constructor(private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp) {}

  isEnabled(): boolean {
    return this.enabled();
  }

  private async searchFiles(search: string, limit: number, query: string, identityKind?: ImageCandidate['identityEvidence']['kind'], identityDetail?: string, subjectCategory?: string): Promise<ImageCandidate[]> {
    const url = `${COMMONS_API}?${qs({
      action: 'query',
      format: 'json',
      formatversion: 2,
      generator: 'search',
      gsrnamespace: 6,
      gsrsearch: search,
      gsrlimit: Math.min(limit, 30),
      prop: 'imageinfo|categories',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: 1600,
      iiextmetadatafilter: EXT_FILTER,
      clshow: '!hidden',
      cllimit: 'max'
    })}`;
    const data = await this.http.getJson<{ query?: { pages?: CommonsPage[] } }>(url);
    const out: ImageCandidate[] = [];
    for (const p of data?.query?.pages || []) {
      const c = commonsPageToCandidate(p, { provider: this.id, providerKind: this.kind, reliability: this.reliability, query, identityKind, identityDetail, subjectCategory });
      if (c) out.push(c);
    }
    return out;
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode === 'image') return [];
    const category = req.entity?.commonsCategory;
    if (req.mode === 'entity') {
      const results: ImageCandidate[] = [];
      if (req.entity?.qid) {
        results.push(...(await this.searchFiles(`haswbstatement:P180=${req.entity.qid} filetype:bitmap`, req.limit, `depicts:${req.entity.qid}`, 'depicts_statement', req.entity.qid, category)));
      }
      if (category) {
        results.push(...(await this.searchFiles(`incategory:"${category.replace(/"/g, '')}" filetype:bitmap`, req.limit, `category:${category}`, 'commons_category', category, category)));
      }
      return results;
    }
    return this.searchFiles(`${req.query} filetype:bitmap`, req.limit, req.query, undefined, undefined, category);
  }
}

export class WikipediaProvider implements ImageSearchProvider {
  readonly id = 'wikipedia';
  readonly label = 'Wikipedia';
  readonly kind = 'official_api' as const;
  readonly reliability = 0.9;
  readonly supportsEntityMode = false;

  /**
   * @param allowNonFree when true (rights policy allow_copyrighted), lead images that Wikipedia
   *        hosts as non-free (film posters etc.) are returned too, labelled as copyrighted.
   *        The PageImages API hides them by default (pilicense=free).
   */
  constructor(private readonly enabled: () => boolean, private readonly http: ProviderHttp = defaultProviderHttp, private readonly allowNonFree: () => boolean = () => false) {}

  isEnabled(): boolean {
    return this.enabled();
  }

  async search(req: ProviderSearchRequest): Promise<ImageCandidate[]> {
    if (req.mode !== 'text') return [];
    const searchUrl = `${ENWIKI_API}?${qs({
      action: 'query',
      format: 'json',
      formatversion: 2,
      generator: 'search',
      gsrsearch: req.query,
      gsrlimit: 5,
      prop: 'pageimages',
      piprop: 'name',
      pilicense: this.allowNonFree() ? 'any' : 'free'
    })}`;
    const data = await this.http.getJson<{ query?: { pages?: { title?: string; pageimage?: string }[] } }>(searchUrl);
    const pages = (data?.query?.pages || []).filter(p => p.pageimage && p.title);
    if (!pages.length) return [];

    const files = Array.from(new Set(pages.map(p => `File:${p.pageimage}`))).slice(0, 10);
    const infoUrl = `${ENWIKI_API}?${qs({
      action: 'query',
      format: 'json',
      formatversion: 2,
      titles: files.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: 1600,
      iiextmetadatafilter: EXT_FILTER
    })}`;
    const info = await this.http.getJson<{ query?: { pages?: CommonsPage[]; normalized?: { from: string; to: string }[] } }>(infoUrl);
    const byTitle = new Map<string, CommonsPage>();
    for (const p of info?.query?.pages || []) if (p.title) byTitle.set(p.title.replace(/_/g, ' '), p);

    const names = new Set([req.plan.subjectName, ...(req.plan.identity.profile?.aliases || []), req.plan.identity.profile?.professionalName || ''].filter(Boolean).map(folded));
    const film = req.plan.context.movieTitle ? folded(req.plan.context.movieTitle) : null;

    const out: ImageCandidate[] = [];
    for (const page of pages) {
      const filePage = byTitle.get(`File:${String(page.pageimage).replace(/_/g, ' ')}`);
      if (!filePage) continue;
      const articleIsSubject = names.has(folded(String(page.title).replace(/\s*\([^)]*\)\s*$/, '')));
      const articleIsFilm = Boolean(film && folded(String(page.title).replace(/\s*\([^)]*film\)\s*$/i, '')) === film);
      const c = commonsPageToCandidate(filePage, {
        provider: this.id,
        providerKind: this.kind,
        reliability: this.reliability,
        query: req.query,
        identityKind: articleIsSubject ? 'wikipedia_lead_image' : 'none',
        identityDetail: articleIsSubject ? `lead image of the article "${page.title}"` : undefined
      });
      if (!c) continue;
      c.title = `${page.title} (Wikipedia lead image: ${c.title})`;
      if (articleIsFilm) {
        c.typeHints.push('poster');
        c.mediaTitle = page.title;
      }
      out.push(c);
    }
    return out;
  }
}

export interface WikimediaFileRights {
  title?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  nonFree: boolean;
  fileUrl?: string;
  pageUrl?: string;
}

/**
 * Licence metadata of a Wikimedia-hosted file that another provider (web or reverse image search)
 * found, read from the Commons / Wikipedia API itself. Lets a web result be labelled correctly as
 * openly licensed (or non-free) instead of "unknown".
 */
export class WikimediaRightsLookup {
  constructor(private readonly http: ProviderHttp = defaultProviderHttp) {}

  async lookup(imageUrl: string): Promise<WikimediaFileRights | null> {
    const f = wikimediaFileFromUrl(imageUrl);
    if (!f) return null;
    const api = f.wiki === 'commons' ? COMMONS_API : /^[a-z]{2,3}$/.test(f.wiki) ? `https://${f.wiki}.wikipedia.org/w/api.php` : null;
    if (!api) return null;
    const data = await this.http.getJson<{ query?: { pages?: CommonsPage[] } }>(
      `${api}?${qs({ action: 'query', format: 'json', formatversion: 2, titles: `File:${f.file}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiextmetadatafilter: EXT_FILTER })}`
    );
    const page = data?.query?.pages?.[0];
    const info = page?.imageinfo?.[0];
    if (!info) return null;
    const meta = info.extmetadata || {};
    const license = stripHtml(meta.LicenseShortName?.value, 80);
    const categories = (meta.Categories?.value || '').split('|').map(s => s.trim()).filter(Boolean);
    return {
      title: String(page?.title || '').replace(/^File:/, '') || undefined,
      license,
      licenseUrl: stripHtml(meta.LicenseUrl?.value, 300),
      attribution: stripHtml(meta.Artist?.value, 200),
      nonFree: isNonFreeFile(meta, categories, license),
      fileUrl: info.url,
      pageUrl: info.descriptionurl
    };
  }
}

const PERSON_DESC = /(actor|actress|politician|producer|director|singer|cricketer|player|businessman|businesswoman|chief minister|minister|cinematographer|composer|comedian|television|filmmaker|athlete|activist|journalist|entertainer|dancer|model)/i;
const DEITY_DESC = /(deity|god|goddess|hindu|avatar)/i;
const FILM_DESC = /(film|movie)/i;

export interface WikidataSearchResult {
  id: string;
  label?: string;
  description?: string;
  match?: { type?: string; text?: string };
  aliases?: string[];
}

/** Chooses the Wikidata item whose label/alias equals one of the names AND whose description fits. Pure. */
export function chooseWikidataItem(results: WikidataSearchResult[], names: string[], kind: 'person' | 'deity' | 'film' | 'other'): WikidataSearchResult | null {
  const wanted = new Set(names.filter(Boolean).map(folded));
  const descOk = (d?: string) => {
    if (!d) return false;
    if (kind === 'person') return PERSON_DESC.test(d) && !FILM_DESC.test(d.split(' ').slice(0, 2).join(' '));
    if (kind === 'deity') return DEITY_DESC.test(d);
    if (kind === 'film') return FILM_DESC.test(d);
    return true;
  };
  for (const r of results) {
    const labels = [r.label, r.match?.text, ...(r.aliases || [])].filter(Boolean) as string[];
    if (labels.some(l => wanted.has(folded(l))) && descOk(r.description)) return r;
  }
  return null;
}

export class WikidataGrounding {
  private readonly cache = new Map<string, { at: number; value: GroundedEntity | null }>();

  constructor(private readonly http: ProviderHttp = defaultProviderHttp) {}

  async ground(primaryName: string, otherNames: string[], kind: 'person' | 'deity' | 'film' | 'other'): Promise<GroundedEntity | null> {
    const key = `${kind}:${folded(primaryName)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.value;

    const searchUrl = `${WIKIDATA_API}?${qs({ action: 'wbsearchentities', format: 'json', language: 'en', uselang: 'en', type: 'item', limit: 7, search: primaryName })}`;
    const data = await this.http.getJson<{ search?: WikidataSearchResult[] }>(searchUrl);
    const item = chooseWikidataItem(data?.search || [], [primaryName, ...otherNames], kind);
    let value: GroundedEntity | null = null;
    if (item) {
      const entUrl = `${WIKIDATA_API}?${qs({ action: 'wbgetentities', format: 'json', ids: item.id, props: 'claims' })}`;
      const ent = await this.http.getJson<{ entities?: Record<string, { claims?: Record<string, { mainsnak?: { datavalue?: { value?: any } } }[]> }> }>(entUrl);
      const claims = ent?.entities?.[item.id]?.claims || {};
      const claim = (p: string) => claims[p]?.[0]?.mainsnak?.datavalue?.value;
      const instanceOf = (claims.P31 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      if (kind === 'person' && instanceOf.length && !instanceOf.includes('Q5')) {
        value = null; // not a human: do not ground a person on it
      } else {
        value = {
          qid: item.id,
          label: item.label,
          description: item.description,
          commonsCategory: typeof claim('P373') === 'string' ? claim('P373') : undefined,
          imageFile: typeof claim('P18') === 'string' ? claim('P18') : undefined
        };
      }
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
