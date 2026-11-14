/**
 * Offline tests for subject identity matching and image relevance scoring.
 * Run with:  npm test      (builds, then runs node:test on dist/tests)
 *
 * No network, database or vision CLI is used. The pipeline tests replace global fetch.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';
import { Logger } from '@nestjs/common';
import {
  resolveSubjectIdentity,
  buildSubjectSearchQueries,
  scoreSubjectRelevance,
  validateAliasTables,
  formatAmbiguityMessage,
  normalizeForMatch,
  RELEVANCE_ACCEPT_THRESHOLD,
  SubjectProfile
} from '../services/subject-alias-resolver';
import { InternetSubjectDiscoveryService } from '../services/internet-subject-discovery.service';

const resolve = (name: string, ctx?: string) => resolveSubjectIdentity(name, ctx);

function score(subject: string, title: string, url?: string, ctx?: string) {
  return scoreSubjectRelevance({ title, sourceUrl: url }, resolve(subject, ctx));
}

describe('normalisation', () => {
  it('lower-cases, drops punctuation and splits whole words', () => {
    assert.deepEqual(normalizeForMatch('  N. T. Rama   Rao Jr. '), ['n', 't', 'rama', 'rao', 'jr']);
    assert.deepEqual(normalizeForMatch('Pawan_Kalyan-at (2019).jpg'), ['pawan', 'kalyan', 'at', '2019', 'jpg']);
  });
});

describe('alias tables are internally consistent', () => {
  it('has no duplicate verified names, verified/ambiguous overlap or self-colliding entries', () => {
    assert.deepEqual(validateAliasTables(), []);
  });
});

describe('identity resolution: exact names and verified aliases', () => {
  const cases: [string, string, string][] = [
    ['Pawan Kalyan', 'Pawan Kalyan', 'canonical'],
    ['Konidela Pawan Kalyan', 'Pawan Kalyan', 'canonical'],
    ['  pawan   KALYAN ', 'Pawan Kalyan', 'canonical'],
    ['Pawan Kalyan Garu', 'Pawan Kalyan', 'canonical'],
    ['Anna Konidala', 'Pawan Kalyan', 'verified_alias'],
    ['Anna Konidela', 'Pawan Kalyan', 'verified_alias'],
    ['Power Star Pawan Kalyan', 'Pawan Kalyan', 'verified_alias'],
    ['Janasenani', 'Pawan Kalyan', 'verified_alias'],
    ['Thalapathy Vijay', 'Thalapathy Vijay', 'canonical'],
    ['Joseph Vijay', 'Thalapathy Vijay', 'canonical'],
    ['C. Joseph Vijay', 'Thalapathy Vijay', 'verified_alias'],
    ['Thalapathy', 'Thalapathy Vijay', 'verified_alias'],
    ['Jr NTR', 'Jr NTR', 'canonical'],
    ['Jr. NTR', 'Jr NTR', 'canonical'], // punctuation-insensitive: identical to the canonical name
    ['NTR Jr', 'Jr NTR', 'verified_alias'],
    ['Tarak', 'Jr NTR', 'verified_alias'],
    ['Young Tiger NTR', 'Jr NTR', 'verified_alias'],
    ['CBN', 'N. Chandrababu Naidu', 'verified_alias'],
    ['Chandrababu Naidu', 'N. Chandrababu Naidu', 'verified_alias'],
    ['Chiru', 'Chiranjeevi', 'verified_alias'],
    ['Megastar Chiranjeevi', 'Chiranjeevi', 'verified_alias'],
    ['Prince Mahesh Babu', 'Mahesh Babu', 'verified_alias'],
    ['Natural Star Nani', 'Nani', 'verified_alias'],
    ['Mega Power Star Ram Charan', 'Ram Charan', 'verified_alias'],
    ['Lord Vishnu', 'Lord Vishnu', 'canonical'],
    ['Venkateswara Swamy', 'Lord Vishnu', 'verified_alias']
  ];
  for (const [input, canonical, matchType] of cases) {
    it(`"${input}" -> ${canonical} (${matchType})`, () => {
      const p = resolve(input);
      assert.equal(p.status, 'resolved');
      assert.equal(p.canonicalName, canonical);
      assert.equal(p.matchType, matchType);
      assert.equal(p.isKnownEntity, true);
    });
  }
});

describe('identity resolution: bare and shared names are ambiguous (no default star)', () => {
  const ambiguousNames = [
    'Vijay', 'Pawan', 'PK', 'Boss', 'Prince', 'Darling', 'Govinda', 'NTR', 'Konidela', 'Konidala',
    'Power Star', 'Powerstar', 'Superstar', 'Rebel Star', 'Megastar', 'Kalyan Babu', 'Annayya',
    'Cherry', 'Bunny', 'Didi', 'Revanth', 'Jagan', 'Narayana', 'Perumal', 'Vishnu', 'Ram', 'Thalapathi'
  ];
  for (const name of ambiguousNames) {
    it(`"${name}" without context is ambiguous and never resolves`, () => {
      const p = resolve(name);
      assert.equal(p.status, 'ambiguous', `expected ambiguous for ${name}`);
      assert.equal(p.isKnownEntity, false);
      assert.ok(p.ambiguity && p.ambiguity.candidates.length >= 1);
      assert.deepEqual(buildSubjectSearchQueries(name), [], 'must not generate search queries for an ambiguous name');
    });
  }

  it('also stays ambiguous when the context is unrelated or generic', () => {
    assert.equal(resolve('Vijay', 'BOX OFFICE REPORT').status, 'ambiguous');
    assert.equal(resolve('Pawan', 'Tollywood latest news').status, 'ambiguous');
    assert.equal(resolve('Boss', 'OG CENSOR REPORT').status, 'ambiguous'); // OG is a Pawan Kalyan cue, not Chiranjeevi's
  });

  it('a lone "Konidela" or "Konidala" is never mapped to Pawan Kalyan', () => {
    for (const n of ['Konidela', 'Konidala']) {
      const p = resolve(n);
      assert.equal(p.status, 'ambiguous');
      assert.ok(p.ambiguity!.candidates.includes('Pawan Kalyan'));
      assert.ok(p.ambiguity!.candidates.includes('Chiranjeevi'));
      assert.ok(p.ambiguity!.candidates.includes('Ram Charan'));
    }
  });

  it('gives a clear explanation of why it stopped', () => {
    const msg = formatAmbiguityMessage(resolve('Vijay'));
    assert.match(msg, /ambiguous and was not guessed/);
    assert.match(msg, /Thalapathy Vijay/);
    assert.match(msg, /Vijay Deverakonda/);
  });
});

describe('identity resolution: ambiguous names resolve ONLY with explicit context evidence', () => {
  it('film / party cue resolves the right person', () => {
    assert.equal(resolve('Vijay', 'TVK rally speech').canonicalName, 'Thalapathy Vijay');
    assert.equal(resolve('Pawan', 'OG CENSOR REPORT').canonicalName, 'Pawan Kalyan');
    assert.equal(resolve('Boss', 'BHOLA SHANKAR remuneration statement').canonicalName, 'Chiranjeevi');
    assert.equal(resolve('Tarak', 'x').canonicalName, 'Jr NTR');
    assert.equal(resolve('NTR', 'Devara first day collections').canonicalName, 'Jr NTR');
    assert.equal(resolve('Konidela', 'Game Changer trailer').canonicalName, 'Ram Charan');
    assert.equal(resolve('Govinda', 'Seven gates of Vaikuntam').canonicalName, 'Lord Vishnu');
    assert.equal(resolve('Vijay', 'TVK rally speech').matchType, 'context_evidence');
  });

  it('a full name in the context resolves a bare first name', () => {
    assert.equal(resolve('Pawan', 'Pawan Kalyan press meet').canonicalName, 'Pawan Kalyan');
    assert.equal(resolve('Vijay', 'Thalapathy Vijay birthday special').canonicalName, 'Thalapathy Vijay');
  });

  it('conflicting evidence stays ambiguous', () => {
    // Both Chiranjeevi and Pawan Kalyan cues are present for the shared surname
    assert.equal(resolve('Konidela', 'BHOLA SHANKAR and OG').status, 'ambiguous');
  });

  it('a commonly confused name in the context blocks resolution even when a cue is present', () => {
    assert.equal(resolve('Vijay', 'Vijay Deverakonda and TVK').status, 'ambiguous');
    assert.equal(resolve('Vijay', 'Vijay Deverakonda Liger release').status, 'ambiguous');
  });
});

describe('identity resolution: wrong-person collisions never map to a known star', () => {
  const wrong: [string, string][] = [
    ['Vijay Deverakonda', 'Thalapathy Vijay'],
    ['Vijay Sethupathi', 'Thalapathy Vijay'],
    ['Vijay Mallya', 'Thalapathy Vijay'],
    ['Pawan Singh', 'Pawan Kalyan'],
    ['Kalyan Ram', 'Pawan Kalyan'],
    ['Prince Harry', 'Mahesh Babu'],
    ['Boss Baby', 'Chiranjeevi'],
    ['Sr NTR', 'Jr NTR'],
    ['NTR Arts', 'Jr NTR'],
    ['Manchu Vishnu', 'Lord Vishnu'],
    ['Vishnu Vardhan', 'Lord Vishnu'],
    ['Nani Palkhivala', 'Nani'],
    ['Chiranjeevi Sarja', 'Chiranjeevi'],
    ['Allu Sirish', 'Allu Arjun'],
    ['Mahesh Bhatt', 'Mahesh Babu'],
    ['Lokesh Naidu', 'N. Chandrababu Naidu'],
    ['Sonia Reddy', 'A. Revanth Reddy']
  ];
  for (const [input, notThis] of wrong) {
    it(`"${input}" is searched literally and does NOT resolve to ${notThis}`, () => {
      const p = resolve(input, 'OG tvk bhola shankar devara'); // even with cue-rich context
      assert.equal(p.status, 'unknown');
      assert.equal(p.isKnownEntity, false);
      assert.notEqual(p.canonicalName, notThis);
      assert.equal(p.canonicalName, input);
      assert.ok(p.verificationTokens.length >= 2, 'all name words must be required');
    });
  }

  it('does not search the wrong person for "Vijay Deverakonda"', () => {
    const q = buildSubjectSearchQueries('Vijay Deverakonda');
    assert.ok(q.includes('Vijay Deverakonda'));
    assert.ok(!q.some(x => /thalapathy|joseph/i.test(x)));
  });
});

describe('relevance scoring: correct images pass', () => {
  const pass: [string, string, string?][] = [
    ['Pawan Kalyan', 'Pawan Kalyan at Janasena meeting in 2019.jpg'],
    ['Pawan Kalyan', 'Shri Konidela Pawan Kalyan.jpg'],
    ['Pawan Kalyan', 'The portrait of Pawan Kalyan (2024).jpg'],
    ['Pawan Kalyan', 'Telugu actor Pawan Kalyan meets Narendra Modi.jpg'],
    ['Pawan Kalyan', 'V Srinivasa Rao with Pawan Kalyan.jpg'],
    ['Pawan Kalyan', 'Pawan Kalyan filmography'],
    ['Anna Konidala', 'Konidela Pawan Kalyan portrait.jpg'],
    ['Thalapathy Vijay', 'C. Joseph Vijay.jpg'],
    ['Thalapathy Vijay', 'C. Joseph Vijay (cropped).jpg'],
    ['Thalapathy Vijay', 'Thalapathy Thiruvizha – Jana Nayagan Audio Launch Vijay.jpg'],
    ['Thalapathy Vijay', 'Vijay and Pooja Hegde Thalapathy 69 pooja.jpg'],
    ['Jr NTR', 'N. T. Rama Rao Jr. in 2023.jpg'],
    ['Jr NTR', 'Jr. NTR at Devara event.jpg'],
    ['Jr NTR', 'Young Tiger NTR.jpg'],
    ['N. Chandrababu Naidu', 'Chandrababu Naidu 2024.jpg'],
    ['Mahesh Babu', 'Superstar Mahesh Babu.jpg'],
    ['Lord Vishnu', 'Lord Vishnu with Lakshmi.jpg'],
    ['Nani', 'Nani Telugu actor at event.jpg'],
    ['Nani', 'Nani at Jersey screening.jpg'],
    ['Pawan Kalyan', 'IMG_2034.jpg', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Pawan_Kalyan_speaking.jpg'],
    ['Pawan Kalyan', 'photo', 'https://cdn.example.com/thumb/557px-Konidela_Pawan_Kalyan.jpg']
  ];
  for (const [subject, title, url] of pass) {
    it(`"${subject}" accepts "${title}"`, () => {
      const r = score(subject, title, url);
      assert.ok(r.accepted, `score ${r.score}: ${r.reasons.join('; ')}`);
      assert.ok(r.score >= RELEVANCE_ACCEPT_THRESHOLD);
    });
  }
});

describe('relevance scoring: wrong-person and weak candidates are rejected', () => {
  const fail: [string, string, string?][] = [
    // collisions from the audit
    ['Thalapathy Vijay', 'Vijay Deverakonda at event.jpg'],
    ['Thalapathy Vijay', 'Vijay Mallya.jpg'],
    ['Thalapathy Vijay', 'Vijay Sethupathi in Master.jpg'],
    ['Thalapathy Vijay', 'Thalapathy and Vijay Sethupathi together.jpg'],
    ['Pawan Kalyan', 'Kalyan Jewellers showroom.jpg'],
    ['Pawan Kalyan', 'Kalyan Ram at event.jpg'],
    ['Pawan Kalyan', 'Pawan Singh concert.jpg'],
    ['Jr NTR', 'Central_Park_entry.jpg'],
    ['Jr NTR', 'N. T. Rama Rao.jpg'],
    ['Jr NTR', 'Sr NTR statue.jpg'],
    ['Jr NTR', 'NTR Arts banner.jpg'],
    ['Mahesh Babu', 'Chandrababu Naidu.jpg'],
    ['Mahesh Babu', 'Mohan Babu at event.jpg'],
    ['Lord Vishnu', 'Manchu Vishnu.jpg'],
    ['Lord Vishnu', 'Vishnu Vishal at premiere.jpg'],
    ['A. Revanth Reddy', 'Sonia Reddy.jpg'],
    ['N. Chandrababu Naidu', 'Nara Lokesh with Chandrababu Naidu.jpg'],
    ['Chiranjeevi', 'Chiranjeevi Sarja.jpg'],
    ['Prabhas', 'Krishnam Raju and Prabhas.jpg'],
    ['Nani', 'Nani Palkhivala portrait.jpg'],
    ['Nani', 'Nani.jpg'], // single common word without corroboration
    // only a bare/ambiguous name, even though it is from the right search
    ['Thalapathy Vijay', 'Vijay at the Nadigar Sangam Protest.jpg'],
    ['Thalapathy Vijay', 'Vijay at Puli Audio Launch.jpg'],
    ['Pawan Kalyan', 'Pawan at event.jpg'],
    // another known star named alongside (group / wrong subject)
    ['Pawan Kalyan', 'Chiranjeevi and Pawan Kalyan.jpg'],
    // matches only in noise
    ['Pawan Kalyan', 'IMG_1.jpg', 'https://cdn.example.com/kalyan-jewellers/IMG_1.jpg'],
    ['Pawan Kalyan', '']
  ];
  for (const [subject, title, url] of fail) {
    it(`"${subject}" rejects "${title || '(empty title)'}"`, () => {
      const r = score(subject, title, url);
      assert.equal(r.accepted, false, `score ${r.score}: ${r.reasons.join('; ')}`);
    });
  }

  it('an ambiguous profile can never accept any image', () => {
    const r = scoreSubjectRelevance({ title: 'Thalapathy Vijay.jpg' }, resolve('Vijay'));
    assert.equal(r.accepted, false);
    assert.equal(r.score, 0);
  });

  it('weak "single name + cue" evidence is accepted, but a cue alone is not', () => {
    // "Vijay" + a Vijay-specific film in the same title is enough; the film alone is not
    assert.equal(score('Thalapathy Vijay', 'Vijay in Varisu.jpg').accepted, true);
    assert.equal(score('Thalapathy Vijay', 'Varisu poster.jpg').accepted, false);
  });
});

describe('relevance scoring: literal (unknown) names require every name word', () => {
  it('Vijay Deverakonda matches only Vijay Deverakonda', () => {
    assert.equal(score('Vijay Deverakonda', 'Vijay Deverakonda at Liger event.jpg').accepted, true);
    assert.equal(score('Vijay Deverakonda', 'Vijay at event.jpg').accepted, false);
    assert.equal(score('Vijay Deverakonda', 'Vijay Sethupathi.jpg').accepted, false);
    assert.equal(score('Vijay Deverakonda', 'C. Joseph Vijay.jpg').accepted, false);
  });
  it('multi-word unknown names need all words', () => {
    assert.equal(score('Anil Sunkara', 'Producer Anil Sunkara at event.jpg').accepted, true);
    assert.equal(score('Anil Sunkara', 'Anil Kapoor.jpg').accepted, false);
    assert.equal(score('Anil Sunkara', 'Sunkara Rama Brahmam.jpg').accepted, false);
  });
  it('Sr NTR does not accept Jr NTR images', () => {
    assert.equal(score('Sr NTR', 'Jr NTR at event.jpg').accepted, false);
    assert.equal(score('Sr NTR', 'Sr NTR in Lava Kusa.jpg').accepted, true);
  });
});

// -------------------------------------------------------------------------------------------
// Pipeline tests: real discovery service, mocked network
// -------------------------------------------------------------------------------------------
describe('discovery pipeline (mocked network)', () => {
  const realFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  let jpeg: Buffer;
  const savedFiles: string[] = [];

  const page = (id: number, title: string, url: string) => ({
    [String(id)]: {
      title: `File:${title}`,
      imageinfo: [{
        url, width: 1200, height: 1800, mime: 'image/jpeg',
        extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'Tester' } }
      }]
    }
  });

  const commonsPayload = {
    query: {
      pages: {
        ...page(1, 'Vijay Deverakonda at Liger event.jpg', 'https://img.test/deverakonda.jpg'),
        ...page(2, 'Vijay at the Nadigar Sangam Protest.jpg', 'https://img.test/bare-vijay.jpg'),
        ...page(3, 'Thalapathy and Vijay Sethupathi together.jpg', 'https://img.test/collision.jpg'),
        ...page(4, 'C. Joseph Vijay.jpg', 'https://img.test/thalapathy.jpg')
      }
    }
  };

  before(() => {
    Logger.overrideLogger(false); // keep test output readable
    // Build a real, decodable JPEG larger than the service's 20 KB minimum
    const canvas = createCanvas(600, 800);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 6000; i++) {
      ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`;
      ctx.fillRect((i * 17) % 600, (i * 29) % 800, 24, 24);
    }
    jpeg = canvas.toBuffer('image/jpeg');
    assert.ok(jpeg.length > 20000, `fixture jpeg too small: ${jpeg.length}`);

    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      fetchedUrls.push(url);
      if (url.includes('commons.wikimedia.org')) {
        return new Response(JSON.stringify(commonsPayload), { status: 200 });
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return new Response(JSON.stringify({ query: { pages: {} } }), { status: 200 });
      }
      if (url.startsWith('https://img.test/')) {
        return new Response(new Uint8Array(jpeg), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as any;
  });

  after(() => {
    globalThis.fetch = realFetch;
    for (const f of savedFiles) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  });

  const imageFetches = () => fetchedUrls.filter(u => u.startsWith('https://img.test/'));

  it('stops BEFORE any network call when a subject is ambiguous', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    await assert.rejects(
      () => svc.discoverSubjectImages(['Vijay'], 1, 'BOX OFFICE REPORT'),
      (err: any) => /ambiguous and was not guessed/.test(err.message) && /Thalapathy Vijay/.test(err.message)
    );
    assert.equal(fetchedUrls.length, 0, 'no search or download may happen for an ambiguous subject');
  });

  it('reports every ambiguous slot in one error, before searching any slot', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    await assert.rejects(
      () => svc.discoverSubjectImages(['Thalapathy Vijay', 'Pawan', 'Boss'], 3, 'Weekend news'),
      (err: any) => /"Pawan"/.test(err.message) && /"Boss"/.test(err.message)
    );
    assert.equal(fetchedUrls.length, 0, 'the resolvable first slot must not trigger a search either');
  });

  it('selects only the verified Thalapathy Vijay image and never downloads rejected ones', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    const [asset] = await svc.discoverSubjectImages(['Thalapathy Vijay'], 1, 'Fan gathering');
    savedFiles.push(asset.path);
    assert.equal(asset.sourceUrl, 'https://img.test/thalapathy.jpg');
    assert.equal(asset.license, 'CC BY-SA 4.0');
    assert.deepEqual(Array.from(new Set(imageFetches())), ['https://img.test/thalapathy.jpg']);
  });

  it('resolves a bare "Vijay" only when the reference context proves who it is', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    const [asset] = await svc.discoverSubjectImages(['Vijay'], 1, 'TVK rally speech');
    savedFiles.push(asset.path);
    assert.equal(asset.sourceUrl, 'https://img.test/thalapathy.jpg');
  });

  it('searches "Vijay Deverakonda" literally and never returns a Thalapathy Vijay image', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    const [asset] = await svc.discoverSubjectImages(['Vijay Deverakonda'], 1, 'Movie news');
    savedFiles.push(asset.path);
    assert.equal(asset.sourceUrl, 'https://img.test/deverakonda.jpg');
    assert.ok(!imageFetches().includes('https://img.test/thalapathy.jpg'));
  });

  it('fails safely (no image) when no candidate verifies', async () => {
    fetchedUrls.length = 0;
    const svc = new InternetSubjectDiscoveryService();
    await assert.rejects(
      () => svc.discoverSubjectImages(['Pawan Kalyan'], 1, 'OG'),
      (err: any) => /Could not discover a reliable internet image/.test(err.message)
    );
    assert.equal(imageFetches().length, 0, 'unverified candidates must not be downloaded');
  });
});

// Type-level guard: SubjectProfile keeps the fields other code relies on
const _typeCheck: Pick<SubjectProfile, 'canonicalName' | 'professionalName' | 'aliases' | 'searchQueries' | 'verificationTokens' | 'isKnownEntity' | 'category'> =
  resolveSubjectIdentity('Pawan Kalyan');
void _typeCheck;
