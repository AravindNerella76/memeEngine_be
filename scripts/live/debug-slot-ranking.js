/**
 * LIVE debugging aid (network, no vision calls): runs the providers for one slot, ranks every
 * candidate and tries to download the top ones, printing why each is kept or rejected.
 *
 *   node scripts/live/debug-slot-ranking.js "Pawan Kalyan" movie_still "They Call Him OG" [character]
 */
require('reflect-metadata');
require('../../dist/config/load-env');
const { Logger } = require('@nestjs/common');
const { getConfig } = require('../../dist/config/app-config');
const { createProviders } = require('../../dist/discovery/providers');
const { planQueries } = require('../../dist/discovery/query-planner');
const { scoreCandidate, urlKey } = require('../../dist/discovery/candidate-ranker');
const { resolveSlotIdentity } = require('../../dist/identity/slot-identity');
const { politeFetch } = require('../../dist/security/polite-fetch');
const { verifyImageBuffer } = require('../../dist/security/image-verify');
Logger.overrideLogger(['error']);

(async () => {
  const [name = 'Pawan Kalyan', type = 'movie_still', film = 'They Call Him OG', character = null] = process.argv.slice(2);
  const identity = resolveSlotIdentity({ nameAsWritten: null, aiIdentifiedName: name, aiEvidence: 'text_and_visual', aiConfidence: 0.95, subjectKind: 'person', context: film });
  const plan = {
    slotId: 's1', index: 0, identity, subjectName: identity.searchName, subjectKind: 'person', desiredImageType: type,
    context: { movieTitle: film, eventName: null, otherContext: null, evidence: 'text_in_reference', characterName: character },
    label: null, visualPurpose: 'first subject', visualCharacteristics: [], orientation: 'portrait', targetWidth: 540, targetHeight: 700,
    aiSearchTerms: [], groundingText: `${film} CENSOR REPORT`
  };
  const providers = createProviders(getConfig).filter(p => p.isEnabled());
  const pool = new Map();
  const used = new Set();
  for (const round of [1, 2]) {
    for (const q of planQueries(plan, round, used)) {
      for (const p of providers) {
        if (p.id === 'tmdb' || p.id === 'openverse') continue;
        try {
          const res = await p.search({ query: q.query, mode: 'text', plan, limit: 25 });
          for (const c of res) if (!pool.has(urlKey(c.imageUrl))) pool.set(urlKey(c.imageUrl), { c, s: scoreCandidate(c, plan) });
          console.log(`round ${round} [${p.id}] "${q.query}" -> ${res.length}`);
        } catch (e) {
          console.log(`round ${round} [${p.id}] "${q.query}" ERROR ${e.message}`);
        }
      }
    }
  }
  const all = [...pool.values()].sort((a, b) => b.s.total - a.s.total);
  console.log(`\n${all.length} candidates; identity>=70: ${all.filter(x => x.s.identity >= 70).length}`);
  for (const { c, s } of all.filter(x => x.s.identity >= 70).slice(0, 25)) {
    console.log(`${String(s.total).padStart(3)} id=${s.identity} ctx=${s.context} type=${s.type}(${s.inferredType}) res=${s.resolution} asp=${s.aspect} src=${s.source} pen=${s.penalties} [${c.provider}] ${c.width}x${c.height} ${c.title.slice(0, 70)}`);
  }
  console.log('\n--- download test of the top 10 eligible ---');
  for (const { c } of all.filter(x => x.s.identity >= 70).slice(0, 10)) {
    try {
      const r = await politeFetch(c.imageUrl, { timeoutMs: 20000, maxBytes: 20 * 1024 * 1024, userAgent: getConfig().discovery.userAgent });
      const v = await verifyImageBuffer(r.body);
      console.log(`OK   ${v.width}x${v.height} ${r.body.length}B [${c.provider}] ${c.title.slice(0, 60)}`);
    } catch (e) {
      console.log(`FAIL ${e.message} [${c.provider}] ${c.title.slice(0, 60)} :: ${c.imageUrl.slice(0, 90)}`);
    }
  }
})();
