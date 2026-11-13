// READ-ONLY probe: is CRM/CustomerVisits actually used by Lucira?
//   1. CRM/CustomerVisits/List  Take 3  — field names + sample values on 3 recent visits
// Customer PII redacted in output.
//
// Run: npx tsx scripts/orna-customer-visits-check.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured } from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) {
  console.log("OrnaVerse env not set.");
  process.exit(1);
}
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();
console.log("login: ok");

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

const PII_KEYS = /(phone|mobile|email|name|address|first|last|full|contact|whatsapp)/i;
function redact(obj: Record<string, unknown>): Record<string, unknown> {
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
  const r = (await listCall("/Services/CRM/CustomerVisits/List", { Skip: 0, Take: 3 })) as {
    Entities?: Array<Record<string, unknown>>;
    TotalCount?: number;
  };
  const rows = r.Entities ?? [];
  console.log(`\nCRM/CustomerVisits/List: ${rows.length} rows (TotalCount ${r.TotalCount ?? "?"})`);
  if (rows.length > 0) {
    console.log("\nfield names on first row (sorted):");
    console.log("  ", Object.keys(rows[0]).sort().join(", "));
    console.log("\nfirst 3 visits (PII redacted):");
    for (const row of rows) console.log("  ", JSON.stringify(redact(row)));
  }
} catch (e) {
  console.log(`\nCRM/CustomerVisits/List: FAILED → ${(e as Error).message}`);
}
