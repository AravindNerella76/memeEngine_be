import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WhatsAppSessionDocument = WhatsAppSession & Document;

export type WhatsAppState =
  | 'IDLE'
  | 'AWAITING_REACTION'
  | 'AWAITING_PUNCHLINE'
  | 'GENERATING'
  | 'AWAITING_APPROVAL'
  // viral flow: discovery could not find a verified picture, the user is asked to send one
  | 'AWAITING_SLOT_IMAGE'
  // layout library: the user is adding a layout from an example meme
  | 'LAYOUT_EXAMPLE'
  | 'LAYOUT_ANALYZING'
  | 'LAYOUT_NAME'
  // manual (own edit) flow
  | 'MANUAL_TYPE'
  | 'MANUAL_HEADLINE'
  | 'MANUAL_STATEMENT'
  | 'MANUAL_SUBJECTS'
  | 'MANUAL_REACTION'
  | 'MANUAL_PUNCHLINE';

export type WhatsAppMode = 'viral' | 'manual';

export interface ViralSlotInfo {
  slot: number;           // 1-based
  label?: string;
  subject?: string;
}

export interface ViralSlotOverride {
  slot: number;           // 1-based
  path: string;
}

export interface ManualSubject {
  path: string;
  mimeType: string;
  label?: string;
}

@Schema({ timestamps: true })
export class WhatsAppSession {
  @Prop({ required: true, unique: true, index: true })
  phoneNumber: string;

  @Prop({ required: true, default: 'IDLE' })
  state: WhatsAppState;

  @Prop({ type: String, default: null })
  referenceImagePath: string | null;

  @Prop({ type: String, default: null })
  referenceMimeType: string | null;

  @Prop({ type: String, default: null })
  reactionImagePath: string | null;

  @Prop({ type: String, default: null })
  reactionMimeType: string | null;

  @Prop({ type: String, default: null })
  punchline: string | null;

  @Prop({ type: String, default: null })
  reactionContext: string | null;

  /** Saved analysis of the reference (viral flow), reused when the user supplies a missing image. */
  @Prop({ type: String, default: null })
  viralDraftId: string | null;

  @Prop({ type: [{ _id: false, slot: Number, label: String, subject: String }], default: [] })
  viralSlots: ViralSlotInfo[];

  /** Pictures the user sent for slots discovery could not fill. */
  @Prop({ type: [{ _id: false, slot: Number, path: String }], default: [] })
  viralOverrides: ViralSlotOverride[];

  /** Slots still waiting for a picture from the user (first one is the one asked about). */
  @Prop({ type: [Number], default: [] })
  viralMissing: number[];

  /** 'manual' while the own-edit (non-viral) flow is in progress. */
  @Prop({ type: String, default: 'viral' })
  mode: WhatsAppMode;

  @Prop({ type: String, default: null })
  manualMemeType: string | null;

  /** Saved layout chosen for the manual flow (null = one of the built-in types). */
  @Prop({ type: String, default: null })
  manualFormatId: string | null;

  /** Exact number of subject images the chosen saved layout needs (null = free choice, 'done' to finish). */
  @Prop({ type: Number, default: null })
  manualSlotCount: number | null;

  /** Layout just learned from an example, waiting for the user to name it. */
  @Prop({ type: String, default: null })
  pendingFormatId: string | null;

  @Prop({ type: String, default: null })
  manualHeadline: string | null;

  @Prop({ type: String, default: null })
  manualStatement: string | null;

  @Prop({ type: [{ _id: false, path: String, mimeType: String, label: String }], default: [] })
  manualSubjects: ManualSubject[];

  @Prop({ type: String, default: null })
  lastGeneratedMemeId: string | null;

  @Prop({ type: String, default: null })
  lastGeneratedImageUrl: string | null;

  @Prop({ type: String, default: null })
  lastGeneratedCaption: string | null;
}

export const WhatsAppSessionSchema = SchemaFactory.createForClass(WhatsAppSession);

