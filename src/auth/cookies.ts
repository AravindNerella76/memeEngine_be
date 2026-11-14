/** Minimal cookie helpers (no dependency). The session cookie is HttpOnly, SameSite=Lax and, on HTTPS, uses the __Host- prefix. */

/** "__Host-" makes browsers require Secure + Path=/ + no Domain, so a sibling subdomain cannot plant or overwrite it. */
export const sessionCookieName = (secure: boolean): string => (secure ? '__Host-me_session' : 'me_session');

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(value: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [
    `${sessionCookieName(opts.secure)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    ...(opts.secure ? ['Secure'] : [])
  ].join('; ');
}

export const clearedSessionCookie = (secure: boolean): string => sessionCookie('', { secure, maxAgeSeconds: 0 });
