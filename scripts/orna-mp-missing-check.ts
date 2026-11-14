// READ-ONLY probe: find where the 46 "missing" Shopify orders might live
// in OrnaVerse. Scans 3 places for Nov 1-13 IST window:
//   1. MarketPlace/Invoice/List  (all statuses, not just posted=1)
//   2. MarketPlace/Order/List    (upstream of invoices — might have unfulfilled)
//   3. Prints the full list of external_order_id (= Shopify order ID) we see
//      so the user can diff against their Shopify list.
//
// Run from repo root: cd lucira-capi && npx tsx scripts/orna-mp-missing-check.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured, parseOrnaverseDate } from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) { console.log("env not set"); process.exit(1); }
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text().catch(()=>"")}`);
  return res.json();
}

const FROM_MS = Date.parse("2026-11-01T00:00:00+05:30");
const TO_MS = Date.parse("2026-11-14T00:00:00+05:30");

async function collect(path: string, label: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 20; page++) {
    const resp = await post(path, { Skip: page * 100, Take: 100 }) as {
      Entities?: Array<Record<string, unknown>>; TotalCount?: number;
    };
    const rows = resp.Entities ?? [];
    if (rows.length === 0) break;
    let oldestMs = Infinity;
    for (const r of rows) {
      const d = parseOrnaverseDate(typeof r.document_date === "string" ? r.document_date : undefined);
      if (d == null) continue;
      oldestMs = Math.min(oldestMs, d);
      if (d >= FROM_MS && d < TO_MS) out.push(r);
    }
    if (page === 0) console.log(`${label}: TotalCount ${resp.TotalCount ?? "?"}`);
    if (oldestMs < FROM_MS && oldestMs !== Infinity) break;
    if (rows.length < 100) break;
  }
  return out;
}

// ---- 1. MarketPlace/Invoice/List, ALL statuses ----
console.log("\n=== MarketPlace/Invoice/List — ALL statuses, Nov 1-13 IST ===");
const invs = await collect("/Services/MarketPlace/Invoice/List", "MP Invoices");
console.log(`In window: ${invs.length}`);
const invByStatus = new Map<number | string, number>();
for (const r of invs) {
  const s = (r.document_status as number | undefined) ?? "null";
  invByStatus.set(s, (invByStatus.get(s) ?? 0) + 1);
}
console.log("Status distribution:");
for (const [s, c] of [...invByStatus].sort()) console.log(`  status=${s}: ${c}`);

// Collect Shopify order ids from invoices.
const invOrderIds = new Set<string>();
for (const r of invs) {
  const eid = r.external_order_id ?? r.marketplace_order_id ?? r.marketplace_order_no;
  if (eid != null) invOrderIds.add(String(eid));
}

// ---- 2. MarketPlace/Order/List ----
console.log("\n=== MarketPlace/Order/List — ALL statuses, Nov 1-13 IST ===");
try {
  const orders = await collect("/Services/MarketPlace/Order/List", "MP Orders");
  console.log(`In window: ${orders.length}`);
  const ordByStatus = new Map<number | string, number>();
  for (const r of orders) {
    const s = (r.document_status as number | undefined) ?? "null";
    ordByStatus.set(s, (ordByStatus.get(s) ?? 0) + 1);
  }
  console.log("Status distribution:");
  for (const [s, c] of [...ordByStatus].sort()) console.log(`  status=${s}: ${c}`);
  if (orders.length > 0) {
    console.log("Field names on first marketplace order:");
    console.log("  ", Object.keys(orders[0]).sort().join(", "));
  }
  // Count how many Order rows have an external_order_id NOT seen in invoices.
  const orderOnlyIds = new Set<string>();
  for (const r of orders) {
    const eid = r.external_order_id ?? r.marketplace_order_id ?? r.marketplace_order_no;
    if (eid != null && !invOrderIds.has(String(eid))) orderOnlyIds.add(String(eid));
  }
  console.log(`\nMarketPlace Orders with external_order_id NOT present as a posted Invoice: ${orderOnlyIds.size}`);
  if (orderOnlyIds.size > 0) {
    console.log("Sample Shopify-ish ids (first 10):");
    for (const id of [...orderOnlyIds].slice(0, 10)) console.log(`  ${id}`);
  }
} catch (e) {
  console.log(`  FAILED: ${(e as Error).message}`);
}

// ---- 3. Print the 57 external_order_ids we DO have as posted invoices ----
console.log("\n=== Shopify order IDs we DO have as posted invoices (Nov 1-13) ===");
const sortedIds = [...invOrderIds].sort();
console.log(`${sortedIds.length} ids total`);
for (const id of sortedIds) console.log(`  ${id}`);
