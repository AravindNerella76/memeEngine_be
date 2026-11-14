/**
 * Rights classification of subject images.
 *
 * Every candidate gets one of three classes, and every SELECTED image carries a rights record in
 * the meme (asset.rights) and in the generation report:
 *
 *   open_license             public domain, CC0, CC BY, CC BY-SA, GFDL, GODL-India ... (licence
 *                            metadata from the source says editing and reuse are allowed, with the
 *                            licence's conditions such as credit or share-alike)
 *   open_license_restricted  an open licence that does NOT cover this use (NonCommercial or
 *                            NoDerivatives); treat like copyrighted
 *   copyrighted_unconfirmed  everything else: film stills, posters, promotional, celebrity, news and
 *                            editorial photos, or any image without licence metadata. Reuse
 *                            permission has NOT been confirmed.
 *
 * The classification never relaxes discovery checks; it only decides what the rights policy allows
 * and how the image is labelled. Anything not positively identified as openly licensed is labelled
 * copyrighted (conservative).
 */
import { RightsPolicy } from '../config/app-config';

export type { RightsPolicy } from '../config/app-config';

export type RightsClass = 'open_license' | 'open_license_restricted' | 'copyrighted_unconfirmed';

/** Rights record stored with every selected image (asset.rights and report.selected.rights). */
export interface RightsInfo {
  classification: RightsClass;
  /** Human-readable label, e.g. "Openly licensed (CC BY-SA 4.0)". */
  label: string;
  license?: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  /** Edited versions must be shared under the same licence (CC BY-SA, GFDL). */
  shareAlike: boolean;
  /** Why an open licence does not cover this use (NonCommercial / NoDerivatives). */
  restriction?: string;
  attribution?: string;
  /** Search provider that found the image. */
  provider: string;
  /** How the classification was made. */
  basis: string;
  /** False when the provider's terms do not allow keeping the source URL (it is then not stored). */
  sourceStored: boolean;
  storageNote?: string;
}

export interface LicenseClassification {
  classification: RightsClass;
  attributionRequired: boolean;
  shareAlike: boolean;
  restriction?: string;
}

const COPYRIGHT_MARKERS = /\b(unknown|fair use|non-?free|all rights reserved|copyright(ed)?|tmdb image|studio|editorial)\b/;

/** Classifies a licence string (as given by Commons, Wikipedia, Openverse ...). Pure. */
export function classifyLicense(license?: string | null, opts: { nonFree?: boolean } = {}): LicenseClassification {
  const copyrighted: LicenseClassification = { classification: 'copyrighted_unconfirmed', attributionRequired: false, shareAlike: false };
  if (opts.nonFree) return copyrighted;
  const s = String(license || '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
  // Commons' {{Copyrighted free use}} is a free licence despite the word "copyrighted".
  if (/^copyrighted free use\b/.test(s)) return { classification: 'open_license', attributionRequired: false, shareAlike: false };
  if (!s || COPYRIGHT_MARKERS.test(s)) return copyrighted;

  const shareAlike = /\b(by[ -]?sa|sa)\b|share ?alike|gfdl|gnu free documentation/.test(s);
  if (/\bnc\b|non-?commercial/.test(s)) {
    return { classification: 'open_license_restricted', attributionRequired: true, shareAlike, restriction: 'the licence does not allow commercial use (NonCommercial)' };
  }
  if (/\bnd\b|no ?deriv/.test(s)) {
    return { classification: 'open_license_restricted', attributionRequired: true, shareAlike, restriction: 'the licence does not allow edited versions (NoDerivatives)' };
  }
  if (/\b(cc0|cc zero|public domain|pdm|pd|no restrictions)\b/.test(s)) {
    return { classification: 'open_license', attributionRequired: false, shareAlike: false };
  }
  if (/\b(gfdl|gnu free documentation)\b/.test(s)) {
    return { classification: 'open_license', attributionRequired: true, shareAlike: true };
  }
  if (/^(cc[ -]?by|by\b|creative commons attribution|attribution\b|godl)/.test(s) || /\bcc[ -]?by\b/.test(s)) {
    return { classification: 'open_license', attributionRequired: true, shareAlike };
  }
  // A licence string we cannot interpret: do not claim it is open.
  return copyrighted;
}

/** True when the rights policy lets discovery use an image of this class. */
export function rightsAllowed(policy: RightsPolicy, classification: RightsClass): boolean {
  return policy === 'allow_copyrighted' || classification === 'open_license';
}

export function rightsLabel(c: LicenseClassification, license?: string): string {
  switch (c.classification) {
    case 'open_license':
      return `Openly licensed${license ? ` (${license})` : ''}`;
    case 'open_license_restricted':
      return `Open licence that does not cover this use${license ? ` (${license})` : ''}: treat as copyrighted`;
    default:
      return 'Copyrighted: reuse permission not confirmed';
  }
}

export function buildRightsInfo(input: {
  classification: LicenseClassification;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  provider: string;
  basis: string;
  sourceStored: boolean;
  storageNote?: string;
}): RightsInfo {
  const c = input.classification;
  const open = c.classification !== 'copyrighted_unconfirmed';
  return {
    classification: c.classification,
    label: rightsLabel(c, open ? input.license : undefined),
    license: open ? input.license : undefined,
    licenseUrl: open ? input.licenseUrl : undefined,
    attributionRequired: c.attributionRequired,
    shareAlike: c.shareAlike,
    restriction: c.restriction,
    attribution: input.attribution,
    provider: input.provider,
    basis: input.basis,
    sourceStored: input.sourceStored,
    storageNote: input.storageNote
  };
}

/** Hosts that serve Wikimedia files (originals, and resized renditions since 2026). */
export const WIKIMEDIA_FILE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);

/** File name of a Wikimedia upload URL (Commons or a Wikipedia's local files), or null. */
export function wikimediaFileFromUrl(url: string): { wiki: 'commons' | string; file: string } | null {
  try {
    const u = new URL(url);
    if (!WIKIMEDIA_FILE_HOSTS.has(u.hostname)) return null;
    const m = u.pathname.match(/^\/wikipedia\/([a-z-]+)\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/);
    if (!m) return null;
    return { wiki: m[1], file: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
