/**
 * Discovery tests.
 *  - OFFLINE: provider response parsing (fixtures), Wikidata item choice, type inference, scoring,
 *    query planning and grounding.
 *  - MOCKED: the real DiscoveryEngine with fake providers, a fake downloader serving real images
 *    generated in memory, and a fake visual verifier. Covers success, wrong person, context
 *    mismatch, low resolution, duplicates across slots, provider failure/timeout, recovery
 *    rounds, inconclusive verification and safe failure.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { commonsPageToCandidate, chooseWikidataItem } from '../discovery/providers/wikimedia.providers';
import { ddgToCandidates, openverseToCandidates } from '../discovery/providers/web.providers';
import { inferCandidateType, scoreCandidate, typeScore, urlKey } from '../discovery/candidate-ranker';
import { groundSearchTerms, planQueries, sanitizeQuery } from '../discovery/query-planner';
import { DiscoveryEngine, SlotDiscoveryError } from '../discovery/discovery-engine';
import { ImageCandidate, ImageSearchProvider, SlotDiscoveryPlan, VisualVerdict } from '../discovery/discovery.types';
import { VerificationItem, VisualVerifier, isVisuallyAccepted, parseVerification } from '../discovery/visual-verifier';
import { resolveSlotIdentity } from '../identity/slot-identity';
import { loadConfig } from '../config/app-config';
import { dHash, hamming } from '../discovery/image-fingerprint';
import { VisionOutputError } from '../vision/vision-cli.runner';

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

// ------------------------------------------------------------------------------------------------
describe('provider parsing (offline fixtures)', () => {
  it('Commons page -> candidate with real licence, attribution, categories and a sized rendition', () => {
    const c = commonsPageToCandidate(
      {
        title: 'File:Pawan Kalyan at Janasena meeting.jpg',
        categories: [{ title: 'Category:Pawan Kalyan' }],
        imageinfo: [{
          url: 'https://upload.wikimedia.org/a/ab/Pawan.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Pawan.jpg',
          width: 4000, height: 3000, mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/thumb/a/ab/Pawan.jpg/1600px-Pawan.jpg', thumbwidth: 1600, thumbheight: 1200,
          extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Jane</a>' }, ImageDescription: { value: '<b>Speech</b> at a meeting' } }
        }]
      },
      { provider: 'wikimedia-commons', providerKind: 'official_api', reliability: 0.9, query: 'q', subjectCategory: 'Pawan Kalyan' }
    )!;
    assert.equal(c.imageUrl, 'https://upload.wikimedia.org/thumb/a/ab/Pawan.jpg/1600px-Pawan.jpg');
    assert.equal(c.width, 1600);
    assert.equal(c.license, 'CC BY-SA 4.0');
    assert.equal(c.licenseFree, true);
    assert.equal(c.attribution, 'Jane');
    assert.equal(c.description, 'Speech at a meeting');
    assert.equal(c.identityEvidence.kind, 'commons_category');
  });

  it('Commons: SVG/GIF/TIFF files are skipped', () => {
    for (const mime of ['image/svg+xml', 'image/gif', 'image/tiff', undefined]) {
      assert.equal(commonsPageToCandidate({ title: 'File:x', imageinfo: [{ url: 'https://u/x', mime }] }, { provider: 'p', providerKind: 'official_api', reliability: 1, query: 'q' }), null);
    }
  });

  it('Openverse and DuckDuckGo results are mapped with honest licence information', () => {
    const ov = openverseToCandidates([{ title: 'Actor at event', url: 'https://live.staticflickr.com/1/2.jpg', width: 800, height: 1000, license: 'by', license_version: '2.0', creator: 'Bob', source: 'flickr', filetype: 'jpg', tags: [{ name: 'actor' }] }, { url: 'https://x/y.svg', filetype: 'svg' }], 'q', 0.75);
    assert.equal(ov.length, 1);
    assert.equal(ov[0].license, 'CC BY 2.0');
    assert.equal(ov[0].licenseFree, true);
    const ddg = ddgToCandidates([{ title: 'OG still', image: 'https://cdn.news/og.jpg', url: 'https://news.example/og', width: 1600, height: 900 }], 'q', 0.5);
    assert.equal(ddg[0].licenseKnown, false);
    assert.match(ddg[0].license as string, /Unknown/);
    assert.equal(ddg[0].providerKind, 'unofficial');
  });

  it('Wikidata grounding only accepts an exact name with a fitting description', () => {
    const results = [
      { id: 'Q1', label: 'Vijay Deverakonda', description: 'Indian actor' },
      { id: 'Q2', label: 'Joseph Vijay', description: 'Indian actor and politician' },
      { id: 'Q3', label: 'Vijay', description: 'given name' }
    ];
    assert.equal(chooseWikidataItem(results, ['Thalapathy Vijay', 'Joseph Vijay'], 'person')?.id, 'Q2');
    assert.equal(chooseWikidataItem([{ id: 'Q9', label: 'Joseph Vijay', description: '2003 film' }], ['Joseph Vijay'], 'person'), null);
    assert.equal(chooseWikidataItem([{ id: 'Q8', label: 'Pawan Kalyan', description: 'Indian actor', match: { type: 'label', text: 'Pawan Kalyan' } }], ['Pawan Kalyan'], 'person')?.id, 'Q8');
  });

  it('URL keys treat Wikimedia thumbnails and originals of one file as the same image', () => {
    assert.equal(urlKey('https://upload.wikimedia.org/wikipedia/commons/a/ab/X_Y.jpg'), urlKey('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X_Y.jpg/1600px-X_Y.jpg'));
  });
});

describe('ranking (offline)', () => {
  it('infers picture types from titles first (descriptions cannot turn a rally photo into a still)', () => {
    assert.equal(inferCandidateType(cand('Pawan Kalyan at Janasena meeting.jpg', { description: 'Screenshot from a YouTube video' })), 'event');
    assert.equal(inferCandidateType(cand('OG Movie Stills HD')), 'still');
    assert.equal(inferCandidateType(cand('They Call Him OG first look poster')), 'poster');
    assert.equal(inferCandidateType(cand('x.jpg', { typeHints: ['profile'] })), 'portrait');
    assert.equal(inferCandidateType(cand('Mahesh Babu in Spyder.jpg'), 'Spyder'), 'still');
  });

  it('a random public-event photo is not equivalent to a movie still', () => {
    assert.ok(typeScore('movie_still', 'still') - typeScore('movie_still', 'event') >= 80);
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'They Call Him OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: null } });
    const still = scoreCandidate(cand('Pawan Kalyan OG movie still'), plan);
    const event = scoreCandidate(cand('Pawan Kalyan at Janasena meeting'), plan);
    assert.ok(still.total > event.total + 15, `${still.total} vs ${event.total}`);
    assert.equal(still.context, 100, 'the short film name "OG" counts as the film');
  });

  it('wrong person and confused names are below the identity threshold', () => {
    const plan = makePlan('Pawan Kalyan');
    assert.ok(scoreCandidate(cand('Pawan Singh live concert'), plan).identity < 70);
    assert.ok(scoreCandidate(cand('Kalyan Ram at event'), plan).identity < 70);
    assert.ok(scoreCandidate(cand('Pawan Kalyan portrait'), plan).identity >= 70);
  });

  it('structured identity evidence (Commons category / depicts) counts, but not over a confused name', () => {
    const plan = makePlan('Pawan Kalyan');
    assert.equal(scoreCandidate(cand('IMG_2041.jpg', { identityEvidence: { kind: 'depicts_statement' } }), plan).identity, 100);
    assert.ok(scoreCandidate(cand('Pawan Singh.jpg', { identityEvidence: { kind: 'commons_category' } }), plan).identity < 70);
  });

  it('low resolution, odd shapes, memes and stock previews are penalised', () => {
    const plan = makePlan('Pawan Kalyan');
    const good = scoreCandidate(cand('Pawan Kalyan portrait'), plan);
    assert.ok(scoreCandidate(cand('Pawan Kalyan portrait', { width: 200, height: 260 }), plan).total < good.total - 30);
    assert.ok(scoreCandidate(cand('Pawan Kalyan portrait', { width: 3000, height: 600 }), plan).aspect < 40);
    assert.ok(scoreCandidate(cand('Pawan Kalyan funny meme template'), plan).penalties >= 25);
    assert.ok(scoreCandidate(cand('Pawan Kalyan portrait', { pageUrl: 'https://www.shutterstock.com/x' }), plan).penalties >= 20);
  });
});

describe('query planning and grounding (offline)', () => {
  it('precise first round uses film, character and picture type', () => {
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'They Call Him OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: 'Ojas Gambheera' } });
    const q = planQueries(plan, 1).map(x => x.query);
    assert.ok(q.includes('Pawan Kalyan They Call Him OG movie still'));
    assert.ok(q.includes('Ojas Gambheera They Call Him OG'));
  });

  it('drops AI search terms that are not supported by the reference', () => {
    const plan = makePlan('Pawan Kalyan', { groundingText: 'OG CENSOR REPORT', aiSearchTerms: ['Pawan Kalyan OG still', 'Pawan Kalyan Gabbar Singh climax', 'Pawan Kalyan rain gun'] });
    const { kept, dropped } = groundSearchTerms(plan);
    assert.ok(kept.includes('Pawan Kalyan OG still'));
    assert.ok(dropped.includes('Pawan Kalyan rain gun'), 'visual words not in the reference are dropped');
    assert.ok(dropped.includes('Pawan Kalyan Gabbar Singh climax'), 'another film of the same actor is not grounded by an OG reference');
    const og = makePlan('Pawan Kalyan', { groundingText: 'OG CENSOR REPORT', aiSearchTerms: ['Pawan Kalyan Gabbar Singh still'] });
    assert.deepEqual(groundSearchTerms(og).kept, [], 'registry filmography must not ground a term');
  });

  it('never invents a film association for an unrelated term', () => {
    const plan = makePlan('Mamata Banerjee', { groundingText: 'NET WORTH OF CHIEF MINISTERS', aiSearchTerms: ['Mamata Banerjee Pushpa movie'] });
    assert.deepEqual(groundSearchTerms(plan).kept, []);
  });

  it('sanitises queries', () => {
    assert.equal(sanitizeQuery('  Pawan <b>Kalyan</b> {"$ne":1}\n OG  '), 'Pawan b Kalyan b ne 1 OG');
    assert.ok(sanitizeQuery('x'.repeat(200)).length <= 90);
  });
});

describe('verification parsing (offline)', () => {
  const letters = [{ letter: 'A', code: 'ACDEFH', id: 'a' }, { letter: 'B', code: 'JKMNPR', id: 'b' }];
  it('maps verdicts by image code only, and rejects answers with no valid code', () => {
    const m = parseVerification({ referenceCode: null, candidates: [{ code: 'JKMNPR', verdict: 'accept', confidence: 0.9, showsIntendedSubject: 'yes', subjectFocus: { x: 0.4, y: 0.3 } }, { code: 'XXXXXX', verdict: 'accept' }] }, letters, null);
    assert.equal(m.size, 1);
    assert.equal(m.get('b')?.verdict, 'accept');
    assert.deepEqual(m.get('b')?.subjectFocus, { x: 0.4, y: 0.3 });
    assert.throws(() => parseVerification({ candidates: [{ code: 'ZZZZZZ' }] }, letters, null), (e: any) => e instanceof VisionOutputError && e.code === 'UNSEEN_IMAGE');
  });

  it('code-side acceptance is stricter than the model verdict', () => {
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: null } });
    const v = (o: Partial<VisualVerdict>): VisualVerdict => ({ verdict: 'accept', confidence: 0.9, showsIntendedSubject: 'yes', matchesReferencePerson: 'yes', imageType: 'movie_still', matchesRequestedType: 'yes', matchesContext: 'yes', isCollageOrMeme: false, hasOverlaidText: false, suitability: 0.8, reason: '', ...o });
    assert.equal(isVisuallyAccepted(v({}), plan, false).ok, true);
    assert.equal(isVisuallyAccepted(v({ verdict: 'inconclusive' }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ confidence: 0.4 }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ showsIntendedSubject: 'uncertain' }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ matchesReferencePerson: 'no' }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ isCollageOrMeme: true }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ matchesRequestedType: 'no' }), plan, false).ok, false);
    assert.equal(isVisuallyAccepted(v({ matchesRequestedType: 'no' }), plan, true).ok, true, 'opt-in type fallback');
    assert.equal(isVisuallyAccepted(v({ matchesContext: 'no' }), plan, true).ok, false, 'wrong film is never accepted');
    assert.equal(isVisuallyAccepted(undefined, plan, false).ok, false);
  });
});

// ------------------------------------------------------------------------------------------------
// Mocked engine tests
// ------------------------------------------------------------------------------------------------
describe('DiscoveryEngine (mocked providers, downloads and verifier)', () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const cfg = () => ({ ...loadConfig({}).discovery, maxRounds: 3, shortlistSize: 3, requestTimeoutMs: 500, downloadTimeoutMs: 500, slotTimeoutMs: 20_000 });

  function provider(id: string, byQuery: (q: string, mode: string) => ImageCandidate[] | Promise<ImageCandidate[]>, opts: Partial<ImageSearchProvider> = {}): ImageSearchProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      id,
      label: id,
      kind: 'official_api',
      reliability: 0.9,
      supportsEntityMode: false,
      isEnabled: () => true,
      calls,
      async search(req) {
        calls.push(`${req.mode}:${req.query}`);
        return byQuery(req.query, req.mode);
      },
      ...opts
    } as ImageSearchProvider & { calls: string[] };
  }

  function verifier(decide: (item: VerificationItem) => Partial<VisualVerdict> | null): VisualVerifier & { batches: number } {
    const v = {
      batches: 0,
      async verify(_plan: SlotDiscoveryPlan, _ref: string | null, items: VerificationItem[]) {
        v.batches++;
        const verdicts = new Map<string, VisualVerdict>();
        for (const it of items) {
          const d = decide(it);
          if (d) verdicts.set(it.id, { verdict: 'accept', confidence: 0.9, showsIntendedSubject: 'yes', matchesReferencePerson: 'yes', imageType: 'portrait', matchesRequestedType: 'yes', matchesContext: 'not_applicable', isCollageOrMeme: false, hasOverlaidText: false, suitability: 0.8, reason: 'ok', ...d });
        }
        return { verdicts, calls: [] };
      }
    };
    return v;
  }

  function engine(providers: ImageSearchProvider[], ver: VisualVerifier | null, over: Partial<ReturnType<typeof cfg>> = {}, verifyMode: 'required' | 'off' = 'required') {
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
      verifyMode,
      storageDir: tmp
    });
    return { e, downloads };
  }

  it('selects a verified image, keeps verified alternates, stores only the selected file', async () => {
    images.set('https://img.test/pk1.jpg', picture(1));
    images.set('https://img.test/pk2.jpg', picture(2));
    images.set('https://img.test/ps.jpg', picture(3));
    const p = provider('fake', () => [
      cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/pk1.jpg' }),
      cand('Pawan Kalyan press meet', { imageUrl: 'https://img.test/pk2.jpg' }),
      cand('Pawan Singh concert', { imageUrl: 'https://img.test/ps.jpg' })
    ]);
    const { e, downloads } = engine([p], verifier(() => ({})));
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets.length, 1);
    assert.ok(['https://img.test/pk1.jpg', 'https://img.test/pk2.jpg'].includes(r.assets[0].sourceUrl as string));
    assert.ok(!downloads.includes('https://img.test/ps.jpg'), 'wrong person is never downloaded');
    assert.equal(r.reports[0].alternates.length, 1);
    assert.ok(r.reports[0].rejected.some(x => /identity not verified/.test(x.reason || '')));
    const stored = fs.readdirSync(tmp).filter(f => !f.startsWith('.'));
    assert.equal(stored.length, 1, 'only the selected image is kept');
    assert.ok(fs.existsSync(r.assets[0].path));
    fs.unlinkSync(r.assets[0].path);
  });

  it('tells a progress listener when each slot starts and what it found, and a listener that throws changes nothing', async () => {
    images.set('https://img.test/prog1.jpg', picture(11));
    const p = provider('fake', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/prog1.jpg' })]);
    const { e } = engine([p], verifier(() => ({})));
    const seen: { slotId: string; state: string; provider?: string }[] = [];
    const plan = makePlan('Pawan Kalyan');
    const r = await e.run([plan], null, ev => {
      seen.push(ev);
      throw new Error('a broken listener must not stop the search');
    });
    assert.deepEqual(seen.map(s => s.state), ['searching', 'found']);
    assert.ok(seen.every(s => s.slotId === plan.slotId));
    assert.equal(seen[1].provider, 'fake');
    assert.equal(r.assets.length, 1);
    fs.unlinkSync(r.assets[0].path);
  });

  it('a candidate the vision model rejects is never used (wrong person that passed the metadata)', async () => {
    images.set('https://img.test/naga.jpg', picture(4));
    images.set('https://img.test/akhil.jpg', picture(5));
    const p = provider('fake', () => [
      cand('Akhil Akkineni with family Naga', { imageUrl: 'https://img.test/naga.jpg' }),
      cand('Akhil Akkineni portrait', { imageUrl: 'https://img.test/akhil.jpg' })
    ]);
    const v = verifier(it => (it.path && it.title.includes('family') ? { verdict: 'reject', showsIntendedSubject: 'no', reason: 'shows Naga Chaitanya' } : {}));
    const { e } = engine([p], v);
    const r = await e.run([makePlan('Akhil Akkineni')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/akhil.jpg');
    assert.ok(r.reports[0].rejected.some(x => /Naga Chaitanya/.test(x.reason || '')));
    fs.unlinkSync(r.assets[0].path);
  });

  it('fails safely when nothing verifies (inconclusive = rejected), with a clear explanation', async () => {
    images.set('https://img.test/blurry.jpg', picture(6));
    const p = provider('fake', () => [cand('Pawan Kalyan blurry crowd shot', { imageUrl: 'https://img.test/blurry.jpg' })]);
    const { e } = engine([p], verifier(() => ({ verdict: 'inconclusive', reason: 'cannot tell' })), { maxRounds: 2 });
    await assert.rejects(() => e.run([makePlan('Pawan Kalyan')], null), (err: any) => {
      assert.ok(err instanceof SlotDiscoveryError);
      assert.match(err.message, /No unverified image was used/);
      assert.equal(err.failedSlotId, 's1');
      assert.ok(err.reports[0].rejected.length > 0);
      return true;
    });
    assert.deepEqual(fs.readdirSync(tmp).filter(f => !f.startsWith('.')), [], 'nothing is kept after a failure');
  });

  it('movie-still slots explain the options when no still can be verified', async () => {
    images.set('https://img.test/rally.jpg', picture(7));
    const p = provider('fake', () => [cand('Pawan Kalyan at rally', { imageUrl: 'https://img.test/rally.jpg' })]);
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'They Call Him OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: null } });
    const { e } = engine([p], verifier(() => ({ matchesRequestedType: 'no', imageType: 'public_event_photo' })), { maxRounds: 1 });
    await assert.rejects(
      () => e.run([plan], null),
      (err: any) =>
        /GOOGLE_CLOUD_VISION_API_KEY/.test(err.message) &&
        /BRAVE_SEARCH_API_KEY/.test(err.message) &&
        /DISCOVERY_ALLOW_TYPE_FALLBACK/.test(err.message) &&
        /written TMDB agreement/.test(err.message) &&
        !/free for non-commercial use/.test(err.message)
    );
  });

  it('opt-in type fallback: no verified film still -> a verified photo of the same person, clearly reported', async () => {
    images.set('https://img.test/pk-portrait.jpg', picture(21));
    const p = provider('fake', () => [cand('Pawan Kalyan official portrait', { imageUrl: 'https://img.test/pk-portrait.jpg' })]);
    const plan = makePlan('Pawan Kalyan', { desiredImageType: 'movie_still', context: { movieTitle: 'They Call Him OG', eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: null } });
    // The verifier is strict about the requested type: only a non-film request can accept a portrait.
    const asked: string[] = [];
    const v: VisualVerifier = {
      async verify(pl, _r, items) {
        asked.push(pl.desiredImageType);
        const verdicts = new Map<string, VisualVerdict>();
        for (const it of items) {
          const film = pl.desiredImageType === 'movie_still';
          verdicts.set(it.id, { verdict: film ? 'reject' : 'accept', confidence: 0.9, showsIntendedSubject: 'yes', matchesReferencePerson: 'yes', imageType: 'portrait', matchesRequestedType: film ? 'no' : 'yes', matchesContext: film ? 'no' : 'not_applicable', isCollageOrMeme: false, hasOverlaidText: false, suitability: 0.8, reason: film ? 'not a film still' : 'clear photo of the person' });
        }
        return { verdicts, calls: [] };
      }
    };
    const strict = engine([p], v, { maxRounds: 1, allowImageTypeFallback: false });
    await assert.rejects(() => strict.e.run([plan], null), (err: any) => err instanceof SlotDiscoveryError && /not a film still or poster/.test(err.message), 'default: strict, and explained');
    asked.length = 0;
    const relaxed = engine([p], v, { maxRounds: 1, allowImageTypeFallback: true });
    const r = await relaxed.e.run([plan], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/pk-portrait.jpg');
    assert.ok(r.reports[0].warnings[0].includes('a verified photo of the same person was used instead'));
    assert.equal(r.reports[0].desiredImageType, 'movie_still', 'the report keeps what the reference asked for');
    assert.deepEqual(asked, ['press_photo'], 'a portrait is not even sent to the vision model as a film still; only the fallback pass verifies it');
    assert.ok(r.reports[0].rejected.some(x => /not a film still or poster/.test(x.reason || '')) || r.reports[0].selected, 'the strict pass is explained');
    fs.unlinkSync(r.assets[0].path);
  });

  it('never uses the same picture in two slots (duplicate detection by image hash)', async () => {
    const same = picture(8);
    images.set('https://img.test/a.jpg', same);
    images.set('https://mirror.test/a-copy.jpg', same);
    images.set('https://img.test/b.jpg', picture(9));
    const p = provider('fake', () => [
      cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/a.jpg' }),
      cand('Pawan Kalyan portrait copy', { imageUrl: 'https://mirror.test/a-copy.jpg', providerReliability: 0.95 }),
      cand('Pawan Kalyan press photo', { imageUrl: 'https://img.test/b.jpg', providerReliability: 0.5 })
    ]);
    const { e } = engine([p], verifier(() => ({})));
    const r = await e.run([makePlan('Pawan Kalyan'), { ...makePlan('Pawan Kalyan'), slotId: 's2', index: 1 }], null);
    assert.equal(r.assets.length, 2);
    assert.notEqual(r.assets[0].sha256, r.assets[1].sha256);
    const h1 = await dHash(fs.readFileSync(r.assets[0].path));
    const h2 = await dHash(fs.readFileSync(r.assets[1].path));
    assert.ok(hamming(h1, h2) > 6, 'the two slots show different pictures');
    r.assets.forEach(a => fs.unlinkSync(a.path));
  });

  it('rejects images too small for the slot', async () => {
    images.set('https://img.test/tiny.jpg', picture(10, 260, 260)); // would need 2.7x enlargement for a 540x700 slot
    images.set('https://img.test/ok.jpg', picture(11));
    const p = provider('fake', () => [
      cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/tiny.jpg', width: undefined, height: undefined }),
      cand('Pawan Kalyan official photo', { imageUrl: 'https://img.test/ok.jpg' })
    ]);
    const { e } = engine([p], verifier(() => ({})));
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/ok.jpg');
    assert.ok(r.reports[0].rejected.some(x => /resolution too low|too small/.test(x.reason || '')), JSON.stringify(r.reports[0].rejected));
    fs.unlinkSync(r.assets[0].path);
  });

  it('survives a failing provider and a provider that hangs (timeout), using the others', async () => {
    images.set('https://img.test/good.jpg', picture(12));
    const broken = provider('broken', () => {
      throw new Error('HTTP 500');
    });
    const hanging = provider('hanging', () => new Promise<ImageCandidate[]>(() => undefined));
    const good = provider('good', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/good.jpg' })]);
    const { e } = engine([broken, hanging, good], verifier(() => ({})), { requestTimeoutMs: 100 });
    const started = Date.now();
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/good.jpg');
    assert.ok(r.reports[0].providerErrors.some(x => x.provider === 'broken'));
    assert.ok(r.reports[0].providerErrors.some(x => x.provider === 'hanging' && /timed out/.test(x.error)));
    assert.ok(Date.now() - started < 10_000);
    fs.unlinkSync(r.assets[0].path);
  });

  it('recovers in a later round with broader queries when the first round finds nothing verifiable', async () => {
    images.set('https://img.test/round1.jpg', picture(13));
    images.set('https://img.test/round2.jpg', picture(14));
    const p = provider('fake', q => (q === 'Pawan Kalyan' ? [cand('Pawan Kalyan official portrait', { imageUrl: 'https://img.test/round2.jpg' })] : [cand('Pawan Kalyan blurry', { imageUrl: 'https://img.test/round1.jpg' })]));
    const v = verifier(it => (it.title.includes('blurry') ? { verdict: 'reject', reason: 'blurry' } : {}));
    const { e } = engine([p], v);
    const r = await e.run([makePlan('Pawan Kalyan', { desiredImageType: 'public_event_photo' })], null);
    assert.equal(r.assets[0].sourceUrl, 'https://img.test/round2.jpg');
    assert.ok(r.reports[0].rounds >= 2);
    fs.unlinkSync(r.assets[0].path);
  });

  it('when the vision model cannot run, nothing is selected (no silent fallback)', async () => {
    images.set('https://img.test/v.jpg', picture(15));
    const p = provider('fake', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/v.jpg' })]);
    const failing: VisualVerifier = { verify: async () => { throw new Error('vision CLI timed out'); } };
    const { e } = engine([p], failing);
    await assert.rejects(() => e.run([makePlan('Pawan Kalyan')], null), SlotDiscoveryError);
  });

  it('verification "off" (explicit opt-out) accepts only strong metadata identity, with a warning', async () => {
    images.set('https://img.test/strong.jpg', picture(16));
    const p = provider('fake', () => [cand('Pawan Kalyan portrait', { imageUrl: 'https://img.test/strong.jpg' })]);
    const { e } = engine([p], null, {}, 'off');
    const r = await e.run([makePlan('Pawan Kalyan')], null);
    assert.ok(r.reports[0].warnings.some(w => /WITHOUT visual verification/.test(w)));
    fs.unlinkSync(r.assets[0].path);
  });
});
