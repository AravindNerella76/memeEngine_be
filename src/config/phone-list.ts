/**
 * The WhatsApp numbers allowed to use the bot. One setting holds all of them as a comma-separated list of
 * digits with the country code ("919347708120,918885550123"). A single number is just a list of one, so
 * every existing setting, saved value and API keeps working unchanged.
 */
export const MIN_PHONE_DIGITS = 8;
export const MAX_PHONE_DIGITS = 15;
export const MAX_ALLOWED_PHONES = 10;

// Numbers are separated by commas, semicolons or new lines. NOT by spaces: "91 93477 08120" is one number.
const SEPARATORS = /[,;\n\r]+/;

export interface PhoneListResult {
  /** Valid numbers, digits only, without duplicates. */
  phones: string[];
  /** Entries that are not 8-15 digits (as typed), so the person can be told which one to fix. */
  invalid: string[];
  tooMany: boolean;
}

/** Strict parsing for what a person types in the app. */
export function parsePhoneList(raw: unknown): PhoneListResult {
  const phones: string[] = [];
  const invalid: string[] = [];
  if (typeof raw !== 'string') return { phones, invalid, tooMany: false };
  for (const chunk of raw.split(SEPARATORS)) {
    const digits = chunk.replace(/\D/g, '');
    if (!digits) continue;
    if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) invalid.push(chunk.trim());
    else if (!phones.includes(digits)) phones.push(digits);
  }
  return { phones, invalid, tooMany: phones.length > MAX_ALLOWED_PHONES };
}

/** Lenient parsing for the server's .env (as before, no length checks): digits only, no duplicates, joined by commas. */
export function normalizePhoneList(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const out: string[] = [];
  for (const chunk of raw.split(SEPARATORS)) {
    const digits = chunk.replace(/\D/g, '');
    if (digits && !out.includes(digits)) out.push(digits);
  }
  return out.slice(0, MAX_ALLOWED_PHONES).join(',');
}

/** Is this sender on the list? Whole numbers only: a prefix or part of an allowed number never matches. */
export function isAllowedPhone(list: string | null | undefined, from: unknown): boolean {
  if (!list || typeof from !== 'string') return false;
  const sender = from.replace(/\D/g, '');
  return sender.length > 0 && list.split(',').includes(sender);
}
