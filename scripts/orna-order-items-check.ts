// READ-ONLY probe: what does line_items look like in POS/Order/Retrieve?
// Needed to populate a "what did they buy" field on conversions for the funnel.
// Run: npx tsx scripts/orna-order-items-check.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured } from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) {
  console.log("OrnaVerse env not set.");
  process.exit(1);
}
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// Pull a recent order id.
const list = (await post("/Services/POS/Order/List", { Skip: 0, Take: 1 })) as {
  Entities?: Array<{ transaction_id?: number }>;
};
const id = list.Entities?.[0]?.transaction_id;
if (!id) {
  console.log("no orders to probe");
  process.exit(0);
}

const r = (await post("/Services/POS/Order/Retrieve", { EntityId: id })) as {
  Entity?: Record<string, unknown>;
};
const entity = r.Entity ?? {};
const lineItems = entity.line_items as Array<Record<string, unknown>> | undefined;
console.log(`Order id ${id}: line_items length = ${lineItems?.length ?? 0}`);
if (lineItems && lineItems.length > 0) {
  console.log("\nField names on first line_item:");
  console.log("  ", Object.keys(lineItems[0]).sort().join(", "));
  // Just the display-friendly fields, no PII (item_name is a product description, safe).
  const SAFE = /^(item_name|item_code|style_code|base_item|type_name|sub_type_name|metal_name|karat_name|pieces|net_amount|net_weight|discount|sku)$/;
  console.log("\nSafe display fields across all line_items:");
  for (const li of lineItems) {
    const picked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(li)) {
      if (SAFE.test(k) && v != null && v !== "") picked[k] = v;
    }
    console.log("  ", JSON.stringify(picked));
  }
}
