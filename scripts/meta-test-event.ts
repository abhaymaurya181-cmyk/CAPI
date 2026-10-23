/**
 * Send one fake in-store Purchase to Meta with META_TEST_EVENT_CODE, so it
 * shows up under Events Manager → Test Events and is not counted as a real sale.
 *
 *   npm run meta:test -- [phone] [email]
 */
import "dotenv/config";
import { Timestamp } from "@google-cloud/firestore";
import { hashIdentity } from "../src/lib/hash.js";
import { buildMetaPayload, sendPurchaseToMeta } from "../src/senders/meta.js";
import type { ConversionLog } from "../src/lib/firestore.js";

if (!process.env.META_TEST_EVENT_CODE) {
  console.error("META_TEST_EVENT_CODE is empty. Copy it from Events Manager → Test Events first.");
  process.exit(1);
}

const [phone = "9876543210", email = "test.customer@example.com"] = process.argv.slice(2);
const id = hashIdentity({ phone, email, firstName: "Test", lastName: "Customer", city: "Mumbai", zip: "400001" });
const now = Timestamp.now();

const log: ConversionLog = {
  source: "csv_upload",
  order_id: `TEST-${Date.now()}`,
  order_amount: 1,
  currency: "INR",
  event_time: now,
  phone_meta: id.phone_meta,
  email_hash: id.email,
  first_name_hash: id.first_name,
  last_name_hash: id.last_name,
  zip_hash: id.zip,
  city_hash: id.city,
  country_hash: id.country,
  action_source: "physical_store",
  created_at: now,
  updated_at: now,
};

console.log("Payload:", JSON.stringify(buildMetaPayload(log, process.env.META_TEST_EVENT_CODE), null, 2));
const res = await sendPurchaseToMeta(log);
console.log("Result:", res);
process.exit(res.ok ? 0 : 1);
