/**
 * Password hashing with Node's built-in scrypt (memory-hard; no native dependency).
 * Stored format: scrypt$N$r$p$salt$hash (base64url). The parameters travel with the hash, so they can be
 * raised later: a correct login with older parameters is re-hashed (see needsRehash).
 */
import * as crypto from 'crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so the same visible password typed on another device hashes the same
    crypto.scrypt(password.normalize('NFKC'), salt, keyLen, { N: n, r, p, maxmem: 128 * n * r * 2 + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, N, R, P, KEY_LEN);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export interface VerifyResult {
  ok: boolean;
  /** The password was right but the stored hash uses weaker parameters than today's: store a fresh hash. */
  needsRehash: boolean;
}

const saneParams = (n: number, r: number, p: number) =>
  Number.isInteger(Math.log2(n)) && n >= 2 ** 14 && n <= 2 ** 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4;

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const fail: VerifyResult = { ok: false, needsRehash: false };
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return fail;
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return fail;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!saneParams(n, r, p)) return fail;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!salt.length || !expected.length) return fail;
  const actual = await scrypt(password, salt, n, r, p, expected.length);
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return { ok, needsRehash: ok && (n !== N || r !== R || p !== P) };
}

let dummy: Promise<string> | null = null;
/**
 * A real hash of a random password. Checking against it when the username does not exist costs the same
 * time as a real check, so response time does not reveal which usernames exist.
 */
export function dummyHash(): Promise<string> {
  if (!dummy) dummy = hashPassword(crypto.randomBytes(24).toString('base64url'));
  return dummy;
}

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd1234', 'qwertyuiop12', 'qwerty123456',
  '123456789012', '111111111111', '000000000000', 'iloveyou1234', 'letmein12345', 'administrator',
  'welcome12345', 'changeme1234', 'kanyaraasi123', 'kanyaraasimemes', 'telugumemes123'
]);

/** Human-readable reasons a password is not acceptable (empty = fine). Length matters most; no composition rules. */
export function passwordProblems(password: unknown, username?: string): string[] {
  if (typeof password !== 'string' || !password) return ['Enter a password.'];
  const out: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) out.push(`Use at least ${MIN_PASSWORD_LENGTH} characters. A few random words works well.`);
  if (password.length > MAX_PASSWORD_LENGTH) out.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) out.push('The password must not contain your username.');
  if (/^(.)\1+$/.test(password)) out.push('Do not repeat a single character.');
  if (COMMON.has(password.toLowerCase())) out.push('That password is too common.');
  return out;
}
