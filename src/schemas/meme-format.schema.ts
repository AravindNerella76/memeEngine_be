import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import type { GridSpec, ImageArrangementMode, MemeType } from '../types/meme.types';

export type MemeFormatDocument = MemeFormat & Document;

export type FormatSource = 'whatsapp' | 'viral_auto' | 'api';

/**
 * A meme LAYOUT learned from an example meme of the community (how many image slots, how they are
 * arranged and sized, header and reaction panel). It never stores fonts or colours: those always come
 * from the global Settings.
 */
@Schema({ timestamps: true, collection: 'meme_formats' })
export class MemeFormat {
  @Prop({ required: true, unique: true, index: true })
  formatId: string;

  /** Chosen by the user; null while the layout is only auto-saved. */
  @Prop({ type: String, default: null })
  name: string | null;

  /** Structure fingerprint: two examples with the same structure are the same layout. */
  @Prop({ required: true, unique: true, index: true })
  signature: string;

  @Prop({ type: String, required: true })
  source: FormatSource;

  @Prop({ type: String, required: true })
  memeType: MemeType;

  @Prop({ type: String, default: 'other' })
  memeFormat: string;

  @Prop({ type: String, required: true })
  arrangement: ImageArrangementMode;

  @Prop({ type: Object, default: null })
  grid: GridSpec | null;

  @Prop({ required: true })
  slotCount: number;

  /** Image slots per row, top to bottom (e.g. [2, 1]). */
  @Prop({ type: [Number], default: [] })
  rows: number[];

  @Prop({ default: false })
  hasHeader: boolean;

  @Prop({ type: Number, default: null })
  headerHeightRatio: number | null;

  @Prop({ default: false })
  hasStatement: boolean;

  @Prop({ default: false })
  hasBullets: boolean;

  @Prop({ default: false })
  hasReactionPanel: boolean;

  @Prop({ type: Number, default: null })
  reactionHeightRatio: number | null;

  /** File name (inside /output) of a small preview of the example. */
  @Prop({ type: String, default: null })
  thumbnailFile: string | null;

  /** How many times this structure was seen or used. */
  @Prop({ default: 1 })
  usageCount: number;

  @Prop({ type: Date, default: null })
  lastUsedAt: Date | null;
}

export const MemeFormatSchema = SchemaFactory.createForClass(MemeFormat);
