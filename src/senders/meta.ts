import type { ConversionLog } from "../lib/firestore.js";
import type { SendResult } from "./types.js";

const META_API_VERSION = "v20.0";

/**
 * Send a Purchase event to Meta Conversions API.
 * Returns a structured result; errors do not throw.
 */
export async function sendPurchaseToMeta(log: ConversionLog): Promise<SendResult> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  const testCode = process.env.META_TEST_EVENT_CODE;

  if (!pixelId || !token) {
    return { ok: false, status: 0, body: "", error: "meta_not_configured" };
  }

  const user_data: Record<string, unknown> = {};
  if (log.email_hash) user_data.em = [log.email_hash];
  if (log.phone_meta) user_data.ph = [log.phone_meta];
  if (log.first_name_hash) user_data.fn = [log.first_name_hash];
  if (log.last_name_hash) user_data.ln = [log.last_name_hash];
  if (log.zip_hash) user_data.zp = [log.zip_hash];
  if (log.city_hash) user_data.ct = [log.city_hash];
  if (log.state_hash) user_data.st = [log.state_hash];
  if (log.country_hash) user_data.country = [log.country_hash];
  if (log.fbc) user_data.fbc = log.fbc;
  if (log.fbp) user_data.fbp = log.fbp;
  if (log.client_ip_address) user_data.client_ip_address = log.client_ip_address;
  if (log.client_user_agent) user_data.client_user_agent = log.client_user_agent;

  const payload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(log.event_time.toMillis() / 1000),
        event_id: log.order_id,
        action_source: log.action_source,
        user_data,
        custom_data: {
          currency: log.currency,
          value: log.order_amount,
          order_id: log.order_id,
        },
      },
    ],
    ...(testCode ? { test_event_code: testCode } : {}),
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: "",
      error: (err as Error).message,
    };
  }
}
