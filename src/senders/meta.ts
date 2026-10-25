import type { ConversionLog } from "../lib/firestore.js";
import type { SendResult } from "./types.js";

const DAY_MS = 24 * 3600 * 1000;
// Meta rejects events older than this (Conversions API offline events: 62 days;
// website events: 7 days) and events more than a few minutes in the future.
const MAX_AGE_MS: Record<ConversionLog["action_source"], number> = {
  physical_store: 62 * DAY_MS,
  website: 7 * DAY_MS,
};
const MAX_FUTURE_MS = 5 * 60 * 1000;

/** Meta user_data from the hashed fields on the log. Hashes are already in Meta format. */
export function buildMetaUserData(log: ConversionLog): Record<string, unknown> {
  const user_data: Record<string, unknown> = {};
  if (log.email_hash) user_data.em = [log.email_hash];
  if (log.phone_meta) user_data.ph = [log.phone_meta];
  if (log.first_name_hash) user_data.fn = [log.first_name_hash];
  if (log.last_name_hash) user_data.ln = [log.last_name_hash];
  if (log.dob_hash) user_data.db = [log.dob_hash];
  if (log.gender_hash) user_data.ge = [log.gender_hash];
  if (log.zip_hash) user_data.zp = [log.zip_hash];
  if (log.city_hash) user_data.ct = [log.city_hash];
  if (log.state_hash) user_data.st = [log.state_hash];
  if (log.country_hash) user_data.country = [log.country_hash];
  if (log.external_id) user_data.external_id = [log.external_id];
  if (log.fbc) user_data.fbc = log.fbc;
  if (log.fbp) user_data.fbp = log.fbp;
  if (log.client_ip_address) user_data.client_ip_address = log.client_ip_address;
  if (log.client_user_agent) user_data.client_user_agent = log.client_user_agent;
  return user_data;
}

/** Full /events request body for one Purchase. */
export function buildMetaPayload(log: ConversionLog, testCode?: string) {
  return {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(log.event_time.toMillis() / 1000),
        // order_id doubles as event_id so a resend of the same sale is deduplicated.
        event_id: log.order_id,
        action_source: log.action_source,
        user_data: buildMetaUserData(log),
        custom_data: {
          currency: log.currency.toUpperCase(),
          value: log.order_amount,
          order_id: log.order_id,
        },
      },
    ],
    ...(testCode ? { test_event_code: testCode } : {}),
  };
}

/** Reasons Meta would reject the event outright; null if it is sendable. */
export function metaPreflightError(log: ConversionLog, nowMs = Date.now()): string | null {
  const ud = buildMetaUserData(log);
  if (!ud.em && !ud.ph && !ud.external_id && !ud.fbc) return "no_match_keys";
  const t = log.event_time.toMillis();
  if (t > nowMs + MAX_FUTURE_MS) return "event_time_in_future";
  if (nowMs - t > MAX_AGE_MS[log.action_source]) return "event_too_old";
  return null;
}

/** Pull Meta's error message out of a Graph API error body, if any. */
function metaErrorMessage(body: string): string | undefined {
  try {
    const e = (JSON.parse(body) as { error?: { message?: string; error_user_msg?: string } }).error;
    return e ? e.error_user_msg || e.message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send a Purchase event to Meta Conversions API.
 * Returns a structured result; errors do not throw.
 */
/** Same check the sender uses before calling Meta. */
export function metaConfigured(): boolean {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_ACCESS_TOKEN);
}

export async function sendPurchaseToMeta(log: ConversionLog): Promise<SendResult> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  const testCode = process.env.META_TEST_EVENT_CODE || undefined;
  const version = process.env.META_API_VERSION || "v20.0";

  if (!pixelId || !token) {
    return { ok: false, status: 0, body: "", error: "meta_not_configured" };
  }

  const preflight = metaPreflightError(log);
  if (preflight) return { ok: false, status: 0, body: "", error: preflight };

  const url = `https://graph.facebook.com/${version}/${pixelId}/events`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildMetaPayload(log, testCode)),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, body, error: metaErrorMessage(body) };
    }
    // A 200 should always report the one event as received; anything else is a failure.
    let received: number | undefined;
    try {
      received = (JSON.parse(body) as { events_received?: number }).events_received;
    } catch {}
    if (received !== 1) {
      return { ok: false, status: res.status, body, error: "event_not_received" };
    }
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
