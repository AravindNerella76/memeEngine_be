/**
 * HTTP-level protections for a local, single-user API:
 *  - Host allow-list (stops DNS-rebinding: a hostile site resolving to 127.0.0.1)
 *  - Origin allow-list for state-changing requests (stops cross-site POST/DELETE, including
 *    "simple" multipart POSTs that CORS alone does not block)
 *  - defensive response headers
 *
 * These are the outer wall. The inner one is the sign-in guard (src/auth): every route needs a session
 * unless it is @Public(). Configure extra hosts/origins with ALLOWED_HOSTS / CORS_ORIGINS (comma lists),
 * and the host that serves the whole app with APP_HOSTS.
 */
import * as crypto from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { parseHostList } from '../config/app-config';

export interface GuardOptions {
  allowedHosts: string[];     // host names without port, lower-case ("localhost", "127.0.0.1", "[::1]")
  extraOrigins: string[];     // exact origins, e.g. "https://studio.example.com"
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

const csv = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

/** Origin ("https://host") of a URL, or null when it is not a valid http(s) URL. */
function originOf(url: string | undefined): string | null {
  try {
    const u = new URL(url || '');
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

export function defaultGuardOptions(env: NodeJS.ProcessEnv = process.env): GuardOptions {
  // APP_HOSTS: where the whole app is served behind login. Its own origins may make state-changing calls.
  const appHosts = parseHostList(env.APP_HOSTS);
  const publicOrigin = originOf(env.APP_PUBLIC_URL);
  return {
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...csv(env.ALLOWED_HOSTS).map(h => h.toLowerCase()), ...appHosts],
    extraOrigins: [...csv(env.CORS_ORIGINS), ...appHosts.map(h => `https://${h}`), ...(publicOrigin ? [publicOrigin] : [])]
  };
}

export function stripPort(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);   // [::1]:3000 -> [::1]
  return h.split(':')[0];
}

export function isHostAllowed(hostHeader: string | undefined, opts: GuardOptions): boolean {
  if (!hostHeader) return false;
  const h = stripPort(hostHeader);
  if (h.endsWith('.onrender.com') || h.endsWith('.railway.app') || h.endsWith('.vercel.app')) return true;
  return opts.allowedHosts.includes(h);
}

export function isOriginAllowed(origin: string | undefined, opts: GuardOptions): boolean {
  if (!origin) return false;
  if (LOCAL_ORIGIN.test(origin) || opts.extraOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.vercel.app') || host.endsWith('.onrender.com')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function hostAndOriginGuard(opts: GuardOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isHostAllowed(req.headers.host, opts)) {
      return res.status(403).json({ statusCode: 403, message: 'Host not allowed' });
    }
    const origin = req.headers.origin as string | undefined;
    if (origin !== undefined && !SAFE_METHODS.has(req.method) && !isOriginAllowed(origin, opts)) {
      return res.status(403).json({ statusCode: 403, message: 'Cross-origin request not allowed' });
    }
    next();
  };
}

/** CORS origin callback for app.enableCors(): reflect only allow-listed origins. */
export function corsOrigin(opts: GuardOptions) {
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
    cb(null, !origin || isOriginAllowed(origin, opts));
}

export function securityHeaders(opts: { hsts?: boolean } = {}): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Paths a tunnel visitor (e.g. Meta via ngrok) may reach: webhook, OAuth callback, generated images. */
export function isTunnelPathAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (path === '/api/whatsapp/webhook') return m === 'GET' || m === 'POST';
  if (path === '/api/instagram/auth/callback') return m === 'GET';
  if (/^\/output\/[^/]+\.(png|jpe?g)$/i.test(path)) return m === 'GET' || m === 'HEAD';
  return false;
}

/**
 * Requests whose Host is an extra ALLOWED_HOSTS entry (a public tunnel such as ngrok) may only reach
 * the few endpoints Meta needs; everything else is limited to loopback hosts.
 * Hosts listed in APP_HOSTS serve the whole app: there the sign-in guard (AuthGuard) is the protection.
 */
export function tunnelPathGuard(appHosts: string[] = []): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = stripPort(req.headers.host || '');
    if (LOCAL_HOSTS.has(host) || appHosts.includes(host) || isTunnelPathAllowed(req.method, req.path)) return next();
    return res.status(403).json({ statusCode: 403, message: 'Not available through the public tunnel' });
  };
}

/** Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex hmac of the raw body>"). */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string | undefined): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
