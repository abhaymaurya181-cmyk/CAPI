import { GoogleAuth } from "google-auth-library";
import type { ConsentState, ConversionLog, EventType } from "../lib/firestore.js";
import type { SendResult } from "./types.js";

export const INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
const SCOPE = "https://www.googleapis.com/auth/datamanager";
// Data Manager allows at most 10 user identifiers per event.
const MAX_IDENTIFIERS = 10;

// Application Default Credentials: the Cloud Run service account in prod,
// GOOGLE_APPLICATION_CREDENTIALS (a key file) in local dev.
const auth = new GoogleAuth({ scopes: [SCOPE] });

type ConsentStatus = "CONSENT_GRANTED" | "CONSENT_DENIED";

function consentStatus(s?: ConsentState): ConsentStatus | undefined {
  if (s === "granted") return "CONSENT_GRANTED";
  if (s === "denied") return "CONSENT_DENIED";
  return undefined;
}

/** Hashed identifiers for userData. Hashes are already in Google format. */
export function buildGoogleUserIdentifiers(log: ConversionLog): Array<Record<string, unknown>> {
  const ids: Array<Record<string, unknown>> = [];
  if (log.email_google_hash) ids.push({ emailAddress: log.email_google_hash });
  if (log.phone_google) ids.push({ phoneNumber: log.phone_google });
  // Address only matches with all four parts present.
  if (log.first_name_hash && log.last_name_hash && log.region_code && log.postal_code) {
    ids.push({
      address: {
        givenName: log.first_name_hash,
        familyName: log.last_name_hash,
        regionCode: log.region_code,
        postalCode: log.postal_code,
      },
    });
  }
  return ids.slice(0, MAX_IDENTIFIERS);
}

/** One click id per conversion: gclid, else gbraid, else wbraid. */
export function buildGoogleAdIdentifiers(log: ConversionLog): Record<string, string> | undefined {
  if (log.gclid) return { gclid: log.gclid };
  if (log.gbraid) return { gbraid: log.gbraid };
  if (log.wbraid) return { wbraid: log.wbraid };
  return undefined;
}

export interface GoogleConfig {
  customerId: string;
  loginCustomerId?: string;
  conversionActionId: string;
  validateOnly: boolean;
}

/** Full events:ingest request body for one Purchase or Store Visit. */
export function buildGooglePayload(log: ConversionLog, cfg: GoogleConfig) {
  const userIdentifiers = buildGoogleUserIdentifiers(log);
  const adIdentifiers = buildGoogleAdIdentifiers(log);
  const adUserData = consentStatus(log.consent?.ad_user_data);
  const adPersonalization = consentStatus(log.consent?.ad_personalization);
  // Store Visit action is configured as "no value" — always send 0 for those.
  const isStoreVisit = (log.event_type ?? "purchase") === "store_visit";
  const conversionValue = isStoreVisit ? 0 : log.order_amount;

  return {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: cfg.customerId },
        ...(cfg.loginCustomerId
          ? { loginAccount: { accountType: "GOOGLE_ADS", accountId: cfg.loginCustomerId } }
          : {}),
        productDestinationId: cfg.conversionActionId,
      },
    ],
    encoding: "HEX",
    events: [
      {
        // order_id doubles as transactionId so a resend of the same sale is deduplicated.
        transactionId: log.order_id,
        eventTimestamp: log.event_time.toDate().toISOString(),
        eventSource: log.action_source === "physical_store" ? "IN_STORE" : "WEB",
        conversionValue,
        currency: log.currency.toUpperCase(),
        ...(adIdentifiers ? { adIdentifiers } : {}),
        ...(userIdentifiers.length > 0 ? { userData: { userIdentifiers } } : {}),
        ...(adUserData || adPersonalization
          ? {
              consent: {
                ...(adUserData ? { adUserData } : {}),
                ...(adPersonalization ? { adPersonalization } : {}),
              },
            }
          : {}),
      },
    ],
    validateOnly: cfg.validateOnly,
  };
}

/** Reasons Google would reject the event outright; null if it is sendable. */
export function googlePreflightError(log: ConversionLog): string | null {
  if (!buildGoogleAdIdentifiers(log) && buildGoogleUserIdentifiers(log).length === 0) {
    return "no_match_keys";
  }
  return null;
}

/** Google API error → "STATUS: message (field: description; ...)". */
function googleErrorMessage(body: string): string | undefined {
  try {
    const e = (
      JSON.parse(body) as {
        error?: {
          status?: string;
          message?: string;
          details?: Array<{ fieldViolations?: Array<{ field?: string; description?: string }> }>;
        };
      }
    ).error;
    if (!e) return undefined;
    const fields = (e.details ?? [])
      .flatMap((d) => d.fieldViolations ?? [])
      .map((v) => `${v.field}: ${v.description}`);
    return `${e.status ?? "ERROR"}: ${e.message ?? ""}${fields.length ? ` (${fields.join("; ")})` : ""}`;
  } catch {
    return undefined;
  }
}

export function googleConfig(eventType: EventType = "purchase"): GoogleConfig | null {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, "");
  const conversionActionId =
    eventType === "store_visit"
      ? process.env.GOOGLE_ADS_CONVERSION_ACTION_STORE_VISIT
      : process.env.GOOGLE_ADS_CONVERSION_ACTION_PURCHASE;
  if (!customerId || !conversionActionId) return null;
  // Safe default on both flags: only an explicit "false" sends real events.
  const validateOnly =
    eventType === "store_visit"
      ? process.env.GOOGLE_STORE_VISIT_VALIDATE_ONLY !== "false"
      : process.env.GOOGLE_VALIDATE_ONLY !== "false";
  return {
    customerId,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "") || undefined,
    conversionActionId,
    validateOnly,
  };
}

/**
 * Send one event (Purchase or Store Visit) to Google Ads through the Data
 * Manager API. The event type comes from the log row and picks which
 * Conversion Action we route to (via googleConfig). With validateOnly on,
 * Google only checks the request; a pass comes back as `validated` (not `ok`)
 * so the event is still sent once live. Returns a structured result; errors
 * do not throw.
 */
export async function sendToGoogle(log: ConversionLog): Promise<SendResult> {
  const eventType = log.event_type ?? "purchase";
  const cfg = googleConfig(eventType);
  if (!cfg) return { ok: false, status: 0, body: "", error: "google_not_configured" };

  const preflight = googlePreflightError(log);
  if (preflight) return { ok: false, status: 0, body: "", error: preflight };

  try {
    const token = await auth.getAccessToken();
    if (!token) return { ok: false, status: 0, body: "", error: "google_auth_no_token" };

    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildGooglePayload(log, cfg)),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, body, error: googleErrorMessage(body) };
    }
    if (cfg.validateOnly) return { ok: false, validated: true, status: res.status, body };
    return { ok: true, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: "",
      error: (err as Error).message,
    };
  }
}

/** Back-compat alias for Purchase sends (used by google-validate script). */
export const sendPurchaseToGoogle = sendToGoogle;
