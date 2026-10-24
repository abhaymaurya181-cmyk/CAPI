// Live-tenant check of the real fetchOrnaverseSales() function.
// READ-ONLY — same two endpoints as orna-smoke.mjs.
// Pulls the last 24 hours so we see actual rows but not too many.
import "dotenv/config";
import { fetchOrnaverseSales } from "../src/importers/ornaverse.ts";

const to = new Date();
const from = new Date(to.getTime() - 24 * 3600 * 1000);
console.log("window:", from.toISOString(), "→", to.toISOString());
console.log("ORNAVERSE_POSTED_STATUSES:", process.env.ORNAVERSE_POSTED_STATUSES || "(none)");
console.log("ORNAVERSE_SCOPE:", process.env.ORNAVERSE_SCOPE || "(default: openid)");

const t0 = Date.now();
const sales = await fetchOrnaverseSales(from, to);
const ms = Date.now() - t0;

console.log(`\nreturned ${sales.length} sales in ${ms}ms`);
for (const s of sales.slice(0, 5)) {
  console.log("  ", s.sale_id, s.event_time.toISOString(), "₹" + s.amount, "store=" + (s.store_name || "—"), "phone?" + !!s.phone, "email?" + !!s.email);
}
if (sales.length > 5) console.log("  ... + " + (sales.length - 5) + " more");
