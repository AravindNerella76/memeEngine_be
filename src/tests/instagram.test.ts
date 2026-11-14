import '../config/load-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramTokenService } from '../services/instagram-token.service';
import { InstagramOAuthService } from '../services/instagram-oauth.service';

describe('Instagram token encryption service', () => {
  const tokenService = new InstagramTokenService();

  it('encrypts and decrypts an access token accurately', () => {
    const rawToken = 'EAAR123456789_SampleLongLivedToken_ABCDEF0123456789';
    const encrypted = tokenService.encrypt(rawToken);

    assert.ok(encrypted.cipherText, 'cipherText must be present');
    assert.ok(encrypted.iv, 'iv must be present');
    assert.ok(encrypted.tag, 'tag must be present');
    assert.notEqual(encrypted.cipherText, rawToken, 'cipherText must not match raw token');

    const decrypted = tokenService.decrypt(encrypted);
    assert.equal(decrypted, rawToken, 'decrypted token must match original token');
  });

  it('generates unique IV and ciphertext for identical plaintexts', () => {
    const rawToken = 'EAAR123456789_DuplicateToken';
    const first = tokenService.encrypt(rawToken);
    const second = tokenService.encrypt(rawToken);

    assert.notEqual(first.iv, second.iv, 'each encryption must generate a unique IV');
    assert.notEqual(first.cipherText, second.cipherText, 'ciphertexts must differ due to unique IV');
    assert.equal(tokenService.decrypt(first), rawToken);
    assert.equal(tokenService.decrypt(second), rawToken);
  });

  it('rejects tampered cipherText with authentication error', () => {
    const rawToken = 'EAAR_OriginalToken';
    const encrypted = tokenService.encrypt(rawToken);

    // Tamper with ciphertext
    const tampered = {
      ...encrypted,
      cipherText: Buffer.from('corrupted_base64_data').toString('base64')
    };

    assert.throws(() => tokenService.decrypt(tampered));
  });

  it('rejects empty plaintext encryption', () => {
    assert.throws(() => tokenService.encrypt(''));
  });
});

describe('Instagram OAuth URL and CSRF state management', () => {
  const tokenService = new InstagramTokenService();
  // Mock model for unit test
  const mockModel: any = {
    findOne: () => ({ sort: () => ({ exec: async () => null }) }),
    updateMany: async () => ({})
  };
  const oauthService = new InstagramOAuthService(mockModel, tokenService);

  it('generates a valid Meta OAuth URL with required parameters', () => {
    const { url, state } = oauthService.generateAuthUrl();

    assert.ok(url.startsWith('https://www.facebook.com/v21.0/dialog/oauth'), 'must point to Facebook v21.0 dialog endpoint');
    assert.ok(url.includes('client_id=1157226127472052'), 'must include client_id');
    assert.ok(url.includes('config_id=1684279023426778'), 'must include config_id');
    assert.ok(url.includes('redirect_uri='), 'must include redirect_uri');
    assert.ok(url.includes(`state=${state}`), 'must include state parameter');
    assert.ok(state.length >= 32, 'state must be a cryptographically strong token');
  });

  it('validates state and prevents replay attacks (consumed on use)', () => {
    const { state } = oauthService.generateAuthUrl();

    // First validation should succeed
    const firstCheck = oauthService.validateState(state);
    assert.equal(firstCheck, true, 'first validation must succeed');

    // Replay with the same state should fail
    const replayCheck = oauthService.validateState(state);
    assert.equal(replayCheck, false, 'replay attempt must fail');
  });

  it('rejects invalid or unknown state values', () => {
    assert.equal(oauthService.validateState('non-existent-state-value'), false);
    assert.equal(oauthService.validateState(''), false);
  });

  it('never exposes tokens or secrets in sanitized account', async () => {
    const sanitized = await oauthService.getSanitizedAccount();
    assert.equal(sanitized.connected, false);
    assert.ok('metaConfigured' in sanitized);
    assert.ok('missingSecret' in sanitized);
    assert.equal((sanitized as any).accessToken, undefined);
    assert.equal((sanitized as any).encryptedAccessToken, undefined);
    assert.equal((sanitized as any).metaAppSecret, undefined);
  });
});

import { InstagramPublisherService } from '../services/instagram-publisher.service';

describe('Instagram Publisher service validation & concurrency', () => {
  const mockMemeModel: any = {
    findOne: () => ({ exec: async () => null }),
    updateOne: async () => ({})
  };
  const mockOAuthService: any = {
    getDecryptedTokenForPublishing: async () => null
  };

  const publisher = new InstagramPublisherService(mockMemeModel, mockOAuthService);

  it('rejects publishing without memeId', async () => {
    await assert.rejects(
      async () => publisher.publishMeme('', 1, 'My caption'),
      { name: 'BadRequestException', message: 'memeId is required.' }
    );
  });

  it('rejects empty or whitespace captions', async () => {
    await assert.rejects(
      async () => publisher.publishMeme('test_meme', 1, '   '),
      { name: 'BadRequestException', message: 'Caption is required.' }
    );
  });

  it('rejects captions exceeding 2200 characters', async () => {
    const longCaption = 'A'.repeat(2201);
    await assert.rejects(
      async () => publisher.publishMeme('test_meme', 1, longCaption),
      (err: any) => err.name === 'BadRequestException' && err.message.includes('exceeds Instagram limit')
    );
  });

  it('rejects publishing when no connected Instagram account exists', async () => {
    await assert.rejects(
      async () => publisher.publishMeme('test_meme', 1, 'Valid caption #memes'),
      (err: any) => err.name === 'BadRequestException' && err.message.includes('No connected Instagram account found')
    );
  });
});
