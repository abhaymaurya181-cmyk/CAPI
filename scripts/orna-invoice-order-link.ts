// READ-ONLY probe: find the link field between POS Invoice and POS Order.
// Scans recent POS Invoices + their line-items via Retrieve, and reports which
// fields carry the order transaction_id (if any).
//
// Run from repo root: cd lucira-capi && npx tsx scripts/orna-invoice-order-link.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured } from "../src/importers/ornaverse.js";

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

// ---- 1. POS/Invoice/List top-level ref_* field distribution ----
console.log("=== Scanning 100 recent POS invoices for top-level ref_* / order fields ===");
const list = (await post("/Services/POS/Invoice/List", { Skip: 0, Take: 100 })) as {
  Entities?: Array<Record<string, unknown>>;
};
const invs = list.Entities ?? [];
console.log(`Got ${invs.length} invoices`);

const refTxWithValue = invs.filter((r) => (r.ref_transaction_id as number) > 0).length;
const refDocWithValue = invs.filter((r) => (r.ref_document_id as number) > 0).length;
console.log(`  invoices with ref_transaction_id > 0: ${refTxWithValue}`);
console.log(`  invoices with ref_document_id > 0:    ${refDocWithValue}`);

// Collect any field with a numeric value that might reference an order
const linkFieldHits = new Map<string, number>();
for (const r of invs) {
  for (const [k, v] of Object.entries(r)) {
    if (/order|ref_|source_|link/i.test(k) && typeof v === "number" && v > 0) {
      linkFieldHits.set(k, (linkFieldHits.get(k) ?? 0) + 1);
    }
  }
}
console.log("Fields with /order|ref_/ in name that have non-zero values across 100 invoices:");
for (const [k, c] of [...linkFieldHits]) console.log(`  ${k}: ${c}`);

// ---- 2. Retrieve a few invoices, scan line_items for ref_transaction_id ----
console.log("\n=== Retrieving 5 invoices, scanning line_items for order references ===");
let withLinked = 0;
let withoutLinked = 0;
for (let i = 0; i < Math.min(5, invs.length); i++) {
  const inv = invs[i];
  const id = inv.transaction_id as number;
  const retrieve = (await post("/Services/POS/Invoice/Retrieve", { EntityId: id })) as {
    Entity?: { line_items?: Array<Record<string, unknown>> };
  };
  const items = retrieve.Entity?.line_items ?? [];
  const linkFields = new Set<string>();
  let anyLinked = false;
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      if (/order|ref_|source_/i.test(k) && typeof v === "number" && v > 0) {
        linkFields.add(`${k}=${v}`);
        anyLinked = true;
      }
    }
  }
  console.log(`  invoice id=${id} doc_no=${inv.document_no}  items=${items.length}  linked_fields=${[...linkFields].slice(0,5).join(", ") || "(none)"}`);
  if (anyLinked) withLinked++; else withoutLinked++;
}

console.log(`\n${withLinked}/5 invoices had an order-reference field in their line_items`);
console.log(`${withoutLinked}/5 had NONE (likely RTS: invoice created directly)`);

// ---- 3. Also probe POS/GetPOSOrderItems/List — may be the inverse (orders→invoice) ----
console.log("\n=== POS/GetPOSOrderItems/List (first row) ===");
try {
  const r = (await post("/Services/POS/GetPOSOrderItems/List", { Skip: 0, Take: 1 })) as {
    Entities?: Array<Record<string, unknown>>;
    TotalCount?: number;
  };
  console.log(`TotalCount: ${r.TotalCount ?? "?"}`);
  if (r.Entities?.[0]) {
    console.log("Field names on first row:");
    console.log("  ", Object.keys(r.Entities[0]).sort().join(", "));
  }
} catch (e) {
  console.log(`  FAILED: ${(e as Error).message}`);
}
