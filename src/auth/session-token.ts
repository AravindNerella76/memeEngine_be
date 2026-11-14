import * as crypto from 'crypto';

/** 256 random bits, URL-safe (43 characters). Only its SHA-256 is stored, so a leaked database cannot be replayed as sessions. */
export const newSessionToken = (): string => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
export const isWellFormedToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
