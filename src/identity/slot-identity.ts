/**
 * Per-slot identity decision: combines the name WRITTEN in the reference, the vision model's
 * identification (with its evidence and confidence) and the reference context.
 *
 * Policy (fail safe):
 *  - A written name that resolves to a verified identity wins, unless the AI clearly names a
 *    different or commonly confused person (conflict -> ambiguous, never guessed).
 *  - A bare/ambiguous written name is accepted only with context evidence, or when the AI's
 *    identification is one of the ambiguous name's candidates (or a fuller name that contains the
 *    written name) with confidence >= IDENTITY_AI_MIN_CONFIDENCE and real evidence.
 *  - With no written name, the AI identification is accepted only above the confidence threshold.
 *  - Film characters map to the actor only via the verified character table.
 *  - Non-person subjects (films, events, teams, brands, places, objects) are matched literally.
 */
import { IdentificationEvidence, SubjectKind } from '../analysis/reference-analysis.types';
import {
  IdentityMatchType,
  matchTokens,
  resolveCharacterName,
  resolveSubjectIdentity,
  sharedNameTokens,
  SubjectProfile,
  textNamesCollision
} from '../services/subject-alias-resolver';

export interface SlotIdentityInput {
  nameAsWritten?: string | null;
  aiIdentifiedName?: string | null;
  aiCharacterName?: string | null;
  aiEvidence?: IdentificationEvidence;
  aiConfidence?: number;
  subjectKind?: SubjectKind;
  /** Reference text that can disambiguate (headline, statement, all labels, analysed context). */
  context?: string;
  /** Film evidence that does NOT include this slot's own name (for character mapping). */
  filmEvidence?: string;
}

export interface IdentityCandidate {
  name: string;
  source: 'written' | 'ai' | 'character' | 'ambiguity';
  note: string;
}

export interface IdentityDecision {
  status: 'resolved' | 'ambiguous' | 'unidentified';
  profile: SubjectProfile | null;
  method: IdentityMatchType | null;
  confidence: number;
  reasons: string[];
  warnings: string[];
  candidates: IdentityCandidate[];
  /** Name used for searching and verification. */
  searchName: string | null;
}

const NON_PERSON_KINDS: SubjectKind[] = ['film', 'event', 'team', 'brand', 'product', 'location', 'object'];

function confidenceFor(method: IdentityMatchType | undefined): number {
  switch (method) {
    case 'canonical':
    case 'verified_alias':
      return 0.95;
    case 'character_mapping':
      return 0.9;
    case 'context_evidence':
      return 0.85;
    default:
      return 0.75;
  }
}

function ok(profile: SubjectProfile, method: IdentityMatchType, confidence: number, reasons: string[], warnings: string[] = []): IdentityDecision {
  return {
    status: 'resolved',
    profile: { ...profile, matchType: method, status: profile.status === 'unknown' ? 'unknown' : 'resolved' },
    method,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    warnings,
    candidates: [],
    searchName: profile.canonicalName
  };
}

function ambiguous(reasons: string[], candidates: IdentityCandidate[], warnings: string[] = []): IdentityDecision {
  return { status: 'ambiguous', profile: null, method: null, confidence: 0, reasons, warnings, candidates, searchName: null };
}

/** A literal (unknown) name must have at least two name words to be searchable safely. */
function literalIsSpecific(p: SubjectProfile): boolean {
  return p.verificationTokens.length >= 2;
}

