// One-off READ-ONLY probe to see whether Lucira's OrnaVerse tenant uses the
// MarketPlace module (= online/marketplace orders). Two tiny List calls:
//   1. MarketPlace/Channels/List  Take 10  — channels configured (zero PII)
//   2. MarketPlace/Invoice/List   Take 3   — field names + sample values on 3 recent online invoices
// All customer PII is redacted in output.
//
// Run: npx tsx scripts/orna-marketplace-check.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured } from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) {
  console.log("OrnaVerse env not set.");
  process.exit(1);
}
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();
console.log("1. login: ok");

async function listCall(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// ---- 2. Channels ----
try {
  const ch = (await listCall("/Services/MarketPlace/Channels/List", { Skip: 0, Take: 10 })) as {
    Entities?: Array<Record<string, unknown>>;
    TotalCount?: number;
  };
  const rows = ch.Entities ?? [];
  console.log(`\n2. MarketPlace/Channels/List: ${rows.length} rows (TotalCount ${ch.TotalCount ?? "?"})`);
  console.table(
    rows.map((r) => ({
      id: r.id ?? r.channel_id ?? r.transaction_id,
      name: r.name ?? r.channel_name ?? r.description,
      code: r.code ?? r.channel_code,
      active: r.is_active ?? r.active,
    }))
  );
} catch (e) {
  console.log(`\n2. MarketPlace/Channels/List: FAILED → ${(e as Error).message}`);
}

// ---- 3. Invoices ----
// PII to mask on sight: phone, email, name, address.
const PII_KEYS = /(phone|mobile|email|name|address|first|last|full|contact|whatsapp)/i;
function redactRow(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (PII_KEYS.test(k)) out[k] = typeof v === "string" && v.length > 0 ? `<redacted:${v.length}ch>` : "<redacted>";
    else if (typeof v === "object") out[k] = Array.isArray(v) ? `[array:${v.length}]` : "{obj}";
    else out[k] = v;
  }
  return out;
}

try {
  const inv = (await listCall("/Services/MarketPlace/Invoice/List", { Skip: 0, Take: 3 })) as {
    Entities?: Array<Record<string, unknown>>;
    TotalCount?: number;
  };
  const rows = inv.Entities ?? [];
  console.log(`\n3. MarketPlace/Invoice/List: ${rows.length} rows (TotalCount ${inv.TotalCount ?? "?"})`);
  if (rows.length > 0) {
    console.log("\n   field names on the first invoice:");
    console.log("  ", Object.keys(rows[0]).sort().join(", "));
    console.log("\n   first 3 invoices (PII redacted):");
    for (const r of rows) console.log("  ", JSON.stringify(redactRow(r)));
  }
} catch (e) {
  console.log(`\n3. MarketPlace/Invoice/List: FAILED → ${(e as Error).message}`);
}
