/**
 * Offline tests for the identity engine v2: registry self-tests (generated for EVERY entry, so a
 * newly added alias is tested automatically), spelling folding, Telugu-script names, film
 * characters, and the per-slot decision policy that combines written names with AI evidence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldToken,
  listCharacters,
  listKnownEntities,
  matchTokens,
  resolveCharacterName,
  resolveSubjectIdentity,
  validateAliasTables
} from '../services/subject-alias-resolver';
import { resolveSlotIdentity } from '../identity/slot-identity';

describe('registry self-tests (every entry)', () => {
  it('has no internal conflicts after spelling folding', () => {
    assert.deepEqual(validateAliasTables(), []);
  });

  for (const e of listKnownEntities()) {
    it(`${e.canonicalName}: every verified name resolves to it, collisions never do`, () => {
      for (const name of [e.canonicalName, e.professionalName, ...e.aliases]) {
        const p = resolveSubjectIdentity(name);
        assert.equal(p.status, 'resolved', `"${name}" should resolve`);
        assert.equal(p.canonicalName, e.canonicalName, `"${name}" resolved to ${p.canonicalName}`);
      }
      for (const c of e.collisions) {
        const p = resolveSubjectIdentity(c, e.contextCues.join(' '));
        assert.notEqual(p.canonicalName, e.canonicalName, `collision "${c}" must not resolve to ${e.canonicalName}`);
      }
    });

    it(`${e.canonicalName}: ambiguous names never resolve without context`, () => {
      for (const a of e.ambiguousAliases) {
        const p = resolveSubjectIdentity(a);
        assert.equal(p.status, 'ambiguous', `"${a}" must be ambiguous`);
        assert.ok(p.ambiguity?.candidates.includes(e.canonicalName), `"${a}" candidates must include ${e.canonicalName}`);
      }
    });
  }

  for (const ch of listCharacters()) {
    it(`character ${ch.character}: maps to ${ch.actor} only under the documented conditions`, () => {
      for (const n of ch.aliasesNoContext) assert.equal(resolveCharacterName(n)?.canonicalName, ch.actor, n);
      for (const n of ch.aliasesWithFilmContext) {
        assert.equal(resolveCharacterName(n, 'weekend box office report'), null, `"${n}" must need the film named`);
        assert.equal(resolveCharacterName(n, `${ch.film} interval scene`)?.canonicalName, ch.actor, `"${n}" + film`);
      }
    });
  }
});

describe('spelling folding (both sides of every comparison)', () => {
  it('matches common romanisation variants', () => {
    for (const [a, b] of [['Pavan Kalyan', 'Pawan Kalyan'], ['Chiranjivi', 'Chiranjeevi'], ['Allu Arjunn', 'Allu Arjun'], ['Mahesh Baabu', 'Mahesh Babu'], ['Nandamuri Taraka Rama Rao Jr', 'Nandamuri Taraka Rama Rao Jr.']]) {
      assert.equal(resolveSubjectIdentity(a).canonicalName, resolveSubjectIdentity(b).canonicalName, `${a} ~ ${b}`);
    }
  });
  it('keeps meaningful vowel differences apart', () => {
    assert.notEqual(foldToken('thalapathy'), foldToken('thalapathi'));
    assert.equal(resolveSubjectIdentity('Thalapathi').status, 'ambiguous'); // also a 1991 film title
    assert.equal(resolveSubjectIdentity('Thalapathy').canonicalName, 'Thalapathy Vijay');
  });
  it('does not fold non-Latin scripts and strips zero-width joiners', () => {
    assert.equal(foldToken('పవన్'), 'పవన్');
    assert.deepEqual(matchTokens('పవన్‌ కళ్యాణ్'), matchTokens('పవన్ కళ్యాణ్'));
  });
  it('does not turn the actor Sree Vishnu into the deity', () => {
    const p = resolveSubjectIdentity('Sree Vishnu');
    assert.notEqual(p.canonicalName, 'Lord Vishnu');
  });
});

describe('Telugu-script names', () => {
  for (const [te, en] of [['పవన్ కళ్యాణ్', 'Pawan Kalyan'], ['చిరంజీవి', 'Chiranjeevi'], ['జూనియర్ ఎన్టీఆర్', 'Jr NTR'], ['మహేష్ బాబు', 'Mahesh Babu'], ['దళపతి విజయ్', 'Thalapathy Vijay']]) {
    it(`"${te}" -> ${en}`, () => assert.equal(resolveSubjectIdentity(te).canonicalName, en));
  }
  it('bare Telugu names stay ambiguous', () => {
    for (const te of ['విజయ్', 'పవన్', 'ఎన్టీఆర్', 'జగన్']) assert.equal(resolveSubjectIdentity(te).status, 'ambiguous', te);
  });
});

describe('per-slot identity decisions (written name + AI evidence)', () => {
  const ok = (d: ReturnType<typeof resolveSlotIdentity>, name: string) => {
    assert.equal(d.status, 'resolved', d.reasons.join(' '));
    assert.equal(d.searchName, name);
  };

  it('written verified name wins and agrees with the AI', () => {
    ok(resolveSlotIdentity({ nameAsWritten: 'CHIRANJEEVI', aiIdentifiedName: 'Chiranjeevi', aiEvidence: 'text_and_visual', aiConfidence: 1 }), 'Chiranjeevi');
  });

  it('conflicting written name and AI identity is never guessed', () => {
    const d = resolveSlotIdentity({ nameAsWritten: 'Pawan Kalyan', aiIdentifiedName: 'Chiranjeevi', aiEvidence: 'visual_recognition', aiConfidence: 0.99 });
    assert.equal(d.status, 'ambiguous');
    assert.deepEqual(d.candidates.map(c => c.name).sort(), ['Chiranjeevi', 'Pawan Kalyan']);
  });

  it('AI naming a commonly confused person blocks the written name', () => {
    const d = resolveSlotIdentity({ nameAsWritten: 'Pawan Kalyan', aiIdentifiedName: 'Pawan Singh', aiEvidence: 'visual_recognition', aiConfidence: 0.9 });
    assert.equal(d.status, 'ambiguous');
  });

  it('bare written name + confident AI identification among its candidates resolves (with a warning)', () => {
    const d = resolveSlotIdentity({ nameAsWritten: 'NTR', aiIdentifiedName: 'N. T. Rama Rao Jr.', aiEvidence: 'text_and_visual', aiConfidence: 1 });
    ok(d, 'Jr NTR');
    assert.equal(d.method, 'ai_identification');
    assert.ok(d.warnings.length > 0);
  });

  it('bare written name + low-confidence AI stays ambiguous', () => {
    const d = resolveSlotIdentity({ nameAsWritten: 'Vijay', aiIdentifiedName: 'Thalapathy Vijay', aiEvidence: 'visual_recognition', aiConfidence: 0.6 });
    assert.equal(d.status, 'ambiguous');
    assert.equal(d.candidates[0].name, 'Thalapathy Vijay');
  });

  it('bare written name + AI with no evidence stays ambiguous', () => {
    assert.equal(resolveSlotIdentity({ nameAsWritten: 'Boss', aiIdentifiedName: 'Chiranjeevi', aiEvidence: 'none', aiConfidence: 0.95 }).status, 'ambiguous');
  });

  it('bare written name + AI fuller name that contains it is searched literally', () => {
    const d = resolveSlotIdentity({ nameAsWritten: 'Vijay', aiIdentifiedName: 'Vijay Sethupathi', aiEvidence: 'text_and_visual', aiConfidence: 0.95 });
    ok(d, 'Vijay Sethupathi');
  });

  it('bare written name + AI fuller name that does NOT contain it stays ambiguous', () => {
    assert.equal(resolveSlotIdentity({ nameAsWritten: 'Vijay', aiIdentifiedName: 'Allu Arjun', aiEvidence: 'visual_recognition', aiConfidence: 0.95 }).status, 'ambiguous');
  });

  it('context evidence still resolves a bare name without the AI', () => {
    ok(resolveSlotIdentity({ nameAsWritten: 'Pawan', context: 'OG CENSOR REPORT' }), 'Pawan Kalyan');
  });

  it('no written name: confident AI identification is accepted, unconfident is not', () => {
    ok(resolveSlotIdentity({ aiIdentifiedName: 'N. Chandrababu Naidu', aiEvidence: 'visual_recognition', aiConfidence: 0.95 }), 'N. Chandrababu Naidu');
    assert.equal(resolveSlotIdentity({ aiIdentifiedName: 'N. Chandrababu Naidu', aiEvidence: 'visual_recognition', aiConfidence: 0.5 }).status, 'ambiguous');
  });

  it('unknown single written word completed by the AI', () => {
    ok(resolveSlotIdentity({ nameAsWritten: 'AKHIL', aiIdentifiedName: 'Akhil Akkineni', aiEvidence: 'text_and_visual', aiConfidence: 1 }), 'Akhil Akkineni');
  });

  it('a lone unknown word without a usable AI name is too weak to search', () => {
    assert.equal(resolveSlotIdentity({ nameAsWritten: 'Bheem' }).status, 'ambiguous');
  });

  it('film character maps to the actor through the verified table (with film evidence)', () => {
    const d = resolveSlotIdentity({ aiCharacterName: 'Komaram Bheem', filmEvidence: 'RRR re-release collections', context: 'RRR' });
    ok(d, 'Jr NTR');
    assert.equal(d.method, 'character_mapping');
    assert.notEqual(resolveSlotIdentity({ aiCharacterName: 'Komaram Bheem', filmEvidence: 'tribal leader statue' }).status, 'resolved', 'also a real historical person: needs the film named');
  });

  it('character mapping that contradicts the AI identity is not guessed', () => {
    assert.equal(resolveSlotIdentity({ aiCharacterName: 'Ojas Gambheera', aiIdentifiedName: 'Mahesh Babu', aiEvidence: 'visual_recognition', aiConfidence: 0.9 }).status, 'ambiguous');
  });

  it('non-person subjects are matched literally by name', () => {
    const d = resolveSlotIdentity({ subjectKind: 'film', aiIdentifiedName: 'They Call Him OG', aiEvidence: 'text_in_reference', aiConfidence: 0.9 });
    ok(d, 'They Call Him OG');
  });

  it('nothing written and nothing identified is reported as unidentified', () => {
    assert.equal(resolveSlotIdentity({}).status, 'unidentified');
  });
});
