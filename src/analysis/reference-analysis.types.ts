/**
 * Reference analysis v2: a per-slot description of a viral meme screenshot.
 * Produced by the vision model, then validated and normalised in code (never trusted as-is).
 */
import { ImageArrangementMode, MemeType } from '../types/meme.types';

export const MEME_FORMATS = [
  'comparison',
  'celebrity_comparison',
  'movie_update',
  'news_update',
  'facts_collage',
  'single_subject',
  'stacked_comparison',
  'other'
] as const;
export type MemeFormat = (typeof MEME_FORMATS)[number];

export const SUBJECT_KINDS = [
  'person',
  'movie_character',
  'group',
  'team',
  'film',
  'event',
  'brand',
  'product',
  'location',
  'object',
  'other'
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const IMAGE_TYPES = [
  'movie_still',
  'movie_poster',
  'portrait',
  'public_event_photo',
  'press_photo',
  'crowd_photo',
  'screenshot',
  'logo',
  'illustration',
  'other'
] as const;
export type ReferenceImageType = (typeof IMAGE_TYPES)[number];

export const EVIDENCE_KINDS = ['text_in_reference', 'visual_recognition', 'text_and_visual', 'context_inference', 'none'] as const;
export type IdentificationEvidence = (typeof EVIDENCE_KINDS)[number];

export type Orientation = 'portrait' | 'landscape' | 'square';

/** Fractions (0-1) of the meme area of the screenshot. */
export interface AnalysisBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CONTEXT_EVIDENCE = ['text_in_reference', 'visual', 'world_knowledge', 'none'] as const;
export type ContextEvidence = (typeof CONTEXT_EVIDENCE)[number];

export interface SlotContext {
  movieTitle: string | null;
  eventName: string | null;
  otherContext: string | null;
  /** Where the context came from; world_knowledge is weighted lower than text in the reference. */
  evidence: ContextEvidence;
}

export interface ReferenceSlot {
  slotId: string;
  index: number;
  row: number;
  column: number;
  bbox: AnalysisBox;
  subjectKind: SubjectKind;
  nameAsWritten: string | null;
  identifiedName: string | null;
  characterName: string | null;
  identificationEvidence: IdentificationEvidence;
  identityConfidence: number;
  context: SlotContext;
  imageType: ReferenceImageType;
  visualPurpose: string;
  orientation: Orientation;
  label: string | null;
  visualCharacteristics: string[];
  searchTerms: string[];
}

export interface ReferenceAnalysis {
  schemaVersion: 2;
  memeFormat: MemeFormat;
  legacyMemeType: MemeType;
  summary: string;
  header: { present: boolean; text: string | null; heightFraction: number };
  overlayText: { statement: string | null; bulletPoints: string[]; attribution: string | null };
  grid: { rows: number; columnsPerRow: number[]; rowHeightFractions: number[] };
  slots: ReferenceSlot[];
  reactionPanel: { present: boolean; heightFraction: number };
  palette: { background: string | null; accents: string[] };
  watermarks: string[];
  warnings: string[];
  /** The model reported text in the image that tried to instruct it. */
  suspectedPromptInjection: boolean;
  /** The model echoed the random code drawn on the image (proves it saw the image). */
  imageCodeVerified: boolean;
}

/** Shape used by the original pipeline (kept for backward compatibility). */
export interface LegacyViralAnalysis {
  memeType: MemeType;
  arrangement: ImageArrangementMode;
  subjectCount: number;
  subjects: string[];
  headline?: string;
  bulletPoints?: string[];
  statement?: string;
  itemLabels?: string[];
  referenceReactionContext?: string;
}
