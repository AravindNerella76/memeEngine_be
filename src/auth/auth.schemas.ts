import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuthUserDocument = AuthUser & Document;
export type AuthSessionDocument = AuthSession & Document;

/** The owner account. There is no public sign-up: it is created from the command line (npm run auth:create-owner). */
@Schema({ timestamps: true, collection: 'auth_users' })
export class AuthUser {
  /** Lower-case, trimmed. May be an e-mail address. */
  @Prop({ required: true, unique: true, index: true })
  username: string;

  /** scrypt$N$r$p$salt$hash. Never leaves the server. */
  @Prop({ required: true })
  passwordHash: string;

  @Prop({ type: Date, default: null })
  passwordChangedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;
}
export const AuthUserSchema = SchemaFactory.createForClass(AuthUser);

/** A sign-in. Only the SHA-256 of the cookie value is stored. MongoDB removes the document after expiresAt. */
@Schema({ timestamps: true, collection: 'auth_sessions' })
export class AuthSession {
  @Prop({ required: true, unique: true, index: true })
  tokenHash: string;

  @Prop({ required: true, index: true })
  userId: string;

  /** Idle expiry: pushed forward while the session is used, never past absoluteExpiresAt. */
  @Prop({ type: Date, required: true, index: { expireAfterSeconds: 0 } })
  expiresAt: Date;

  /** Hard limit from the moment of sign-in. */
  @Prop({ type: Date, required: true })
  absoluteExpiresAt: Date;

  @Prop({ type: Date, default: () => new Date() })
  lastSeenAt: Date;

  @Prop({ type: String, default: '' })
  userAgent: string;

  @Prop({ type: String, default: '' })
  ip: string;
}
export const AuthSessionSchema = SchemaFactory.createForClass(AuthSession);
