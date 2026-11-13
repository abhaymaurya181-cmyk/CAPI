/**
 * Send one fake in-store Purchase to the Data Manager API with validateOnly
 * forced on: Google checks the request (auth, account access, conversion
 * action, field formats) but records nothing.
 *
 *   npm run google:validate -- [phone] [email] [gclid]
 */
import "dotenv/config";
import { Timestamp } from "@google-cloud/firestore";
import { hashIdentity } from "../src/lib/hash.js";
import { buildGooglePayload, googleConfig, sendPurchaseToGoogle } from "../src/senders/google.js";
import type { ConversionLog } from "../src/lib/firestore.js";

process.env.GOOGLE_VALIDATE_ONLY = "true";
const cfg = googleConfig();
if (!cfg) {
  console.error("Set GOOGLE_ADS_CUSTOMER_ID and GOOGLE_ADS_CONVERSION_ACTION_PURCHASE in .env first.");
  process.exit(1);
}

const [phone = "9876543210", email = "test.customer@example.com", gclid] = process.argv.slice(2);
const id = hashIdentity({ phone, email, firstName: "Test", lastName: "Customer", zip: "400001" });
const now = Timestamp.now();

const log: ConversionLog = {
  source: "csv_upload",
  order_id: `TEST-${Date.now()}`,
  order_amount: 1,
  currency: "INR",
  event_time: now,
  phone_google: id.phone_google,
  email_google_hash: id.email_google,
  first_name_hash: id.first_name,
  last_name_hash: id.last_name,
  postal_code: "400001",
  region_code: "IN",
  ...(gclid ? { gclid } : {}),
  action_source: "physical_store",
  created_at: now,
  updated_at: now,
};

console.log("Payload:", JSON.stringify(buildGooglePayload(log, cfg), null, 2));
const res = await sendPurchaseToGoogle(log);
console.log("Result:", res);
process.exit(res.validated ? 0 : 1);
