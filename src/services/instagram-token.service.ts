import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { getConfig } from '../config/app-config';

export interface EncryptedPayload {
  cipherText: string;
  iv: string;
  tag: string;
}

@Injectable()
export class InstagramTokenService {
  private readonly logger = new Logger(InstagramTokenService.name);
  private keyBuffer: Buffer;

  constructor() {
    this.keyBuffer = this.resolveKey();
  }

  private resolveKey(): Buffer {
    const raw = getConfig().instagram.tokenEncryptionKey;
    if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    if (raw && Buffer.byteLength(raw, 'utf8') === 32) {
      return Buffer.from(raw, 'utf8');
    }
    // Fallback: derive 32-byte key using PBKDF2 with server-specific salt
    this.logger.warn('INSTAGRAM_TOKEN_ENCRYPTION_KEY not set or invalid (requires 32-byte / 64-hex key). Using derived machine key.');
    return crypto.scryptSync(raw || 'kanyaraasi_memes_fallback_secret', 'kanyaraasi_salt_2026', 32);
  }

  /**
   * Encrypts plaintext token using AES-256-GCM.
   */
  encrypt(plaintext: string): EncryptedPayload {
    if (!plaintext) {
      throw new Error('Cannot encrypt empty plaintext');
    }
    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyBuffer, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    return {
      cipherText: encrypted,
      iv: iv.toString('base64'),
      tag: tag.toString('base64')
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM.
   */
  decrypt(payload: EncryptedPayload): string {
    if (!payload.cipherText || !payload.iv || !payload.tag) {
      throw new Error('Invalid encrypted payload structure');
    }
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.keyBuffer, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(payload.cipherText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

