import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type InstagramAccountDocument = InstagramAccount & Document;

export type InstagramConnectionStatus = 'connected' | 'disconnected' | 'expired' | 'revoked';

@Schema({ timestamps: true })
export class InstagramAccount {
  @Prop({ required: true, unique: true, index: true })
  instagramUserId: string;

  @Prop({ required: true, index: true })
  username: string;

  @Prop()
  name?: string;

  @Prop()
  profilePictureUrl?: string;

  @Prop()
  facebookPageId?: string;

  @Prop()
  facebookPageName?: string;

  /** AES-256-GCM encrypted long-lived User Access Token */
  @Prop({ required: true })
  encryptedAccessToken: string;

  @Prop({ required: true })
  iv: string;

  @Prop({ required: true })
  tag: string;

  /** AES-256-GCM encrypted Page Access Token (optional, used for publishing if available) */
  @Prop()
  encryptedPageAccessToken?: string;

  @Prop()
  pageIv?: string;

  @Prop()
  pageTag?: string;

  @Prop({ default: 'Bearer' })
  tokenType: string;

  @Prop()
  tokenExpiresAt?: Date;

  @Prop({ type: [String], default: [] })
  scopes: string[];

  @Prop({ default: 'connected', index: true })
  status: InstagramConnectionStatus;

  @Prop({ default: Date.now })
  connectedAt: Date;

  @Prop({ default: Date.now })
  lastCheckedAt: Date;

  @Prop()
  lastError?: string;
}

export const InstagramAccountSchema = SchemaFactory.createForClass(InstagramAccount);

