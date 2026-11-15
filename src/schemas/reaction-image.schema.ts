import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReactionImageDocument = ReactionImage & Document;

/**
 * One picture of the owner's reaction library (a movie moment used for the bottom "reaction" panel), kept in the
 * database itself so it survives redeploys on hosts with a temporary disk. The two Buffers are never selected by
 * default: listings stay small, and the bytes are read only to serve one image.
 */
@Schema({ timestamps: true, collection: 'reaction_images' })
export class ReactionImage {
  @Prop({ required: true, unique: true, index: true })
  imageId: string;

  /** The folder it is filed under: "shocking", "sad funny", "brahmi laughing"... lower case, free-form. */
  @Prop({ required: true, index: true })
  category: string;

  /** Optional title. File names like FB_IMG_1742285803405 are not kept. */
  @Prop({ type: String, default: '' })
  name: string;

  /** Subjects and situations to find it by: "brahmanandam", "theatre", "interval". */
  @Prop({ type: [String], default: [], index: true })
  tags: string[];

  /** Fingerprint of the file as sent: the same picture is never stored twice. */
  @Prop({ required: true, unique: true, index: true })
  sha256: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  width: number;

  @Prop({ required: true })
  height: number;

  @Prop({ required: true })
  bytes: number;

  @Prop({ type: Buffer, required: true, select: false })
  data: Buffer;

  @Prop({ type: Buffer, required: true, select: false })
  thumb: Buffer;

  @Prop({ type: String, default: 'image/jpeg' })
  thumbMime: string;

  @Prop({ default: 0 })
  usedCount: number;

  @Prop({ type: Date, default: null, index: true })
  lastUsedAt: Date | null;
}

export const ReactionImageSchema = SchemaFactory.createForClass(ReactionImage);
