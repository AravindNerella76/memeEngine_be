/**
 * Shared types for internet subject-image discovery (provider-independent).
 */
import { AnalysisBox, Orientation, ReferenceImageType, SlotContext, SubjectKind } from '../analysis/reference-analysis.types';
import { IdentityDecision } from '../identity/slot-identity';
import { RightsClass, RightsInfo } from './rights';

export type ProviderKind = 'official_api' | 'unofficial';

/**
 * What a provider's API terms allow us to keep:
 *  - 'full': results (URLs, titles) may be stored in the meme record and report;
 *  - 'transient': results may only be used during the run (e.g. Brave: "transient storage" only).
 *    The downloaded picture itself is the third party's content, not the provider's result.
 */
export type ResultStorage = 'full' | 'transient';

/** How a candidate relates to the subject's picture in the reference. */
export type ReferenceMatchLevel = 'same_picture' | 'same_scene' | 'different' | 'unknown';

export interface ReferenceMatchInfo {
  level: ReferenceMatchLevel;
  evidence: string[];
}

/** Structured identity grounding from Wikidata / Wikipedia (when found). */
export interface GroundedEntity {
  qid?: string;
  label?: string;
  description?: string;
  commonsCategory?: string;
  imageFile?: string;
}

/** Everything discovery needs to know about one image slot. */
export interface SlotDiscoveryPlan {
  slotId: string;
  index: number;
  identity: IdentityDecision;
  /** Canonical (or literal) subject name used for search and verification. */
  subjectName: string;
  subjectKind: SubjectKind;
  desiredImageType: ReferenceImageType;
  context: SlotContext & { characterName: string | null };
  label: string | null;
  visualPurpose: string;
  visualCharacteristics: string[];
  orientation: Orientation;
  /** Pixel size of the slot in the final layout. */
  targetWidth: number;
  targetHeight: number;
  aiSearchTerms: string[];
  /** All reference text + analysis context: AI search terms must be grounded in it. */
  groundingText: string;
  /** Where this slot is in the reference (fractions), for visual comparison. */
  referenceBox?: AnalysisBox;
}

export type QueryRound = 1 | 2 | 3;

export interface PlannedQuery {
  query: string;
  round: QueryRound;
  intent: 'context' | 'identity' | 'broad' | 'ai_suggested';
}

export interface ProviderSearchRequest {
  query: string;
  plan: SlotDiscoveryPlan;
  entity?: GroundedEntity;
  limit: number;
  /**
   * 'text': free-text search. 'entity': structured lookups (Commons category/depicts, person images).
   * 'image': reverse image search with the slot's crop from the reference (`image`).
   */
  mode: 'text' | 'entity' | 'image';
  /** JPEG crop of this slot from the reference (mode 'image' only). */
  image?: Buffer;
}

export type IdentityEvidenceKind =
  | 'depicts_statement'
  | 'commons_category'
  | 'wikipedia_lead_image'
  | 'tmdb_person_profile'
  | 'tmdb_tagged_image'
  /** Reverse image search: the same picture as the reference slot, AND the search engine names the subject. */
  | 'reverse_image_match'
  | 'none';

export interface ImageCandidate {
  id: string;
  provider: string;
  providerKind: ProviderKind;
  providerReliability: number;
  query: string;
  title: string;
  /** URL that will be downloaded (may be a sized rendition). */
  imageUrl: string;
  /** Human-readable source page. */
  pageUrl?: string;
  width?: number;
  height?: number;
  mime?: string;
  license?: string;
  licenseUrl?: string;
  licenseKnown: boolean;
  licenseFree: boolean;
  attribution?: string;
  description?: string;
  tags: string[];
  categories: string[];
  identityEvidence: { kind: IdentityEvidenceKind; detail?: string };
  typeHints: string[];
  mediaTitle?: string;
  /** The source itself marks the file as non-free (e.g. Wikipedia "fair use" posters). */
  nonFree?: boolean;
  /** What the provider's terms allow us to keep (default 'full'). */
  resultStorage?: ResultStorage;
  /** Reverse image search result type: the same picture ('full') or a crop/edit of it ('partial'). */
  reverseMatch?: 'full' | 'partial';
  /**
   * Words that describe the picture's context (e.g. web entities of the reference picture). Used for
   * the CONTEXT score only, never as identity evidence.
   */
  contextHints?: string[];
  /** Set by the discovery engine. */
  rights?: RightsInfo;
}

