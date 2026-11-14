import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WhatsAppSessionDocument = WhatsAppSession & Document;

export type WhatsAppState =
  | 'IDLE'
  | 'AWAITING_REACTION'
  | 'AWAITING_PUNCHLINE'
  | 'GENERATING'
  | 'AWAITING_APPROVAL'
  // manual (own edit) flow
  | 'MANUAL_TYPE'
  | 'MANUAL_HEADLINE'
  | 'MANUAL_STATEMENT'
  | 'MANUAL_SUBJECTS'
  | 'MANUAL_REACTION'
  | 'MANUAL_PUNCHLINE';

export type WhatsAppMode = 'viral' | 'manual';

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

  /** 'manual' while the own-edit (non-viral) flow is in progress. */
  @Prop({ type: String, default: 'viral' })
  mode: WhatsAppMode;

  @Prop({ type: String, default: null })
  manualMemeType: string | null;

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

