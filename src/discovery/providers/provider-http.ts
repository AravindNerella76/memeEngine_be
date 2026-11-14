/**
 * HTTP access for search providers. All traffic goes through safeFetch (SSRF-safe, size/time caps).
 * Tests replace the implementation with a fake that serves fixtures.
 */
import { createHash } from 'crypto';
import { getConfig } from '../../config/app-config';
import { SafeFetchError } from '../../security/safe-fetch';
import { politeFetch } from '../../security/polite-fetch';
import { classifyLicense } from '../rights';

export interface ProviderHttp {
  getJson<T = any>(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<T>;
  getText(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<string>;
  /** JSON POST (no redirects are followed). */
  postJson<T = any>(url: string, body: unknown, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<T>;
}

function parseJson<T>(buf: Buffer): T {
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new SafeFetchError('BAD_JSON', 'Response was not valid JSON');
  }
}

export const defaultProviderHttp: ProviderHttp = {
  async postJson<T>(url: string, body: unknown, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
    const cfg = getConfig().discovery;
    const r = await politeFetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? cfg.requestTimeoutMs,
      userAgent: cfg.userAgent,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
      maxBytes: 3 * 1024 * 1024
    });
    return parseJson<T>(r.body);
  },
  async getJson<T>(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
    const cfg = getConfig().discovery;
    const r = await politeFetch(url, { timeoutMs: opts.timeoutMs ?? cfg.requestTimeoutMs, userAgent: cfg.userAgent, headers: { Accept: 'application/json', ...(opts.headers || {}) }, maxBytes: 3 * 1024 * 1024 });
    try {
      return JSON.parse(r.body.toString('utf8')) as T;
    } catch {
      throw new SafeFetchError('BAD_JSON', 'Response was not valid JSON');
    }
  },
  async getText(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
    const cfg = getConfig().discovery;
    const r = await politeFetch(url, { timeoutMs: opts.timeoutMs ?? cfg.requestTimeoutMs, userAgent: cfg.userAgent, headers: opts.headers, maxBytes: 3 * 1024 * 1024 });
    return r.body.toString('utf8');
  }
};

export function stripHtml(s: unknown, max = 400): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

export function candidateId(provider: string, url: string): string {
  return `${provider}:${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
}

/** Openly licensed for editing and reuse (NonCommercial / NoDerivatives licences are NOT). */
export function isFreeLicense(license?: string): boolean {
  return classifyLicense(license).classification === 'open_license';
}

export function isAcceptedMime(mime?: string): boolean {
  return !mime || /^image\/(jpeg|png|webp)$/i.test(mime);
}

export function isAcceptedImageUrl(url?: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !/\.(svg|gif|tiff?|pdf|ico|bmp|heic)(\?|$)/i.test(url);
}