export interface ImageSearchProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  /** Prior for source reliability (0-1). */
  readonly reliability: number;
  readonly supportsEntityMode: boolean;
  /** 'text' (default): answers text/entity queries. 'image': reverse image search only. */
  readonly capability?: 'text' | 'image';
  /** What its API terms allow us to keep (default 'full'). */
  readonly resultStorage?: ResultStorage;
  isEnabled(): boolean;
  search(req: ProviderSearchRequest): Promise<ImageCandidate[]>;
}

export interface ScoreBreakdown {
  identity: number;
  context: number;
  type: number;
  resolution: number;
  aspect: number;
  source: number;
  /** Informational only: rights never change the ranking (see rights.ts and the rights policy). */
  license: number;
  /** Reverse image search evidence: 100 same picture, 85 crop/edit of it, 50 no reverse-search evidence. */
  reference: number;
  penalties: number;
  total: number;
  inferredType: string;
  notes: string[];
}

export interface VisualVerdict {
  verdict: 'accept' | 'reject' | 'inconclusive';
  confidence: number;
  showsIntendedSubject: 'yes' | 'no' | 'uncertain';
  matchesReferencePerson: 'yes' | 'no' | 'uncertain' | 'not_applicable';
  imageType: string;
  matchesRequestedType: 'yes' | 'no' | 'uncertain';
  matchesContext: 'yes' | 'no' | 'uncertain' | 'not_applicable';
  isCollageOrMeme: boolean;
  hasOverlaidText: boolean;
  suitability: number;
  reason: string;
  /** Where the intended subject (face) is in the candidate, as fractions of the picture. */
  subjectFocus?: { x: number; y: number };
  /**
   * Compared with the reference slot (image R): the same photo/frame, the same scene or shoot,
   * or a different picture. Only a preference among accepted candidates, never an acceptance rule.
   */
  referenceMatch?: 'same_picture' | 'same_scene' | 'different' | 'uncertain' | 'not_applicable';
}

export interface EvaluatedCandidate {
  candidate: ImageCandidate;
  score: ScoreBreakdown;
  stage: 'metadata' | 'downloaded' | 'verified' | 'rejected';
  rejection?: string;
  download?: {
    path: string;
    width: number;
    height: number;
    mime: string;
    sha256: string;
    dhash: string;
    bytes: number;
  };
  visual?: VisualVerdict;
  finalScore?: number;
  /** Perceptual-hash distance to the reference slot (0 = identical picture). */
  referenceHashDistance?: number;
  referenceMatch?: ReferenceMatchInfo;
}

/** Title and URLs are omitted when the provider's terms allow only transient storage (stored = false). */
export interface SlotReportCandidate {
  title?: string;
  provider: string;
  sourceUrl?: string;
  pageUrl?: string;
  license?: string;
  attribution?: string;
  score?: number;
  reason?: string;
  rights?: RightsClass;
  stored?: boolean;
}

export interface SlotDiscoveryReport {
  slotId: string;
  subject: string;
  desiredImageType: string;
  context: Record<string, string | null>;
  entity?: GroundedEntity;
  queries: PlannedQuery[];
  droppedSearchTerms: string[];
  providersUsed: string[];
  providerErrors: { provider: string; query: string; error: string }[];
  rounds: number;
  candidatesConsidered: number;
  downloads: number;
  visualChecks: number;
  selected?: {
    /** Omitted when the provider's terms allow only transient storage (see rights.sourceStored). */
    title?: string;
    provider: string;
    sourceUrl?: string;
    pageUrl?: string;
    license?: string;
    licenseFree: boolean;
    attribution?: string;
    width: number;
    height: number;
    sha256: string;
    scores: ScoreBreakdown;
    visual?: VisualVerdict;
    finalScore: number;
    identityEvidence: string;
    rights: RightsInfo;
    referenceMatch: ReferenceMatchInfo;
  };
  /** Verified alternates (only from providers whose terms allow storing their results). */
  alternates: (SlotReportCandidate & { sha256: string; width: number; height: number; finalScore: number; focus?: { x: number; y: number }; referenceMatch?: ReferenceMatchInfo })[];
  rejected: SlotReportCandidate[];
  /** The rights policy this slot was discovered under. */
  rightsPolicy?: string;
  /** Informational notes (e.g. results that were used but not stored because of provider terms). */
  notes?: string[];
  warnings: string[];
  durationMs: number;
}
