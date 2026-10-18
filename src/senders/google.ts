import { GoogleAdsApi } from "google-ads-api";
import type { services } from "google-ads-api";
import type { ConversionLog } from "../lib/firestore.js";
import type { SendResult } from "./types.js";

/**
 * Format a Date as the string Google Ads expects for conversion_date_time:
 * 'yyyy-MM-dd HH:mm:ss+HH:mm'. Timezone fixed to UTC for consistency.
 */
function formatConversionDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

/**
 * Send a Purchase event to Google Ads via uploadClickConversions.
 * Online orders include gclid; offline orders rely on hashed email/phone
 * (Enhanced Conversions for Leads matching on Google's side).
 */
export async function sendPurchaseToGoogle(log: ConversionLog): Promise<SendResult> {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, "");
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");
  const actionId =
    log.action_source === "website"
      ? process.env.GOOGLE_ADS_CONVERSION_ACTION_ONLINE
      : process.env.GOOGLE_ADS_CONVERSION_ACTION_OFFLINE;

  if (!customerId || !devToken || !refreshToken || !clientId || !clientSecret || !actionId) {
    return { ok: false, status: 0, body: "", error: "google_not_configured" };
  }

  const client = new GoogleAdsApi({
    client_id: clientId,
    client_secret: clientSecret,
    developer_token: devToken,
  });

  const customer = client.Customer({
    customer_id: customerId,
    refresh_token: refreshToken,
    login_customer_id: loginCustomerId,
  });

  const user_identifiers: Array<Record<string, string>> = [];
  if (log.email_hash) user_identifiers.push({ hashed_email: log.email_hash });
  if (log.phone_google) user_identifiers.push({ hashed_phone_number: log.phone_google });

  const conversion = {
    conversion_action: `customers/${customerId}/conversionActions/${actionId}`,
    conversion_date_time: formatConversionDateTime(log.event_time.toDate()),
    conversion_value: log.order_amount,
    currency_code: log.currency,
    order_id: log.order_id,
    user_identifiers,
    ...(log.gclid ? { gclid: log.gclid } : {}),
  };

  try {
    const request = {
      customer_id: customerId,
      conversions: [conversion],
      partial_failure: true,
      validate_only: false,
    } as unknown as services.UploadClickConversionsRequest;
    const response = await customer.conversionUploads.uploadClickConversions(request);
    const errors = (response as { partial_failure_error?: unknown })?.partial_failure_error;
    const ok = !errors;
    return {
      ok,
      status: ok ? 200 : 400,
      body: JSON.stringify(response),
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: "",
      error: (err as Error).message,
    };
  }
}
