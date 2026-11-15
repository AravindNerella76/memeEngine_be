import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WhatsAppCredentialsDocument = WhatsAppCredentials & Document;

/**
 * The WhatsApp settings the owner saved in the app (Settings > WhatsApp): access token, phone number ID,
 * verify token, app secret and allowed phone. They take the place of the server's .env values, so an expired
 * token (or any other value) can be replaced without editing server files or redeploying. One document, key
 * "default". The three secrets are stored encrypted (AES-256-GCM) and are never returned by any endpoint.
 */
@Schema({ timestamps: true, collection: 'whatsapp_credentials' })
export class WhatsAppCredentials {
  @Prop({ required: true, unique: true, default: 'default' })
  key: string;

  @Prop({ type: String, default: null })
  encryptedAccessToken: string | null;

  @Prop({ type: String, default: null })
  iv: string | null;

  @Prop({ type: String, default: null })
  tag: string | null;

  /** Last 4 characters of the token, only to recognise which one is saved. */
  @Prop({ type: String, default: null })
  tokenLast4: string | null;

  @Prop({ type: Date, default: null })
  tokenSavedAt: Date | null;

  /** From Meta when the token was saved; null when unknown or when the token does not expire. */
  @Prop({ type: Date, default: null })
  tokenExpiresAt: Date | null;

  /** Saved phone number ID; null = use the server setting. */
  @Prop({ type: String, default: null })
  phoneNumberId: string | null;

  /** Webhook verify token (encrypted). The same value is entered in Meta when the webhook is saved. */
  @Prop({ type: String, default: null })
  encryptedVerifyToken: string | null;

  @Prop({ type: String, default: null })
  verifyTokenIv: string | null;

  @Prop({ type: String, default: null })
  verifyTokenTag: string | null;

  @Prop({ type: String, default: null })
  verifyTokenLast4: string | null;

  /** Meta app secret (encrypted): proves a webhook message really came from Meta. */
  @Prop({ type: String, default: null })
  encryptedAppSecret: string | null;

  @Prop({ type: String, default: null })
  appSecretIv: string | null;

  @Prop({ type: String, default: null })
  appSecretTag: string | null;

  @Prop({ type: String, default: null })
  appSecretLast4: string | null;

  /** The only phone number allowed to use the bot (digits with country code); null = use the server setting. */
  @Prop({ type: String, default: null })
  allowedPhone: string | null;
}

export const WhatsAppCredentialsSchema = SchemaFactory.createForClass(WhatsAppCredentials);
