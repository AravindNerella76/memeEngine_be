/**
 * SSRF-safe HTTP(S) client for every outbound request (search providers and image downloads).
 *
 *  - only http/https on ports 80/443, no credentials in URLs;
 *  - the IP address is checked AT CONNECTION TIME (custom DNS lookup), so private, loopback,
 *    link-local, metadata and other reserved addresses are refused even under DNS rebinding;
 *  - redirects are followed manually (max 3) and every hop is re-validated;
 *  - one deadline covers the whole exchange; the body is streamed with a hard size cap;
 *  - no compression (identity), so the size cap is the real size.
 */
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

export type SafeFetchErrorCode =
  | 'BLOCKED_URL'
  | 'BLOCKED_ADDRESS'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'HTTP_ERROR'
  | 'NETWORK'
  | 'TOO_MANY_REDIRECTS'
  | 'BAD_JSON'
  | 'ABORTED';

export class SafeFetchError extends Error {
  /** Server-requested wait (Retry-After) for 429/503 responses, in ms. */
  retryAfterMs?: number;
  constructor(public readonly code: SafeFetchErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  /** GET (default) or POST. POST requests never follow redirects. */
  method?: 'GET' | 'POST';
  /** Request body (POST only). */
  body?: Buffer | string;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Tests only: allow loopback/private targets (e.g. a local test server). */
  allowPrivateNetwork?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (net.isIPv4(maybeV4)) {
    const n = ipv4ToInt(maybeV4);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (parts.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...rest].map(g => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some(g => !Number.isFinite(g))) return null;
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

/** True for every address that must never be contacted from the server. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Blocked(ip);
  if (!net.isIPv6(ip)) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true; // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / NAT64 (64:ff9b::/96): check the embedded IPv4
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if (g[0] === 0x2002) return v4Blocked(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  return false;
}

/** Validates the URL shape before any network activity. */
export function validateOutboundUrl(raw: string, allowPrivate = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError('BLOCKED_URL', 'Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SafeFetchError('BLOCKED_URL', `Protocol ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new SafeFetchError('BLOCKED_URL', 'Credentials in URLs are not allowed');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!allowPrivate && port !== 80 && port !== 443) throw new SafeFetchError('BLOCKED_URL', `Port ${port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SafeFetchError('BLOCKED_URL', 'URL has no host');
  if (!allowPrivate) {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
      throw new SafeFetchError('BLOCKED_URL', `Host ${host} is not allowed`);
    }
    if (net.isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('BLOCKED_ADDRESS', `Address ${host} is not allowed`);
  }
  return u;
}

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: any, callback: any) => {
    const opts = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addresses) => {
      if (err) return callback(err);
      const list = (addresses as dns.LookupAddress[]) || [];
      if (!list.length) return callback(new SafeFetchError('NETWORK', `No address for ${hostname}`));
      if (!allowPrivate && list.some(a => isBlockedAddress(a.address))) {
        return callback(new SafeFetchError('BLOCKED_ADDRESS', `${hostname} resolves to a private or reserved address`));
      }
      if (opts.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

function requestOnce(u: URL, opts: SafeFetchOptions, deadline: number): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const method = opts.method === 'POST' ? 'POST' : 'GET';
    const body = method === 'POST' && opts.body !== undefined ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8')) : null;
    const req = mod.request(
      u,
      {
        method,
        headers: {
          'User-Agent': opts.userAgent || 'MemeAdaptationEngine/2.0',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...(opts.headers || {}),
          ...(body ? { 'Content-Length': String(body.length) } : {})
        },
        lookup: guardedLookup(Boolean(opts.allowPrivateNetwork)) as any,
        timeout: remaining
      },
      res => resolve({ res, req })
    );
    req.on('timeout', () => req.destroy(new SafeFetchError('TIMEOUT', `Request timed out after ${opts.timeoutMs}ms`)));
    req.on('error', err => reject(err instanceof SafeFetchError ? err : new SafeFetchError('NETWORK', err.message)));
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new SafeFetchError('ABORTED', 'Request aborted'));
      opts.signal.addEventListener('abort', () => req.destroy(new SafeFetchError('ABORTED', 'Request aborted')), { once: true });
    }
    if (body) req.end(body);
    else req.end();
  });
}

function readCapped(res: http.IncomingMessage, maxBytes: number, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      return reject(new SafeFetchError('TOO_LARGE', `Response is ${declared} bytes; the limit is ${maxBytes}`));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => res.destroy(new SafeFetchError('TIMEOUT', 'Body download timed out')), Math.max(1, deadline - Date.now()));
    res.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        res.destroy(new SafeFetchError('TOO_LARGE', `Response exceeds the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on('error', err => {
      clearTimeout(timer);
      reject(err instanceof SafeFetchError ? err : new SafeFetchError('NETWORK', err.message));
    });
    res.on('close', () => {
      clearTimeout(timer);
      if (!res.complete && total <= maxBytes) reject(new SafeFetchError('NETWORK', 'Connection closed before the body completed'));
    });
  });
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = validateOutboundUrl(rawUrl, opts.allowPrivateNetwork);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (Date.now() >= deadline) throw new SafeFetchError('TIMEOUT', `Request timed out after ${opts.timeoutMs}ms`);
    const { res } = await requestOnce(current, opts, deadline);
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (opts.method === 'POST') throw new SafeFetchError('BLOCKED_URL', 'Redirects are not followed for POST requests');
      let next: string;
      try {
        next = new URL(res.headers.location, current).toString();
      } catch {
        throw new SafeFetchError('BLOCKED_URL', 'Invalid redirect location');
      }
      current = validateOutboundUrl(next, opts.allowPrivateNetwork);
      continue;
    }
    if (status < 200 || status >= 300) {
      let errorDetail = '';
      try {
        const errBuf = await readCapped(res, 4096, deadline);
        const text = errBuf.toString('utf8');
        try {
          const parsed = JSON.parse(text);
          errorDetail = parsed?.error?.message || parsed?.message || text.slice(0, 200);
        } catch {
          errorDetail = text.slice(0, 200);
        }
      } catch {
        res.resume();
      }
      const msg = errorDetail ? `HTTP ${status}: ${errorDetail}` : `HTTP ${status}`;
      const err = new SafeFetchError('HTTP_ERROR', msg, status);
      (err as any).responseBody = errorDetail;
      const ra = res.headers['retry-after'];
      if (ra && (status === 429 || status === 503)) {
        const secs = Number(ra);
        err.retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(String(ra)) - Date.now()) || undefined;
      }
      throw err;
    }
    const body = await readCapped(res, opts.maxBytes, deadline);
    return { status, headers: res.headers, body, finalUrl: current.toString() };
  }
  throw new SafeFetchError('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects`);
}

export async function safeFetchJson<T = any>(url: string, opts: Omit<SafeFetchOptions, 'maxBytes'> & { maxBytes?: number }): Promise<T> {
  const r = await safeFetch(url, { maxBytes: 3 * 1024 * 1024, ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  try {
    return JSON.parse(r.body.toString('utf8')) as T;
  } catch {
    throw new SafeFetchError('BAD_JSON', 'Response was not valid JSON');
  }
}

/** Removes secrets from URLs before logging them. */
export function redactUrl(u: string): string {
  return u.replace(/([?&](key|api_key|apikey|token|access_token|cx)=)[^&]*/gi, '$1***');
}
