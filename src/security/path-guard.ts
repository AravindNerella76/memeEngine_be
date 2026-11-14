/**
 * Filesystem safety: every file the server reads, serves or deletes must resolve (after symlink
 * resolution) to a regular file inside an approved application directory.
 *
 * Client-supplied paths are never trusted. A path is only usable if it is absolute, free of
 * stream/device tricks, and its canonical location is inside one of the approved roots.
 */
import * as fs from 'fs';
import * as path from 'path';

// This file lives in src/security (ts-node) or dist/security (build): both are two levels below the backend root.
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
export const UPLOADS_ROOT = path.join(BACKEND_ROOT, 'uploads');          // user uploads + internet-discovered images
export const OUTPUT_ROOT = path.join(BACKEND_ROOT, 'output');            // generated memes
export const TEST_ASSETS_ROOT = path.join(BACKEND_ROOT, 'test-assets');  // repository sample images (read-only)

/** Roots from which images may be READ for rendering. Deletion is restricted to UPLOADS_ROOT / OUTPUT_ROOT. */
export const APPROVED_READ_ROOTS = [UPLOADS_ROOT, TEST_ASSETS_ROOT];

function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** True for paths we never accept: NUL bytes, UNC/device prefixes, NTFS alternate data streams. */
export function hasUnsafePathChars(p: string): boolean {
  if (p.includes('\0')) return true;
  if (p.startsWith('\\\\') || p.startsWith('//')) return true;          // UNC and \\?\ device paths
  const rest = /^[a-zA-Z]:[\\/]/.test(p) ? p.slice(2) : p;
  return rest.includes(':');                                           // "file.jpg:stream", "C:x"
}

/** True if candidate's canonical location is strictly inside root (symlinks resolved, no sibling-prefix tricks). */
export function isPathInside(root: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!path.isAbsolute(candidate) || hasUnsafePathChars(candidate)) return false;
  const rel = path.relative(canonical(root), canonical(candidate));
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Returns the canonical path of an existing regular file that lies inside one of the roots,
 * or null if the candidate is unsafe, missing, a directory, or outside every root.
 */
export function resolveApprovedFile(candidate: unknown, roots: string[]): string | null {
  if (typeof candidate !== 'string') return null;
  if (!roots.some(r => isPathInside(r, candidate))) return null;
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Deletes a file only if it is an existing regular file inside `root`. Returns whether it was deleted. */
export function safeDeleteFile(candidate: unknown, root: string): boolean {
  const real = resolveApprovedFile(candidate, [root]);
  if (!real) return false;
  try {
    fs.unlinkSync(real);
    return true;
  } catch {
    return false;
  }
}

/** Reduces a client-supplied file name to something safe to store and display. */
export function sanitizeDisplayName(name: unknown, fallback = 'upload'): string {
  if (typeof name !== 'string') return fallback;
  const base = name.replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 120);
  return cleaned || fallback;
}
