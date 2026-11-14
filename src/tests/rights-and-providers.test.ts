/**
 * Rights policy, paid search providers and reference matching (all OFFLINE / MOCKED: no network,
 * no API keys, no vision CLI).
 *  - rights classification of licences, the rights policy, provider-terms storage rules;
 *  - Brave Image Search and Google Cloud Vision reverse image search: request building (keys only in
 *    headers), response mapping, strict identity rules, monthly usage caps;
 *  - the discovery engine: copyrighted images allowed by default and labelled, open-licence-only
 *    mode, transient results never stored, exact picture / same scene preferred among verified
 *    candidates, clean pictures before watermarked ones, reverse search with the reference crop,
 *    Wikimedia licence enrichment;
 *  - safeFetch POST support.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { createCanvas } from '@napi-rs/canvas';
import { classifyLicense, rightsAllowed, wikimediaFileFromUrl } from '../discovery/rights';
import { isFreeLicense, ProviderHttp } from '../discovery/providers/provider-http';
import { openverseToCandidates, TmdbProvider } from '../discovery/providers/web.providers';
import { commonsPageToCandidate } from '../discovery/providers/wikimedia.providers';
import { BRAVE_IMAGES_ENDPOINT, BraveImageProvider, braveToCandidates } from '../discovery/providers/brave.provider';
import { GoogleVisionWebProvider, VISION_ANNOTATE_ENDPOINT, webDetectionToCandidates } from '../discovery/providers/vision-web.provider';
import { InMemoryProviderUsageStore, ProviderLimitError, UsageGuard } from '../discovery/provider-usage';
import { DiscoveryEngine, referenceMatchOf, selectionOrder } from '../discovery/discovery-engine';
import { scoreCandidate, urlKey } from '../discovery/candidate-ranker';
import { buildVerificationPrompt, isVisuallyAccepted, parseVerification, VerificationItem, VisualVerifier } from '../discovery/visual-verifier';
import { EvaluatedCandidate, ImageCandidate, ImageSearchProvider, ProviderSearchRequest, SlotDiscoveryPlan, VisualVerdict } from '../discovery/discovery.types';
import { resolveSlotIdentity } from '../identity/slot-identity';
import { describeConfig, loadConfig } from '../config/app-config';
import { safeFetch, SafeFetchError } from '../security/safe-fetch';

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------
function makePlan(name: string, over: Partial<SlotDiscoveryPlan> = {}): SlotDiscoveryPlan {
  const identity = resolveSlotIdentity({ aiIdentifiedName: name, aiEvidence: 'text_and_visual', aiConfidence: 0.95 });
  assert.equal(identity.status, 'resolved', `fixture identity for ${name}`);
  return {
    slotId: 's1',
    index: 0,
    identity,
    subjectName: identity.searchName as string,
    subjectKind: 'person',
    desiredImageType: 'portrait',
    context: { movieTitle: null, eventName: null, otherContext: null, evidence: 'none', characterName: null },
    label: null,
    visualPurpose: 'subject',
    visualCharacteristics: [],
    orientation: 'portrait',
    targetWidth: 540,
    targetHeight: 700,
    aiSearchTerms: [],
    groundingText: name,
    ...over
  };
}

function cand(title: string, over: Partial<ImageCandidate> = {}): ImageCandidate {
  const url = over.imageUrl || `https://img.test/${encodeURIComponent(title)}.jpg`;
  return {
    id: `t:${url}`,
    provider: 'fake',
    providerKind: 'official_api',
    providerReliability: 0.9,
    query: 'q',
    title,
    imageUrl: url,
    width: 1200,
    height: 1600,
    licenseKnown: true,
    licenseFree: true,
    license: 'CC BY 4.0',
    tags: [],
    categories: [],
    identityEvidence: { kind: 'none' },
    typeHints: [],
    ...over
  };
}

const fullVerdict = (o: Partial<VisualVerdict> = {}): VisualVerdict => ({
  verdict: 'accept',
  confidence: 0.9,
  showsIntendedSubject: 'yes',
  matchesReferencePerson: 'yes',
  imageType: 'portrait',
  matchesRequestedType: 'yes',
  matchesContext: 'not_applicable',
  isCollageOrMeme: false,
  hasOverlaidText: false,
  suitability: 0.8,
  reason: 'ok',
  ...o
});

function fakeHttp(json: unknown) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const h: ProviderHttp & { calls: typeof calls } = {
    calls,
    async getJson(url, opts) {
      calls.push({ method: 'GET', url, headers: opts?.headers || {} });
      return json as any;
    },
    async getText(url, opts) {
      calls.push({ method: 'GET', url, headers: opts?.headers || {} });
      return '';
    },
    async postJson(url, body, opts) {
      calls.push({ method: 'POST', url, headers: opts?.headers || {}, body });
      return json as any;
    }
  };
  return h;
}

// ------------------------------------------------------------------------------------------------
describe('rights classification (offline)', () => {
  it('open licences, with their conditions', () => {
    assert.deepEqual(classifyLicense('CC BY-SA 4.0'), { classification: 'open_license', attributionRequired: true, shareAlike: true });
    assert.deepEqual(classifyLicense('CC BY 4.0'), { classification: 'open_license', attributionRequired: true, shareAlike: false });
    for (const l of ['CC0', 'CC0 1.0', 'Public domain', 'PDM 1.0', 'No restrictions', 'Copyrighted free use']) {
      assert.equal(classifyLicense(l).classification, 'open_license', l);
      assert.equal(classifyLicense(l).attributionRequired, false, l);
    }
    assert.equal(classifyLicense('GODL-India').classification, 'open_license');
    assert.equal(classifyLicense('GFDL').shareAlike, true);
    assert.equal(classifyLicense('Creative Commons Attribution-Share Alike 3.0').shareAlike, true);
  });

  it('NonCommercial and NoDerivatives licences do not cover this use', () => {
    for (const l of ['CC BY-NC 2.0', 'CC BY-NC-SA 2.0', 'CC BY-NC-ND 4.0']) {
      const c = classifyLicense(l);
      assert.equal(c.classification, 'open_license_restricted', l);
      assert.match(c.restriction as string, /NonCommercial/);
    }
    assert.match(classifyLicense('CC BY-ND 4.0').restriction as string, /NoDerivatives/);
    assert.equal(isFreeLicense('CC BY-NC 2.0'), false, 'NC is no longer counted as free');
    const ov = openverseToCandidates([{ title: 't', url: 'https://live.staticflickr.com/1/2.jpg', license: 'by-nc', license_version: '2.0', filetype: 'jpg' }], 'q', 0.75);
    assert.equal(ov[0].licenseFree, false);
  });

  it('everything else is copyrighted, permission not confirmed (conservative)', () => {
    for (const l of [undefined, '', 'Fair use', 'Unknown (web image; check the source page before reuse)', 'TMDB image (rights belong to the studio)', 'All rights reserved', 'Some custom licence']) {
      assert.equal(classifyLicense(l).classification, 'copyrighted_unconfirmed', String(l));
    }
    assert.equal(classifyLicense('CC BY-SA 4.0', { nonFree: true }).classification, 'copyrighted_unconfirmed', 'a non-free flag wins');
  });

  it('rights policy', () => {
    assert.equal(rightsAllowed('allow_copyrighted', 'copyrighted_unconfirmed'), true);
    assert.equal(rightsAllowed('allow_copyrighted', 'open_license_restricted'), true);
    assert.equal(rightsAllowed('open_license_only', 'copyrighted_unconfirmed'), false);
    assert.equal(rightsAllowed('open_license_only', 'open_license_restricted'), false);
    assert.equal(rightsAllowed('open_license_only', 'open_license'), true);
  });

  it('Wikimedia upload URLs are recognised (Commons and local Wikipedia files)', () => {
    assert.deepEqual(wikimediaFileFromUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pawan_Kalyan.jpg/800px-Pawan_Kalyan.jpg'), { wiki: 'commons', file: 'Pawan_Kalyan.jpg' });
    assert.deepEqual(wikimediaFileFromUrl('https://upload.wikimedia.org/wikipedia/en/0/0c/OG_Poster.jpg?utm_source=x'), { wiki: 'en', file: 'OG_Poster.jpg' });
    assert.deepEqual(wikimediaFileFromUrl('https://thumb.wikimedia.org/wikipedia/commons/thumb/2/24/Naga_Chaitanya_%28cropped%29.jpg/1920px-Naga_Chaitanya_%28cropped%29.jpg?utm_source=x'), { wiki: 'commons', file: 'Naga_Chaitanya_(cropped).jpg' });
    assert.equal(wikimediaFileFromUrl('https://example.com/wikipedia/commons/a/ab/x.jpg'), null);
    assert.equal(urlKey('https://thumb.wikimedia.org/wikipedia/commons/thumb/2/24/X.jpg/1920px-X.jpg'), urlKey('https://upload.wikimedia.org/wikipedia/commons/2/24/X.jpg'), 'new thumbnail host = same file');
  });

  it('Wikipedia fair-use files are marked non-free and labelled copyrighted', () => {
    const c = commonsPageToCandidate(
      {
        title: 'File:OG Poster.jpg',
        imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/en/0/0c/OG_Poster.jpg', descriptionurl: 'https://en.wikipedia.org/wiki/File:OG_Poster.jpg', width: 250, height: 375, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'Fair use' }, Categories: { value: 'All non-free media|Film posters for Telugu-language films' } } }]
      },
      { provider: 'wikipedia', providerKind: 'official_api', reliability: 0.9, query: 'q' }
    );
    assert.ok(c);
    assert.equal(c!.nonFree, true);
    assert.equal(c!.licenseFree, false);
    assert.match(c!.license as string, /Non-free/);
  });
});

// ------------------------------------------------------------------------------------------------
describe('configuration of the rights policy and paid providers', () => {
  it('defaults: copyrighted allowed, paid providers off without keys, caps = free allowances', () => {
    const d = loadConfig({}).discovery;
    assert.equal(d.rightsPolicy, 'allow_copyrighted');
    assert.equal(d.braveMonthlyLimit, 1000);
    assert.equal(d.googleVisionMonthlyLimit, 1000);
    assert.equal(d.braveCountry, 'IN');
    assert.equal(d.tmdbCommercialAgreement, false);
    assert.ok(!d.enabledProviders.includes('brave-images') && !d.enabledProviders.includes('google-vision-web'));
  });

  it('keys enable the providers; options are validated; keys never appear in the log view', () => {
    const cfg = loadConfig({ BRAVE_SEARCH_API_KEY: 'brave-secret-123', GOOGLE_CLOUD_VISION_API_KEY: 'vision-secret-456', DISCOVERY_RIGHTS_POLICY: 'open_license_only', BRAVE_SEARCH_COUNTRY: 'not a country', BRAVE_MONTHLY_REQUEST_LIMIT: '50' });
    assert.ok(cfg.discovery.enabledProviders.includes('brave-images'));
    assert.ok(cfg.discovery.enabledProviders.includes('google-vision-web'));
    assert.equal(cfg.discovery.rightsPolicy, 'open_license_only');
    assert.equal(cfg.discovery.braveCountry, 'IN');
    assert.equal(cfg.discovery.braveMonthlyLimit, 50);
    const shown = JSON.stringify(describeConfig(cfg));
    assert.ok(!shown.includes('brave-secret-123') && !shown.includes('vision-secret-456'));
    assert.match(shown, /"braveKeyConfigured":true/);
  });
});

// ------------------------------------------------------------------------------------------------
describe('monthly usage caps of paid providers', () => {
  it('in-memory store: allows up to the limit, resets in a new month, limit 0 means never', async () => {
    let now = new Date('2026-11-14T10:00:00Z');
    const store = new InMemoryProviderUsageStore(() => now);
    for (let i = 0; i < 3; i++) assert.equal((await store.consume('p', 3)).allowed, true);
    assert.equal((await store.consume('p', 3)).allowed, false);
    now = new Date('2026-12-01T00:00:01Z');
    assert.equal((await store.consume('p', 3)).allowed, true, 'new month');
    assert.equal((await store.consume('q', 0)).allowed, false);
  });

  it('guard: blocks for the rest of the month and names the setting to raise', async () => {
    const g = new UsageGuard(new InMemoryProviderUsageStore(), 'brave-images', () => 1, 'Brave Image Search', 'BRAVE_MONTHLY_REQUEST_LIMIT');
    await g.consume();
    assert.equal(g.isBlocked(), false);
    await assert.rejects(() => g.consume(), (e: any) => e instanceof ProviderLimitError && /BRAVE_MONTHLY_REQUEST_LIMIT/.test(e.message));
    assert.equal(g.isBlocked(), true);
  });

  it('guard fails closed when the counter cannot be read', async () => {
    const broken = { consume: async () => { throw new Error('db down'); }, current: async () => ({ used: 0, month: '2026-11' }) };
    const g = new UsageGuard(broken, 'google-vision-web', () => 1000, 'Vision', 'GOOGLE_VISION_MONTHLY_UNIT_LIMIT');
    await assert.rejects(() => g.consume(), (e: any) => e instanceof ProviderLimitError && /not called/.test(e.message));
  });
});

// ------------------------------------------------------------------------------------------------
describe('Brave Image Search provider (mocked HTTP)', () => {
  const results = [
    { type: 'image_result', title: 'Pawan Kalyan OG first look still', url: 'https://news.test/og-first-look', source: 'news.test', thumbnail: { src: 'https://imgs.search.brave.com/thumb.jpg' }, properties: { url: 'https://news.test/images/og-still.jpg', width: 1920, height: 1080 }, meta_url: { hostname: 'news.test' } },
    { type: 'image_result', title: 'no original', url: 'https://x.test/p', thumbnail: { src: 'https://imgs.search.brave.com/t2.jpg' } },
    { type: 'image_result', title: 'vector', url: 'https://x.test/v', properties: { url: 'https://x.test/logo.svg' } }
  ];

  it('maps only original images (never Brave thumbnails), as transient, unknown-licence results', () => {
    const c = braveToCandidates(results, 'q', 0.7);
    assert.equal(c.length, 1);
    assert.equal(c[0].imageUrl, 'https://news.test/images/og-still.jpg');
    assert.equal(c[0].pageUrl, 'https://news.test/og-first-look');
    assert.equal(c[0].width, 1920);
    assert.equal(c[0].resultStorage, 'transient');
    assert.equal(classifyLicense(c[0].license).classification, 'copyrighted_unconfirmed');
    assert.ok(!JSON.stringify(c).includes('imgs.search.brave.com'));
  });

  it('sends the key only in a header, counts every request, stops at the monthly cap', async () => {
    const h = fakeHttp({ results });
    const guard = new UsageGuard(new InMemoryProviderUsageStore(), 'brave-images', () => 2, 'Brave Image Search', 'BRAVE_MONTHLY_REQUEST_LIMIT');
    const p = new BraveImageProvider(() => ({ apiKey: 'brave-secret-123', country: 'IN' }), () => true, guard, h);
    const req: ProviderSearchRequest = { query: 'Pawan Kalyan They Call Him OG movie still', plan: makePlan('Pawan Kalyan'), limit: 25, mode: 'text' };
    assert.equal((await p.search(req)).length, 1);
    const call = h.calls[0];
    assert.ok(call.url.startsWith(`${BRAVE_IMAGES_ENDPOINT}?`));
    assert.ok(!call.url.includes('brave-secret-123'), 'the key is never in a URL');
    assert.equal(call.headers['X-Subscription-Token'], 'brave-secret-123');
    const u = new URL(call.url);
    assert.equal(u.searchParams.get('country'), 'IN');
    assert.equal(u.searchParams.get('safesearch'), 'strict');
    assert.equal(u.searchParams.get('count'), '50');
    await p.search(req);
    await assert.rejects(() => p.search(req), ProviderLimitError);
    assert.equal(h.calls.length, 2, 'no request is sent once the cap is reached');
    assert.equal(p.isEnabled(), false);
    assert.deepEqual(await p.search({ ...req, mode: 'image', image: Buffer.from('x') }), [], 'text-only provider');
  });

  it('is off without a key, and a rejected key disables it', async () => {
    const guard = new UsageGuard(new InMemoryProviderUsageStore(), 'brave-images', () => 10, 'Brave', 'X');
    assert.equal(new BraveImageProvider(() => ({ country: 'IN' }), () => true, guard, fakeHttp({})).isEnabled(), false);
    const failing: ProviderHttp = { ...fakeHttp({}), getJson: async () => { throw new SafeFetchError('HTTP_ERROR', 'HTTP 401', 401); } };
    const p = new BraveImageProvider(() => ({ apiKey: 'k', country: 'IN' }), () => true, guard, failing);
    await assert.rejects(() => p.search({ query: 'x', plan: makePlan('Pawan Kalyan'), limit: 5, mode: 'text' }));
    assert.equal(p.isEnabled(), false);
  });
});

// ------------------------------------------------------------------------------------------------
describe('Google Cloud Vision reverse image search (mocked HTTP)', () => {
  const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'They Call Him OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: null } });
  const wd = (entities: { description: string; score: number }[]) => ({
    webEntities: entities,
    bestGuessLabels: [{ label: 'pawan kalyan og movie' }],
    fullMatchingImages: [{ url: 'https://studio.test/og-still-hd.jpg' }],
    partialMatchingImages: [{ url: 'https://fan.test/og-crop.jpg' }],
    pagesWithMatchingImages: [{ url: 'https://studio.test/gallery', pageTitle: '<b>They Call Him OG</b> working stills', fullMatchingImages: [{ url: 'https://studio.test/og-still-hd.jpg' }] }],
    visuallySimilarImages: [{ url: 'https://other.test/similar.jpg' }]
  });

  it('maps exact and partial matches; similar images (no text to check identity) are not used', () => {
    const c = webDetectionToCandidates(wd([{ description: 'Pawan Kalyan', score: 0.92 }, { description: 'They Call Him OG', score: 0.7 }]), { query: '', plan, limit: 20, mode: 'image' }, 0.8);
    assert.deepEqual(c.map(x => [x.imageUrl, x.reverseMatch]), [['https://studio.test/og-still-hd.jpg', 'full'], ['https://fan.test/og-crop.jpg', 'partial']]);
    assert.equal(c[0].title, 'They Call Him OG working stills');
    assert.equal(c[0].pageUrl, 'https://studio.test/gallery');
    assert.equal(c[0].identityEvidence.kind, 'reverse_image_match', 'same picture + Google names the subject');
    assert.ok(c[0].contextHints?.includes('They Call Him OG'));
    assert.deepEqual(c[0].tags, [], 'entity names are context hints, never identity text');
    assert.equal(c[0].description, undefined);
  });

  it('no structured identity unless a top web entity names the subject with a real score', () => {
    for (const ents of [[{ description: 'Chiranjeevi', score: 0.95 }], [{ description: 'Pawan Kalyan', score: 0.2 }], [{ description: 'Pawan', score: 0.9 }]]) {
      const c = webDetectionToCandidates(wd(ents), { query: '', plan, limit: 20, mode: 'image' }, 0.8);
      assert.ok(c.every(x => x.identityEvidence.kind === 'none'), JSON.stringify(ents));
    }
    // a match with no page title and no confirmation fails the identity threshold (never downloaded)
    const bare = webDetectionToCandidates({ fullMatchingImages: [{ url: 'https://x.test/a.jpg' }], webEntities: [{ description: 'Pawan Kalyan', score: 0.1 }] }, { query: '', plan, limit: 20, mode: 'image' }, 0.8);
    assert.ok(scoreCandidate(bare[0], plan).identity < 70);
    // the same picture with confirmation reaches structured identity
    const ok = webDetectionToCandidates(wd([{ description: 'Pawan Kalyan', score: 0.9 }]), { query: '', plan, limit: 20, mode: 'image' }, 0.8);
    const s = scoreCandidate(ok[0], plan);
    assert.equal(s.identity, 95);
    assert.equal(s.context, 100, 'the film named by Google counts as context');
    assert.equal(s.reference, 100);
  });

  it('request: image content + WEB_DETECTION, key only in the X-Goog-Api-Key header; errors surface', async () => {
    const h = fakeHttp({ responses: [{ webDetection: wd([{ description: 'Pawan Kalyan', score: 0.9 }]) }] });
    const guard = new UsageGuard(new InMemoryProviderUsageStore(), 'google-vision-web', () => 5, 'Vision', 'GOOGLE_VISION_MONTHLY_UNIT_LIMIT');
    const p = new GoogleVisionWebProvider(() => 'vision-secret-456', () => true, guard, h);
    assert.deepEqual(await p.search({ query: 'x', plan, limit: 20, mode: 'text' }), [], 'image-only provider');
    const out = await p.search({ query: 'x', plan, limit: 20, mode: 'image', image: Buffer.from('jpegbytes') });
    assert.equal(out.length, 2);
    const call = h.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, VISION_ANNOTATE_ENDPOINT);
    assert.equal(call.headers['X-Goog-Api-Key'], 'vision-secret-456');
    assert.ok(!call.url.includes('vision-secret-456'));
    const body = call.body as any;
    assert.equal(body.requests[0].image.content, Buffer.from('jpegbytes').toString('base64'));
    assert.equal(body.requests[0].features[0].type, 'WEB_DETECTION');
    const errHttp = fakeHttp({ responses: [{ error: { code: 7, message: 'PERMISSION_DENIED' } }] });
    const p2 = new GoogleVisionWebProvider(() => 'k', () => true, guard, errHttp);
    await assert.rejects(() => p2.search({ query: 'x', plan, limit: 20, mode: 'image', image: Buffer.from('x') }), /PERMISSION_DENIED/);
  });
});

// ------------------------------------------------------------------------------------------------
describe('TMDB requires a written agreement (its standard terms forbid AI-based and derivative use)', () => {
  it('a key alone never enables it', () => {
    assert.equal(new TmdbProvider(() => ({ apiKey: 'k' }), () => true, fakeHttp({})).isEnabled(), false);
    assert.equal(new TmdbProvider(() => ({ apiKey: 'k', agreement: true }), () => true, fakeHttp({})).isEnabled(), true);
  });
});

// ------------------------------------------------------------------------------------------------
describe('verifier: reference match is reported but never decides acceptance', () => {
  const letters = [{ letter: 'A', code: 'ACDEFH', id: 'a' }];
  it('parsed when the reference was seen, not_applicable otherwise, uncertain when invalid', () => {
    const seen = parseVerification({ referenceCode: 'KMNPRT', candidates: [{ code: 'ACDEFH', verdict: 'accept', referenceMatch: 'same_picture' }] }, letters, 'KMNPRT');
    assert.equal(seen.get('a')?.referenceMatch, 'same_picture');
    const unseen = parseVerification({ referenceCode: null, candidates: [{ code: 'ACDEFH', verdict: 'accept', referenceMatch: 'same_picture' }] }, letters, 'KMNPRT');
    assert.equal(unseen.get('a')?.referenceMatch, 'not_applicable');
    const invalid = parseVerification({ referenceCode: 'KMNPRT', candidates: [{ code: 'ACDEFH', verdict: 'accept', referenceMatch: 'identical!!' }] }, letters, 'KMNPRT');
    assert.equal(invalid.get('a')?.referenceMatch, 'uncertain');
  });

  it('prompt asks for it as a preference; acceptance rules are unchanged', () => {
    const plan = makePlan('Pawan Kalyan');
    const prompt = buildVerificationPrompt(plan, true, [{ letter: 'A', item: { id: 'a', path: 'x', title: 't', provider: 'p', identityEvidence: 'none' } }]);
    assert.match(prompt, /referenceMatch/);
    assert.match(prompt, /never a reason to accept/);
    assert.equal(isVisuallyAccepted(fullVerdict({ referenceMatch: 'same_picture', showsIntendedSubject: 'uncertain' }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(fullVerdict({ referenceMatch: 'same_picture', matchesReferencePerson: 'no' }), plan, false).ok, false);
  });
});

// ------------------------------------------------------------------------------------------------
describe('selection helpers', () => {
  const ev = (over: Partial<EvaluatedCandidate>, verdict: Partial<VisualVerdict> = {}, c: Partial<ImageCandidate> = {}): EvaluatedCandidate => ({
    candidate: cand('Pawan Kalyan portrait', c),
    score: scoreCandidate(cand('Pawan Kalyan portrait', c), makePlan('Pawan Kalyan')),
    stage: 'verified',
    visual: fullVerdict(verdict),
    ...over
  });

  it('reference match from the vision verdict, reverse search and the picture hash', () => {
    assert.equal(referenceMatchOf(ev({}, { referenceMatch: 'same_scene' }), true).level, 'same_scene');
    assert.equal(referenceMatchOf(ev({}, { referenceMatch: 'different' }, { reverseMatch: 'full' }), true).level, 'same_picture');
    assert.equal(referenceMatchOf(ev({ referenceHashDistance: 3 }), true).level, 'same_picture');
    assert.equal(referenceMatchOf(ev({ referenceHashDistance: 30 }, { referenceMatch: 'different' }), true).level, 'different');
    assert.equal(referenceMatchOf(ev({}), false).level, 'unknown');
  });

  it('clean before watermarked (except posters), then exact picture, then score', () => {
    const exactWatermarked = ev({ finalScore: 90, referenceMatch: { level: 'same_picture', evidence: [] } }, { hasOverlaidText: true });
    const sceneClean = ev({ finalScore: 70, referenceMatch: { level: 'same_scene', evidence: [] } });
    const different = ev({ finalScore: 99, referenceMatch: { level: 'different', evidence: [] } });
    const exactClean = ev({ finalScore: 60, referenceMatch: { level: 'same_picture', evidence: [] } });
    const sorted = [different, exactWatermarked, sceneClean, exactClean].sort((a, b) => selectionOrder(a, b, false));
    assert.deepEqual(sorted.map(s => s.finalScore), [60, 70, 99, 90]);
    const posters = [sceneClean, exactWatermarked].sort((a, b) => selectionOrder(a, b, true));
    assert.equal(posters[0], exactWatermarked, 'title text is normal on posters');
  });

  it('licence never changes the ranking score', () => {
    const plan = makePlan('Pawan Kalyan');
    const open = scoreCandidate(cand('Pawan Kalyan portrait'), plan);
    const copyrighted = scoreCandidate(cand('Pawan Kalyan portrait', { license: 'Unknown', licenseKnown: false, licenseFree: false }), plan);
    assert.equal(open.total, copyrighted.total);
    const exact = scoreCandidate(cand('Pawan Kalyan portrait', { reverseMatch: 'full' }), plan);
    assert.ok(exact.total > open.total);
  });
});

// ------------------------------------------------------------------------------------------------
describe('DiscoveryEngine with the rights policy (mocked providers, downloads and verifier)', () => {
  let tmp: string;
  const images = new Map<string, Buffer>();

  function picture(seed: number, w = 900, h = 1200): Buffer {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgb(${(i * 37 + seed * 71) % 256},${(i * 91 + seed * 13) % 256},${(i * 53 + seed * 29) % 256})`;
      ctx.fillRect((i * 97 + seed * 31) % w, (i * 61 + seed * 17) % h, 90 + (seed % 5) * 10, 90);
    }
    return c.toBuffer('image/jpeg');
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rights-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const cfg = () => ({ ...loadConfig({}).discovery, maxRounds: 1, shortlistSize: 4, requestTimeoutMs: 500, downloadTimeoutMs: 500, slotTimeoutMs: 20_000 });

  function provider(id: string, byReq: (req: ProviderSearchRequest) => ImageCandidate[], opts: Partial<ImageSearchProvider> = {}): ImageSearchProvider & { reqs: ProviderSearchRequest[] } {
    const reqs: ProviderSearchRequest[] = [];
    return {
      id,
      label: id,
      kind: 'official_api',
      reliability: 0.9,
      supportsEntityMode: false,
      isEnabled: () => true,
      reqs,
      async search(req) {
        reqs.push(req);
        return byReq(req);
      },
      ...opts
    } as ImageSearchProvider & { reqs: ProviderSearchRequest[] };
  }

  function verifier(decide: (item: VerificationItem) => Partial<VisualVerdict> | null): VisualVerifier & { items: string[] } {
    const v = {
      items: [] as string[],
      async verify(_plan: SlotDiscoveryPlan, _ref: string | null, items: VerificationItem[]) {
        const verdicts = new Map<string, VisualVerdict>();
        for (const it of items) {
          v.items.push(it.id);
          const d = decide(it);
          if (d) verdicts.set(it.id, fullVerdict(d));
        }
        return { verdicts, calls: [] };
      }
    };
    return v;
  }

  function engine(providers: ImageSearchProvider[], ver: VisualVerifier | null, over: Partial<ReturnType<typeof cfg>> = {}, rightsLookup: any = null) {
    const downloads: string[] = [];
    const e = new DiscoveryEngine({
      providers,
      grounding: null,
      verifier: ver,
      download: async url => {
        downloads.push(url);
        const b = images.get(url);
        if (!b) throw new Error('HTTP 404');
        return b;
      },
      config: { ...cfg(), ...over },
      verifyMode: 'required',
      storageDir: tmp,
      rightsLookup
    });
    return { e, downloads };
  }

  it('default policy: a copyrighted image can be used and is clearly labelled', async () => {
    images.set('https://web.test/pk-still.jpg', picture(31));
    const p = provider('fake-web', () => [cand('Pawan Kalyan portrait', { provider: 'fake-web', imageUrl: 'https://web.test/pk-still.jpg', license: 'Unknown (web image)', licenseKnown: false, licenseFree: false })]);
    const { e } = engine([p], verifier(() => ({})));
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].rights?.classification, 'copyrighted_unconfirmed');
    assert.equal(r.assets[0].rights?.label, 'Copyrighted: reuse permission not confirmed');
    assert.equal(r.assets[0].provider, 'fake-web');
    assert.equal(r.assets[0].sourceUrl, 'https://web.test/pk-still.jpg', 'storable provider: source kept');
    assert.equal(r.reports[0].selected?.rights.classification, 'copyrighted_unconfirmed');
    assert.equal(r.reports[0].rightsPolicy, 'allow_copyrighted');
    fs.unlinkSync(r.assets[0].path);
  });

  it('open_license_only: copyrighted candidates are rejected with a clear reason, open ones used', async () => {
    images.set('https://web.test/pk-web.jpg', picture(32));
    images.set('https://commons.test/pk-open.jpg', picture(33));
    const p = provider('fake-web', () => [
      cand('Pawan Kalyan portrait', { imageUrl: 'https://web.test/pk-web.jpg', license: 'Unknown', licenseKnown: false, licenseFree: false, providerReliability: 0.99 }),
      cand('Pawan Kalyan official photo', { imageUrl: 'https://commons.test/pk-open.jpg', license: 'CC BY-SA 4.0' })
    ]);
    const { e, downloads } = engine([p], verifier(() => ({})), { rightsPolicy: 'open_license_only' });
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://commons.test/pk-open.jpg');
    assert.equal(r.assets[0].rights?.classification, 'open_license');
    assert.equal(r.assets[0].rights?.shareAlike, true);
    assert.ok(!downloads.includes('https://web.test/pk-web.jpg'), 'never downloaded');
    assert.ok(r.reports[0].rejected.some(x => /rights policy/.test(x.reason || '')));
    fs.unlinkSync(r.assets[0].path);
  });

  it('transient-only providers: used for the search, but no title or URL is stored anywhere', async () => {
    images.set('https://site-a.test/secret-path-1.jpg', picture(34));
    images.set('https://site-b.test/secret-path-2.jpg', picture(35));
    images.set('https://site-c.test/secret-path-3.jpg', picture(36));
    const p = provider(
      'brave-like',
      () => [
        cand('Pawan Kalyan portrait SECRET-TITLE-1', { imageUrl: 'https://site-a.test/secret-path-1.jpg', pageUrl: 'https://site-a.test/page-1', attribution: 'site-a.test', license: 'Unknown', licenseKnown: false, licenseFree: false }),
        cand('Pawan Kalyan photo SECRET-TITLE-2', { imageUrl: 'https://site-b.test/secret-path-2.jpg', pageUrl: 'https://site-b.test/page-2', license: 'Unknown', licenseKnown: false, licenseFree: false }),
        cand('Pawan Singh SECRET-TITLE-3', { imageUrl: 'https://site-c.test/secret-path-3.jpg', license: 'Unknown', licenseKnown: false, licenseFree: false })
      ],
      { resultStorage: 'transient', label: 'Brave-like search' }
    );
    const { e } = engine([p], verifier(() => ({})));
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    const a = r.assets[0];
    assert.equal(a.sourceUrl, undefined);
    assert.equal(a.sourcePage, undefined);
    assert.equal(a.attribution, undefined);
    assert.ok(!/SECRET/.test(a.originalName));
    assert.equal(a.rights?.sourceStored, false);
    assert.match(a.rights?.storageNote || '', /temporary storage/);
    const persisted = JSON.stringify({ reports: r.reports, assets: r.assets.map(x => ({ ...x, path: undefined })) });
    assert.ok(!/SECRET|site-a\.test|site-b\.test|site-c\.test/.test(persisted), persisted.slice(0, 400));
    assert.equal(r.reports[0].alternates.length, 0, 'alternates need a stored URL');
    assert.ok((r.reports[0].notes || []).some(n => /not stored/.test(n)));
    assert.ok((r.reports[0].notes || []).some(n => /alternate/.test(n)));
    fs.unlinkSync(a.path);
  });

  it('prefers the exact picture over a higher-scoring different picture (both verified)', async () => {
    images.set('https://img.test/exact.jpg', picture(37));
    images.set('https://img.test/other.jpg', picture(38));
    const p = provider('fake', () => [
      cand('Pawan Kalyan photo', { imageUrl: 'https://img.test/exact.jpg', providerReliability: 0.5 }),
      cand('Pawan Kalyan official portrait', { imageUrl: 'https://img.test/other.jpg', providerReliability: 0.99 })
    ]);
    const v = verifier(it => (it.path && it.title.includes('photo') ? { referenceMatch: 'same_picture', suitability: 0.6 } : { referenceMatch: 'different', suitability: 0.95 }));
    const { e } = engine([p], v);
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/exact.jpg');
    assert.equal(r.assets[0].referenceMatch, 'same_picture');
    assert.equal(r.reports[0].selected?.referenceMatch.level, 'same_picture');
    fs.unlinkSync(r.assets[0].path);
  });

  it('a clean picture wins over a watermarked copy, and a watermark-only result is flagged', async () => {
    images.set('https://img.test/wm.jpg', picture(39));
    images.set('https://img.test/clean.jpg', picture(40));
    const p = provider('fake', () => [
      cand('Pawan Kalyan portrait watermark', { imageUrl: 'https://img.test/wm.jpg' }),
      cand('Pawan Kalyan portrait clean', { imageUrl: 'https://img.test/clean.jpg' })
    ]);
    const v = verifier(it => (it.title.includes('watermark') ? { hasOverlaidText: true, referenceMatch: 'same_picture' } : { referenceMatch: 'same_scene' }));
    const { e } = engine([p], v);
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/clean.jpg');
    fs.unlinkSync(r.assets[0].path);

    const only = provider('fake', () => [cand('Pawan Kalyan portrait watermark', { imageUrl: 'https://img.test/wm.jpg' })]);
    const r2 = await engine([only], verifier(() => ({ hasOverlaidText: true }))).e.run([makePlan('Pawan Kalyan')], null);
    assert.ok(r2.reports[0].warnings.some(w => /watermark/.test(w)));
    fs.unlinkSync(r2.assets[0].path);
  });

  it('reverse image search gets the slot crop; its exact match is verified first and recorded', async () => {
    // reference: the subject picture occupies the top-left quarter of a 1080x1350 screenshot
    const subject = picture(41, 540, 675);
    const ref = createCanvas(1080, 1350);
    const rctx = ref.getContext('2d');
    rctx.fillStyle = '#123456';
    rctx.fillRect(0, 0, 1080, 1350);
    const { loadImage } = await import('@napi-rs/canvas');
    rctx.drawImage(await loadImage(subject), 0, 0, 540, 675);
    const refPath = path.join(tmp, 'reference.jpg');
    fs.writeFileSync(refPath, ref.toBuffer('image/jpeg'));
    // the same picture at twice the size (what a reverse image search finds at the source)
    const hd = createCanvas(1080, 1350);
    hd.getContext('2d').drawImage(await loadImage(subject), 0, 0, 1080, 1350);
    images.set('https://studio.test/og-hd.jpg', hd.toBuffer('image/jpeg'));
    images.set('https://img.test/text-result.jpg', picture(42));

    const reverse = provider(
      'google-vision-web',
      req => (req.mode === 'image' ? [cand('They Call Him OG working stills', { imageUrl: 'https://studio.test/og-hd.jpg', reverseMatch: 'full', identityEvidence: { kind: 'reverse_image_match', detail: 'test' }, license: 'Unknown', licenseKnown: false, licenseFree: false })] : []),
      { capability: 'image' }
    );
    const text = provider('fake', () => [cand('Pawan Kalyan official portrait', { imageUrl: 'https://img.test/text-result.jpg', providerReliability: 0.99 })]);
    const v = verifier(() => ({}));
    const plan = makePlan('Pawan Kalyan', { referenceBox: { x: 0, y: 0, width: 0.5, height: 0.5 } });
    const { e } = engine([reverse, text], v, { shortlistSize: 1 });
    const r = await e.run([plan], refPath);
    assert.equal(reverse.reqs.length, 1);
    assert.equal(reverse.reqs[0].mode, 'image');
    assert.ok(reverse.reqs[0].image && reverse.reqs[0].image.length > 1000, 'a real JPEG crop is sent');
    assert.ok(text.reqs.every(q => q.mode !== 'image'), 'text providers never get image requests');
    assert.equal(v.items[0], r.assets[0] ? `t:https://studio.test/og-hd.jpg` : '', 'the exact match is verified first');
    assert.equal(r.assets[0].sourceUrl, 'https://studio.test/og-hd.jpg');
    assert.equal(r.assets[0].referenceMatch, 'same_picture');
    assert.ok(r.reports[0].selected?.referenceMatch.evidence.some(x => /reverse image search/.test(x)));
    assert.ok(r.reports[0].selected?.referenceMatch.evidence.some(x => /picture hash/.test(x)), JSON.stringify(r.reports[0].selected?.referenceMatch));
    fs.unlinkSync(r.assets[0].path);
  });

  it('no reverse search when the reference crop is too small', async () => {
    images.set('https://img.test/small-ref-case.jpg', picture(43));
    const refPath = path.join(tmp, 'tiny-ref.jpg');
    fs.writeFileSync(refPath, createCanvas(400, 400).toBuffer('image/jpeg'));
    const reverse = provider('google-vision-web', () => [], { capability: 'image' });
    const text = provider('fake', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/small-ref-case.jpg' })]);
    const plan = makePlan('Pawan Kalyan', { referenceBox: { x: 0, y: 0, width: 0.2, height: 0.2 } });
    const r = await engine([reverse, text], verifier(() => ({}))).e.run([plan], refPath);
    assert.equal(reverse.reqs.length, 0);
    fs.unlinkSync(r.assets[0].path);
  });

  it('Wikimedia files found by a web provider get their real licence (and storable links)', async () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/PK_test.jpg/800px-PK_test.jpg';
    images.set(thumb, picture(44));
    const p = provider('brave-like', () => [cand('Pawan Kalyan portrait', { imageUrl: thumb, license: 'Unknown', licenseKnown: false, licenseFree: false })], { resultStorage: 'transient' });
    const lookup = {
      calls: 0,
      async lookup(url: string) {
        lookup.calls++;
        assert.equal(url, thumb);
        return { title: 'PK test.jpg', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', attribution: 'A Photographer', nonFree: false, fileUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/PK_test.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:PK_test.jpg' };
      }
    };
    const r = await engine([p], verifier(() => ({})), {}, lookup).e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(lookup.calls, 1);
    const a = r.assets[0];
    assert.equal(a.rights?.classification, 'open_license');
    assert.equal(a.rights?.attributionRequired, true);
    assert.equal(a.sourceUrl, 'https://upload.wikimedia.org/wikipedia/commons/a/ab/PK_test.jpg');
    assert.equal(a.sourcePage, 'https://commons.wikimedia.org/wiki/File:PK_test.jpg');
    assert.equal(a.attribution, 'A Photographer');
    fs.unlinkSync(a.path);
  });

  it('paid text search is limited per slot, and a monthly cap shows up as a warning', async () => {
    images.set('https://img.test/budget.jpg', picture(45));
    const brave = provider('brave-images', () => {
      throw new ProviderLimitError('Brave Image Search: monthly limit reached (1000 of 1000 in 2026-11), so no more requests are sent this month. Raise BRAVE_MONTHLY_REQUEST_LIMIT only if you accept paid usage.');
    });
    const other = provider('fake', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/budget.jpg' })]);
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'public_event_photo', context: { movieTitle: null, eventName: 'OG pre-release event', otherContext: null, evidence: 'text_in_reference', characterName: null }, aiSearchTerms: ['Pawan Kalyan OG pre-release event', 'Pawan Kalyan pre-release event speech'] });
    const r = await engine([brave, other], verifier(() => ({})), { braveMaxQueriesPerSlot: 2, maxRounds: 3 }).e.run([plan], null);
    assert.ok(brave.reqs.length <= 2, `brave got ${brave.reqs.length} queries`);
    assert.equal(r.reports[0].warnings.filter(w => /monthly limit reached/.test(w)).length, 1);
    fs.unlinkSync(r.assets[0].path);
  });
});

// ------------------------------------------------------------------------------------------------
describe('safeFetch POST', () => {
  let server: http.Server;
  let base = '';
  const seen: { method?: string; body: string; length?: string }[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, body, length: req.headers['content-length'] });
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/elsewhere' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>(r => server.close(() => r())));

  it('sends the body with its length; redirects are never followed for POST', async () => {
    const r = await safeFetch(`${base}/annotate`, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 2000, maxBytes: 10_000, allowPrivateNetwork: true });
    assert.equal(r.status, 200);
    assert.deepEqual(seen[0], { method: 'POST', body: '{"a":1}', length: '7' });
    await assert.rejects(() => safeFetch(`${base}/redirect`, { method: 'POST', body: 'x', timeoutMs: 2000, maxBytes: 10_000, allowPrivateNetwork: true }), (e: any) => e instanceof SafeFetchError && e.code === 'BLOCKED_URL');
    assert.equal(seen.length, 2, 'the redirect target was not requested');
  });
});
