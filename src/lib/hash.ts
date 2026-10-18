import crypto from "node:crypto";

const INDIA_CC = "91";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Normalise a phone number to E.164.
 * Bare 10-digit input is treated as Indian and must start with 6-9 (matches
 * lucira-frontend/src/lib/phone.js). Inputs with a country code already
 * attached (12+ digits or leading +) pass through if length is 11-15.
 * Returns null for empty or malformed input.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;

  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return null;
    return "+" + INDIA_CC + digits;
  }

  if (digits.length < 11 || digits.length > 15) return null;
  return "+" + digits;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  // Filter Lucira's dummy phone-based emails (matches logic in lucira-frontend/src/lib/gtm.js)
  // if (/^\+?\d{7,15}@(gmail\.com|lucirajewelry\.com)$/i.test(trimmed)) {
  //   return null;
  // }
  return trimmed;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
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

/** Email hash. Same input format for both Meta and Google. */
export function hashEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw);
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

/** City/state hash: lowercase, trim, no special chars. */
export function hashLocality(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, "").trim();
  return cleaned ? sha256(cleaned) : null;
}

/** Country code hash: expects ISO-3166 alpha-2 (e.g. "IN"), lowercased before hashing. */
export function hashCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(cleaned) ? sha256(cleaned) : null;
}

export interface HashedIdentity {
  phone_meta: string | null;
  phone_google: string | null;
  email: string | null;
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
  return {
    phone_meta: hashPhoneForMeta(input.phone),
    phone_google: hashPhoneForGoogle(input.phone),
    email: hashEmail(input.email),
    first_name: hashName(input.firstName),
    last_name: hashName(input.lastName),
    zip: hashZip(input.zip),
    city: hashLocality(input.city),
    state: hashLocality(input.state),
    country: hashCountry(input.country ?? "IN"),
  };
}