export function resolveSlotIdentity(input: SlotIdentityInput, aiMinConfidence = 0.8): IdentityDecision {
  const written = (input.nameAsWritten || '').trim();
  const ai = (input.aiIdentifiedName || '').trim();
  const character = (input.aiCharacterName || '').trim();
  const aiConf = typeof input.aiConfidence === 'number' ? input.aiConfidence : 0;
  const aiHasEvidence = Boolean(input.aiEvidence && input.aiEvidence !== 'none');
  const aiTrusted = Boolean(ai) && aiConf >= aiMinConfidence && aiHasEvidence;
  const context = input.context || '';
  const warnings: string[] = [];

  // Non-person subjects: literal entity name (film title, team, event...).
  if (input.subjectKind && NON_PERSON_KINDS.includes(input.subjectKind)) {
    const name = ai || written;
    if (!name) return { ...ambiguous(['The slot shows a non-person subject but no name was found for it.'], []), status: 'unidentified' };
    const p = resolveSubjectIdentity(name, context);
    if (p.status === 'ambiguous') return ambiguous([`"${name}" is ambiguous.`], (p.ambiguity?.candidates || []).map(c => ({ name: c, source: 'ambiguity' as const, note: 'possible match' })));
    return ok(p, p.matchType || 'literal', p.isKnownEntity ? 0.9 : 0.8, [`Non-person subject (${input.subjectKind}) matched by name "${name}".`]);
  }

  const w = written ? resolveSubjectIdentity(written, context) : null;
  const a = ai ? resolveSubjectIdentity(ai, context) : null;
  const ch = character ? resolveCharacterName(character, input.filmEvidence ?? context) : null;

  // 1. Written name resolves to a verified person.
  if (w && w.isKnownEntity && w.status === 'resolved') {
    if (a && a.isKnownEntity && a.canonicalName !== w.canonicalName) {
      return ambiguous(
        [`The reference text says "${written}" (${w.canonicalName}) but the image looks like ${a.canonicalName} to the AI. Conflicting identities are not guessed.`],
        [
          { name: w.canonicalName, source: 'written', note: `written as "${written}"` },
          { name: a.canonicalName, source: 'ai', note: `AI identification (${Math.round(aiConf * 100)}%)` }
        ]
      );
    }
    if (a && !a.isKnownEntity && a.status !== 'ambiguous') {
      const collision = textNamesCollision(w.canonicalName, ai);
      if (collision) {
        return ambiguous(
          [`The reference text says "${written}" but the AI identified "${ai}", a commonly confused name ("${collision}").`],
          [
            { name: w.canonicalName, source: 'written', note: `written as "${written}"` },
            { name: ai, source: 'ai', note: 'AI identification' }
          ]
        );
      }
      if (sharedNameTokens(w.canonicalName, ai).length === 0 && aiTrusted) {
        warnings.push(`The AI identified "${ai}", which does not match the written name; the written name was used.`);
      }
    }
    return ok(w, w.matchType || 'verified_alias', confidenceFor(w.matchType), [`Written name "${written}" resolves to ${w.canonicalName} (${w.matchType}).`], warnings);
  }

  // 2. Character name (from the AI) maps to an actor through the verified table.
  if (ch && (!w || w.status !== 'resolved' || !w.isKnownEntity)) {
    if (a && a.isKnownEntity && a.canonicalName !== ch.canonicalName) {
      return ambiguous(
        [`The character "${character}" is played by ${ch.canonicalName}, but the AI named ${a.canonicalName}.`],
        [
          { name: ch.canonicalName, source: 'character', note: `plays ${character}` },
          { name: a.canonicalName, source: 'ai', note: 'AI identification' }
        ]
      );
    }
    if (w && w.status === 'ambiguous' && !(w.ambiguity?.candidates || []).includes(ch.canonicalName)) {
      return ambiguous([`The written name "${written}" does not fit the character's actor ${ch.canonicalName}.`], []);
    }
    return ok(ch, 'character_mapping', 0.9, [`Character "${character}" (${ch.character?.film}) maps to ${ch.canonicalName}.`]);
  }

  // 3. Written name is ambiguous.
  if (w && w.status === 'ambiguous') {
    const cands: IdentityCandidate[] = (w.ambiguity?.candidates || []).map(c => ({ name: c, source: 'ambiguity' as const, note: `could be "${written}"` }));
    if (a && aiTrusted) {
      if (a.isKnownEntity && (w.ambiguity?.candidates || []).includes(a.canonicalName)) {
        warnings.push(`"${written}" is ambiguous; identity accepted from the AI (${input.aiEvidence}, ${Math.round(aiConf * 100)}%).`);
        return ok(a, 'ai_identification', Math.min(0.9, aiConf), [`Ambiguous written name "${written}" resolved by AI identification as ${a.canonicalName}.`], warnings);
      }
      const writtenTokens = matchTokens(written);
      const aiTokens = new Set(matchTokens(ai));
      if (!a.isKnownEntity && a.status !== 'ambiguous' && literalIsSpecific(a) && writtenTokens.every(t => aiTokens.has(t))) {
        warnings.push(`"${written}" is ambiguous; the AI identified the fuller name "${ai}", which is searched literally.`);
        return ok(a, 'ai_identification', Math.min(0.85, aiConf), [`Ambiguous written name "${written}" resolved by AI as "${ai}".`], warnings);
      }
    }
    if (a && a.isKnownEntity && !aiTrusted) {
      cands.unshift({ name: a.canonicalName, source: 'ai', note: `AI suggestion below the confidence threshold (${Math.round(aiConf * 100)}%)` });
    }
    return ambiguous([w.ambiguity?.reason ? `"${written}" is ambiguous: ${w.ambiguity.reason}.` : `"${written}" is ambiguous.`], cands);
  }

  // 4. Written name is unknown (not in the registry) or absent.
  if (a && a.status === 'resolved' && a.isKnownEntity) {
    if (!aiTrusted) {
      return ambiguous([`The AI suggested ${a.canonicalName} with low confidence (${Math.round(aiConf * 100)}%).`], [{ name: a.canonicalName, source: 'ai', note: 'low confidence' }]);
    }
    if (w) {
      const collision = textNamesCollision(a.canonicalName, written);
      if (collision) {
        return ambiguous([`The written name "${written}" is a commonly confused name for ${a.canonicalName}.`], [{ name: written, source: 'written', note: 'as written' }, { name: a.canonicalName, source: 'ai', note: 'AI identification' }]);
      }
      if (sharedNameTokens(a.canonicalName, written).length === 0) warnings.push(`Written name "${written}" is not a known alias of ${a.canonicalName}; identity taken from the AI.`);
    }
    return ok(a, 'ai_identification', Math.min(0.9, aiConf), [`AI identified ${a.canonicalName} (${input.aiEvidence}, ${Math.round(aiConf * 100)}%).`], warnings);
  }
  if (a && a.status === 'ambiguous') {
    return ambiguous([`The AI identification "${ai}" is itself ambiguous.`], (a.ambiguity?.candidates || []).map(c => ({ name: c, source: 'ambiguity' as const, note: `could be "${ai}"` })));
  }

  // Literal names (people not in the registry).
  if (w && w.status === 'unknown') {
    if (a && a.status === 'unknown' && aiTrusted) {
      const wt = matchTokens(written);
      const at = new Set(matchTokens(ai));
      if (wt.every(t => at.has(t)) && literalIsSpecific(a)) {
        return ok(a, 'literal', Math.min(0.85, aiConf), [`Written name "${written}" completed by the AI as "${ai}".`]);
      }
    }
    if (literalIsSpecific(w)) return ok(w, 'literal', 0.8, [`Written name "${written}" is not in the registry; it is searched and verified literally (all name words required).`]);
    if (a && a.status === 'unknown' && aiTrusted && literalIsSpecific(a)) {
      warnings.push(`Single-word written name "${written}" replaced by the AI's fuller name "${ai}".`);
      return ok(a, 'ai_identification', Math.min(0.8, aiConf), [`AI identified "${ai}".`], warnings);
    }
    return ambiguous([`"${written}" is a single unrecognised name; it is too weak to search safely.`], []);
  }
  if (!w && a && a.status === 'unknown') {
    if (aiTrusted && literalIsSpecific(a)) return ok(a, 'ai_identification', Math.min(0.85, aiConf), [`No name written in the reference; AI identified "${ai}".`]);
    return ambiguous([`No name is written in the reference and the AI identification "${ai}" is not confident or specific enough.`], [{ name: ai, source: 'ai', note: `${Math.round(aiConf * 100)}%` }]);
  }

  return { ...ambiguous(['No name is written for this slot and the AI could not identify the subject.'], []), status: 'unidentified' };
}
