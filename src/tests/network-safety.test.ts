/**
 * Offline tests for outbound HTTP safety (SSRF) and politeness, using a local test server.
 * The local server is only reachable because the tests opt in with allowPrivateNetwork: the
 * production code never sets it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { isBlockedAddress, safeFetch, SafeFetchError, validateOutboundUrl, redactUrl } from '../security/safe-fetch';
import { hostKey, politeFetch } from '../security/polite-fetch';

describe('address classification', () => {
  const blocked = ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1', '2001:db8::1', 'not-an-ip'];
  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.183.14', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4007:80e::200e'];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe('URL validation before any network activity', () => {
  const bad = ['file:///etc/passwd', 'ftp://x.org/a', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://user:pass@example.com/', 'https://example.com:8443/x', 'http://localhost/x', 'http://foo.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'not a url'];
  for (const u of bad) {
    it(`refuses ${u}`, () => assert.throws(() => validateOutboundUrl(u), SafeFetchError));
  }
  it('accepts normal public https/http URLs', () => {
    assert.equal(validateOutboundUrl('https://upload.wikimedia.org/a.jpg').hostname, 'upload.wikimedia.org');
    assert.equal(validateOutboundUrl('http://example.com/a.jpg').protocol, 'http:');
  });
  it('redacts keys from URLs before logging', () => {
    assert.equal(redactUrl('https://x/y?q=a&key=SECRET&cx=ID'), 'https://x/y?q=a&key=***&cx=***');
  });
  it('groups subdomains of one organisation for politeness', () => {
    assert.equal(hostKey('https://upload.wikimedia.org/x'), hostKey('https://commons.wikimedia.org/y'));
  });
});

describe('safeFetch against a local server (test-only private access)', () => {
  let server: http.Server;
  let base = '';
  let hits429 = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      const u = req.url || '/';
      if (u === '/ok') return res.end('hello');
      if (u === '/declared-big') {
        res.writeHead(200, { 'Content-Length': String(5 * 1024 * 1024) });
        return res.end();
      }
      if (u === '/stream-big') {
        res.writeHead(200);
        const chunk = Buffer.alloc(64 * 1024);
        let sent = 0;
        const t = setInterval(() => {
          if (sent++ > 40 || res.destroyed) {
            clearInterval(t);
            return res.end();
          }
          res.write(chunk);
        }, 1);
        return;
      }
      if (u === '/slow') return; // never answers
      if (u === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      }
      if (u === '/to-file') {
        res.writeHead(302, { Location: 'file:///etc/passwd' });
        return res.end();
      }
      if (u === '/to-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      }
      if (u === '/429-once') {
        if (hits429++ === 0) {
          res.writeHead(429, { 'Retry-After': '0' });
          return res.end();
        }
        return res.end('finally');
      }
      if (u === '/429-always') {
        res.writeHead(429, { 'Retry-After': '0' });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const opts = { timeoutMs: 2000, maxBytes: 1024 * 1024, allowPrivateNetwork: true };

  it('without the test opt-in, the local server is unreachable', async () => {
    await assert.rejects(() => safeFetch(`${base}/ok`, { timeoutMs: 2000, maxBytes: 1000 }), SafeFetchError);
  });

  it('fetches a normal body', async () => {
    const r = await safeFetch(`${base}/ok`, opts);
    assert.equal(r.body.toString(), 'hello');
  });

  it('refuses a declared oversized body and stops a streamed one at the cap', async () => {
    await assert.rejects(() => safeFetch(`${base}/declared-big`, opts), (e: any) => e.code === 'TOO_LARGE');
    await assert.rejects(() => safeFetch(`${base}/stream-big`, opts), (e: any) => e.code === 'TOO_LARGE');
  });

  it('times out a server that never answers', async () => {
    const t = Date.now();
    await assert.rejects(() => safeFetch(`${base}/slow`, { ...opts, timeoutMs: 300 }), (e: any) => e.code === 'TIMEOUT' || e.code === 'NETWORK');
    assert.ok(Date.now() - t < 3000);
  });

  it('re-validates every redirect: loops, file: and metadata targets are refused', async () => {
    await assert.rejects(() => safeFetch(`${base}/loop`, opts), (e: any) => e.code === 'TOO_MANY_REDIRECTS');
    await assert.rejects(() => safeFetch(`${base}/to-file`, opts), (e: any) => e.code === 'BLOCKED_URL');
    await assert.rejects(() => safeFetch(`${base}/to-metadata`, { ...opts, allowPrivateNetwork: false }), (e: any) => e instanceof SafeFetchError);
  });

  it('politeFetch retries a 429 once and succeeds; gives up after bounded retries', async () => {
    const r = await politeFetch(`${base}/429-once`, opts);
    assert.equal(r.body.toString(), 'finally');
    const t = Date.now();
    await assert.rejects(() => politeFetch(`${base}/429-always`, opts), (e: any) => e.status === 429);
    assert.ok(Date.now() - t < 10_000, 'bounded');
  });
});
