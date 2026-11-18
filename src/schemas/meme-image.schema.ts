import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MemeImageDocument = MemeImage & Document;

/**
 * Persists the binary image bytes of generated memes in MongoDB so they survive
 * container restarts and redeploys on hosts with an ephemeral filesystem (e.g. Render).
 * The buffers are marked with `select: false` so document listings stay fast and lightweight.
 */
@Schema({ timestamps: true, collection: 'meme_images' })
export class MemeImage {
  @Prop({ required: true, index: true })
  memeId: string;

  @Prop({ required: true, default: 1 })
  version: number;

  @Prop({ type: Buffer, required: true, select: false })
  jpeg: Buffer;

  @Prop({ type: Buffer, select: false })
  png?: Buffer;

  @Prop({ type: Buffer, select: false })
  thumb?: Buffer;

  @Prop({ type: [Object], select: false })
  subjects?: { index: number; data: Buffer; mime: string }[];
}

export const MemeImageSchema = SchemaFactory.createForClass(MemeImage);
MemeImageSchema.index({ memeId: 1, version: 1 }, { unique: true });
