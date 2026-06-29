/**
 * Pure, dependency-free validators for the auth/provisioning input surface.
 * Mirrors the discriminated-union style of profile-url.ts so callers branch on
 * `.ok` and unit tests stay trivial. Server-authoritative — the forms reuse the
 * exported constants only as client-side maxLength hints.
 */

export const EMAIL_MAX = 254; // RFC 5321 address length
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72; // bcrypt (Supabase default) truncates beyond this
export const DISPLAY_NAME_MAX = 80;
export const MAX_PROVISION_URLS = 25;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // pragmatic; Supabase is final authority

// Code-point ranges stripped from display names: control + invisible chars that
// enable impersonation/spoofing or corrupt non-React render contexts. Expressed
// as hex pairs (not a literal char class) so the SOURCE stays pure ASCII.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls (incl. NUL, tab, newline)
  [0x7f, 0x9f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space/joiner + LTR/RTL marks
  [0x202a, 0x202e], // bidi embeddings/overrides (RTL spoofing)
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function stripUnsafeChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    const unsafe = UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
    if (!unsafe) out += ch;
  }
  return out;
}

export function validateEmail(raw: string): Validated<string> {
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email is required.' };
  if (email.length > EMAIL_MAX) return { ok: false, error: 'Email is too long.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  return { ok: true, value: email };
}

export function validatePassword(raw: string): Validated<string> {
  // Do NOT trim — leading/trailing spaces can be intentional in a password.
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN} characters.` };
  }
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) {
    // bcrypt silently truncates at 72 bytes; reject so the stored password is
    // exactly what the admin sees and types at login.
    return { ok: false, error: `Password must be ${PASSWORD_MAX_BYTES} bytes or fewer.` };
  }
  return { ok: true, value: raw };
}

export function validateDisplayName(raw: string): Validated<string> {
  const cleaned = stripUnsafeChars(raw.normalize('NFC'))
    .replace(/\s+/g, ' ') // collapse internal whitespace
    .trim();
  if (!cleaned) return { ok: false, error: 'Display name is required.' };
  if (cleaned.length > DISPLAY_NAME_MAX) {
    return { ok: false, error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value: cleaned };
}
