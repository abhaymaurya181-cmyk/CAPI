import crypto from "node:crypto";

const INDIA_CC = "91";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Normalise a phone number to E.164.
 * Bare 10-digit input is treated as Indian and must start with 6-9 (matches
 * lucira-frontend/src/lib/phone.js). Leading zeros (trunk `0`, `00` intl
 * prefix) are dropped, and so is a trunk `0` written after +91. Other
 * country codes pass through if the total length is 11-15 digits.
 * Returns null for empty or malformed input.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;

  // "+91 0 98765 43210" → drop the trunk 0 after the country code.
  if (digits.length === 13 && digits.startsWith(INDIA_CC + "0")) {
    digits = INDIA_CC + digits.slice(3);
  }

  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return null;
    return "+" + INDIA_CC + digits;
  }

  // +91 is only India: the 10-digit mobile after it must start with 6-9.
  if (digits.length === 12 && digits.startsWith(INDIA_CC)) {
    return /^[6-9]/.test(digits.slice(2)) ? "+" + digits : null;
  }

  if (digits.length < 11 || digits.length > 15) return null;
  return "+" + digits;
}

/** Email for Meta (and for matching): trim + lowercase. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Email for Google (Data Manager formatting rules): as normalizeEmail, plus
 * for gmail.com / googlemail.com remove dots and any +suffix in the local part.
 */
export function normalizeEmailForGoogle(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (domain !== "gmail.com" && domain !== "googlemail.com") return email;
  const cleaned = local.split("+")[0].replace(/\./g, "");
  return cleaned ? `${cleaned}@${domain}` : null;
}

/**
 * Lucira creates placeholder emails from the phone number for phone-only
 * signups (lucira-frontend/src/lib/gtm.js). They carry no extra match value,
 * so drop them: any all-digit @lucirajewelry.com address, and an all-digit
 * @gmail.com address only when the digits are this person's own phone —
 * real customers do use number-style gmail addresses.
 */
export function isPlaceholderEmail(
  email: string | null | undefined,
  phone?: string | null
): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  const m = e.match(/^\+?(\d{7,15})@(gmail\.com|lucirajewelry\.com)$/);
  if (!m) return false;
  if (m[2] === "lucirajewelry.com") return true;
  const own = normalizePhoneE164(phone);
  return own != null && normalizePhoneE164(m[1]) === own;
}

/** normalizeEmail, but null for Lucira's placeholder emails. */
export function cleanEmail(
  email: string | null | undefined,
  phone?: string | null
): string | null {
  return isPlaceholderEmail(email, phone) ? null : normalizeEmail(email);
}

// Honorifics dropped from the start of a name (Google: "omit prefixes"),
// and suffixes from the end ("omit suffixes, such as Jr.").
const NAME_PREFIXES = new Set(["mr", "mrs", "ms", "miss", "dr", "shri", "sri", "smt", "kumari"]);
const NAME_SUFFIXES = new Set(["jr", "sr"]);

/**
 * Name: lowercase, no punctuation, single spaces. Non-English letters
 * (Hindi, accents) are kept as UTF-8 — Meta accepts them and Google gives no
 * rule against them. Honorific prefixes / Jr-Sr suffixes are removed.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = raw
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1 && NAME_PREFIXES.has(words[0])) words.shift();
  if (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ") || null;
}

/** Phone hashed for Meta CAPI (digits-only, no leading plus). */
export function hashPhoneForMeta(raw: string | null | undefined): string | null {
  const e164 = normalizePhoneE164(raw);
  return e164 ? sha256(e164.replace(/^\+/, "")) : null;
}

/** Phone hashed for Google Ads (E.164 format with leading plus). */
export function hashPhoneForGoogle(raw: string | null | undefined): string | null {
  const e164 = normalizePhoneE164(raw);
  return e164 ? sha256(e164) : null;
}

/** Email hash for Meta, and the key used for visitor lookup / admin search. */
export function hashEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
  return normalized ? sha256(normalized) : null;
}

/** Email hash for Google (gmail dots / +suffix removed). */
export function hashEmailForGoogle(raw: string | null | undefined): string | null {
  const normalized = normalizeEmailForGoogle(raw);
  return normalized ? sha256(normalized) : null;
}

/** Name hash. Same input format for both Meta and Google. */
export function hashName(raw: string | null | undefined): string | null {
  const normalized = normalizeName(raw);
  return normalized ? sha256(normalized) : null;
}

/** Indian pincode normaliser: digits only, must be 6 digits. */
export function normalizeZipIndia(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export function hashZip(raw: string | null | undefined): string | null {
  const normalized = normalizeZipIndia(raw);
  return normalized ? sha256(normalized) : null;
}

/** City/state (Meta ct/st): lowercase, no punctuation, no spaces; UTF-8 letters kept. */
export function normalizeLocality(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}]/gu, "");
  return cleaned || null;
}

export function hashLocality(raw: string | null | undefined): string | null {
  const normalized = normalizeLocality(raw);
  return normalized ? sha256(normalized) : null;
}

/** Country code hash: expects ISO-3166 alpha-2 (e.g. "IN"), lowercased before hashing. */
export function hashCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(cleaned) ? sha256(cleaned) : null;
}

/**
 * Date of birth → Meta's YYYYMMDD. Accepts YYYY-MM-DD / YYYYMMDD and the
 * Indian DD/MM/YYYY or DD-MM-YYYY. Year must be 1900..current year.
 */
export function normalizeDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let y: string, m: string, d: string;
  let match = s.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})$/);
  if (match) {
    [, y, m, d] = match;
  } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    [, d, m, y] = match;
  } else {
    return null;
  }
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1900 || year > new Date().getUTCFullYear()) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

export function hashDob(raw: string | null | undefined): string | null {
  const normalized = normalizeDob(raw);
  return normalized ? sha256(normalized) : null;
}

/** Gender → Meta's single lowercase initial: "m" or "f". */
export function normalizeGender(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const g = raw.trim().toLowerCase();
  if (g === "m" || g === "male") return "m";
  if (g === "f" || g === "female") return "f";
  return null;
}

export function hashGender(raw: string | null | undefined): string | null {
  const normalized = normalizeGender(raw);
  return normalized ? sha256(normalized) : null;
}

export interface HashedIdentity {
  phone_meta: string | null;
  phone_google: string | null;
  // Meta format; also the visitor lookup key.
  email: string | null;
  email_google: string | null;
  first_name: string | null;
  last_name: string | null;
  zip: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export function hashIdentity(input: {
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): HashedIdentity {
  const email = cleanEmail(input.email, input.phone);
  return {
    phone_meta: hashPhoneForMeta(input.phone),
    phone_google: hashPhoneForGoogle(input.phone),
    email: hashEmail(email),
    email_google: hashEmailForGoogle(email),
    first_name: hashName(input.firstName),
    last_name: hashName(input.lastName),
    zip: hashZip(input.zip),
    city: hashLocality(input.city),
    state: hashLocality(input.state),
    country: hashCountry(input.country ?? "IN"),
  };
}
