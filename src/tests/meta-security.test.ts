/** Offline tests for the public-tunnel guard and Meta webhook signature verification. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { isTunnelPathAllowed, tunnelPathGuard, verifyMetaSignature } from '../security/http-guards';
import { loadConfig } from '../config/app-config';

function run(host: string, method: string, path: string): number {
  let status = 200;
  const res: any = { status: (c: number) => ((status = c), res), json: () => res };
  tunnelPathGuard()({ headers: { host }, method, path } as any, res, () => {});
  return status;
}

describe('tunnel path guard', () => {
  it('allows only Meta endpoints and generated images through the tunnel', () => {
    assert.equal(isTunnelPathAllowed('POST', '/api/whatsapp/webhook'), true);
    assert.equal(isTunnelPathAllowed('GET', '/api/instagram/auth/callback'), true);
    assert.equal(isTunnelPathAllowed('GET', '/output/abc.jpeg'), true);
    assert.equal(isTunnelPathAllowed('POST', '/api/instagram/publish'), false);
    assert.equal(isTunnelPathAllowed('DELETE', '/api/instagram/account'), false);
    assert.equal(isTunnelPathAllowed('PUT', '/api/settings'), false);
    assert.equal(isTunnelPathAllowed('GET', '/output/../.env'), false);
  });
  it('blocks API calls on the tunnel host but not on loopback', () => {
    assert.equal(run('x.ngrok-free.dev', 'POST', '/api/instagram/publish'), 403);
    assert.equal(run('x.ngrok-free.dev', 'POST', '/api/whatsapp/webhook'), 200);
    assert.equal(run('localhost:3000', 'POST', '/api/instagram/publish'), 200);
    assert.equal(run('127.0.0.1:3000', 'DELETE', '/api/instagram/account'), 200);
  });
});

describe('Meta signature', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  it('accepts a valid signature and rejects everything else', () => {
    assert.equal(verifyMetaSignature(body, sig, secret), true);
    assert.equal(verifyMetaSignature(body, sig, 'other'), false);
    assert.equal(verifyMetaSignature(Buffer.from('tampered'), sig, secret), false);
    assert.equal(verifyMetaSignature(body, undefined, secret), false);
    assert.equal(verifyMetaSignature(body, sig, undefined), false);
    assert.equal(verifyMetaSignature(undefined, sig, secret), false);
    assert.equal(verifyMetaSignature(body, 'sha256=short', secret), false);
  });
});

describe('whatsapp config fails closed', () => {
  it('has no default verify token or allowed phone, and normalises the phone', () => {
    const c = loadConfig({} as any);
    assert.equal(c.whatsapp.verifyToken, '');
    assert.equal(c.whatsapp.allowedPhone, '');
    assert.equal(loadConfig({ WHATSAPP_ALLOWED_PHONE: '+91 93477-08120' } as any).whatsapp.allowedPhone, '919347708120');
    assert.equal(loadConfig({ WHATSAPP_ALLOWED_PHONE: '+91 93477-08120, 918885550123' } as any).whatsapp.allowedPhone, '919347708120,918885550123');
    assert.equal(loadConfig({ PUBLIC_BASE_URL: 'https://a.example/' } as any).instagram.publicBaseUrl, 'https://a.example');
  });

  it('a Render service knows its own public address without any setting, and an explicit setting still wins', () => {
    assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://studio-api.onrender.com' } as any).instagram.publicBaseUrl, 'https://studio-api.onrender.com');
    assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://studio-api.onrender.com/' } as any).instagram.publicBaseUrl, 'https://studio-api.onrender.com');
    assert.equal(loadConfig({ PUBLIC_BASE_URL: 'https://mine.example', RENDER_EXTERNAL_URL: 'https://studio-api.onrender.com' } as any).instagram.publicBaseUrl, 'https://mine.example');
    assert.match(loadConfig({} as any).instagram.publicBaseUrl, /^https:\/\//, 'with nothing set the old default still applies');
  });
});
