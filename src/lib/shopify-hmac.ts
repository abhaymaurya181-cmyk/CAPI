import crypto from "node:crypto";

/**
 * Verify Shopify webhook HMAC. Shopify sends the signature as a base64 HMAC-SHA256
 * of the raw request body, using the webhook secret as the key.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  providedHmacBase64: string | undefined,
  secret: string
): boolean {
  if (!providedHmacBase64 || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHmacBase64, "base64");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
