import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PushDeviceDocument = PushDevice & Document;
export type PushKeysDocument = PushKeys & Document;

/** What a device can be told about. Each device chooses its own. */
export const PUSH_KINDS = ['meme', 'security'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** A browser that allowed notifications (one per browser profile and device). */
@Schema({ timestamps: true, collection: 'push_devices' })
export class PushDevice {
  /** The push service address the browser gave us (unique per subscription). */
  @Prop({ required: true, unique: true, index: true })
  endpoint: string;

  @Prop({ required: true })
  p256dh: string;

  @Prop({ required: true })
  auth: string;

  /** The sign-in that subscribed it: a device that is signed out stops receiving anything. */
  @Prop({ required: true, index: true })
  sessionHash: string;

  @Prop({ type: String, default: '' })
  userAgent: string;

  @Prop({ type: [String], default: () => [...PUSH_KINDS] })
  kinds: PushKind[];

  @Prop({ type: Date, default: null })
  lastSuccessAt: Date | null;

  @Prop({ type: Number, default: 0 })
  failures: number;

  @Prop({ type: String, default: '' })
  lastError: string;
}
export const PushDeviceSchema = SchemaFactory.createForClass(PushDevice);

/** The server's own key pair for signing pushes (VAPID). Made once; the private half is stored encrypted. */
@Schema({ timestamps: true, collection: 'push_keys' })
export class PushKeys {
  @Prop({ required: true, unique: true, default: 'vapid' })
  name: string;

  @Prop({ required: true })
  publicKey: string;

  @Prop({ type: Object, required: true })
  privateKey: { cipherText: string; iv: string; tag: string };
}
export const PushKeysSchema = SchemaFactory.createForClass(PushKeys);
