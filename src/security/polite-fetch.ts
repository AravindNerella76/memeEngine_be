/**
 * Polite wrapper around safeFetch for public APIs and image hosts:
 *  - at most 2 concurrent requests per host and a minimum spacing between requests;
 *  - HTTP 429 / 503 are retried (bounded) after the server's Retry-After, or with backoff.
 * Live runs showed Wikimedia answering 429 when a meme's slots were searched in parallel.
 */
import { safeFetch, SafeFetchError, SafeFetchOptions, SafeResponse } from './safe-fetch';

const MAX_PER_HOST = 2;
const MIN_SPACING_MS = 300;
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 8000;

interface HostState {
  active: number;
  last: number;
  queue: (() => void)[];
}

const hosts = new Map<string, HostState>();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Groups subdomains of the same organisation (e.g. upload.wikimedia.org + commons.wikimedia.org). */
export function hostKey(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const m = h.match(/([a-z0-9-]+\.(org|com|net|in|io))$/);
    return m ? m[1] : h;
  } catch {
    return 'invalid';
  }
}

async function acquire(key: string): Promise<void> {
  let st = hosts.get(key);
  if (!st) {
    st = { active: 0, last: 0, queue: [] };
    hosts.set(key, st);
  }
  while (st.active >= MAX_PER_HOST) await new Promise<void>(r => st!.queue.push(r));
  st.active++;
  const wait = st.last + MIN_SPACING_MS - Date.now();
  st.last = Math.max(Date.now(), st.last + MIN_SPACING_MS);
  if (wait > 0) await sleep(wait);
}

function release(key: string): void {
  const st = hosts.get(key);
  if (!st) return;
  st.active--;
  const next = st.queue.shift();
  if (next) next();
}

export async function politeFetch(url: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const key = hostKey(url);
  for (let attempt = 0; ; attempt++) {
    await acquire(key);
    let backoff = 0;
    try {
      return await safeFetch(url, opts);
    } catch (e: any) {
      const retryable = e instanceof SafeFetchError && (e.status === 429 || e.status === 503);
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      backoff = Math.min(MAX_WAIT_MS, e.retryAfterMs ?? 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 400));
    } finally {
      release(key); // exactly once per attempt (success, failure or retry)
    }
    await sleep(backoff);
  }
}
