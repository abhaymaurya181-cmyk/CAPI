// READ-ONLY probe: discover visit_type enum in CRM/CustomerVisits.
// Pulls the newest Take=100 and tallies distinct visit_type values seen,
// plus one Retrieve per distinct type to sanity-check fields. No PII printed.
//
// Run: npx tsx scripts/orna-visit-types-probe.ts
import "dotenv/config";
import { getOrnaverseToken, ornaverseConfigured } from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) {
  console.log("OrnaVerse env not set.");
  process.exit(1);
}
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();
console.log("login: ok");

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

type Row = {
  id?: number;
  date?: string;
  visit_type?: number;
  customer_type?: number;
  company_code?: string;
  mobile?: unknown;
  email?: unknown;
};

// ---- 1. Sample: oldest 100 + newest 100 (Sort clause 500s on this tenant) ----
// First get TotalCount to compute Skip for the newest page.
const probe = (await post("/Services/CRM/CustomerVisits/List", { Skip: 0, Take: 1 })) as {
  TotalCount?: number;
};
const total = probe.TotalCount ?? 0;
const newestSkip = Math.max(0, total - 100);

const [oldest, newest] = await Promise.all([
  post("/Services/CRM/CustomerVisits/List", { Skip: 0, Take: 100 }) as Promise<{
    Entities?: Row[];
  }>,
  post("/Services/CRM/CustomerVisits/List", { Skip: newestSkip, Take: 100 }) as Promise<{
    Entities?: Row[];
  }>,
]);
const rows = [...(oldest.Entities ?? []), ...(newest.Entities ?? [])];
console.log(`\nSampled ${rows.length} of ${total} total (oldest 100 + newest 100)`);

if (rows.length === 0) {
  console.log("Empty — stopping.");
  process.exit(0);
}

// ---- 2. Distinct visit_type tally ----
const tally = new Map<number | string, number>();
for (const r of rows) {
  const k = r.visit_type ?? "null";
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log("\nvisit_type distribution in newest 100:");
for (const [k, v] of [...tally].sort((a, b) => Number(b[1]) - Number(a[1]))) {
  console.log(`  visit_type=${k}: ${v}`);
}

// ---- 3. How many have usable matching keys (phone / email) ----
const hasPhone = rows.filter((r) => typeof r.mobile === "string" && r.mobile.length >= 10).length;
const hasEmail = rows.filter((r) => typeof r.email === "string" && String(r.email).includes("@")).length;
const hasEither = rows.filter(
  (r) =>
    (typeof r.mobile === "string" && r.mobile.length >= 10) ||
    (typeof r.email === "string" && String(r.email).includes("@"))
).length;
console.log(`\nmatch keys in newest 100: phone=${hasPhone}, email=${hasEmail}, either=${hasEither}`);

// ---- 4. Date range of the 100 rows ----
const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
if (dates.length) {
  console.log(`\ndate range (newest 100): ${dates[0]} → ${dates.at(-1)}`);
}

// ---- 5. company_code distribution ----
const comp = new Map<string, number>();
for (const r of rows) comp.set(r.company_code ?? "null", (comp.get(r.company_code ?? "null") ?? 0) + 1);
console.log("\ncompany_code distribution in newest 100:");
for (const [k, v] of [...comp].sort((a, b) => Number(b[1]) - Number(a[1]))) {
  console.log(`  company_code=${k}: ${v}`);
}

// ---- 6. Retrieve one of each distinct visit_type: inspect full fields ----
console.log("\nretrieving one record per distinct visit_type (no PII in output):");
const PII_KEYS = /(phone|mobile|email|name|address|first|last|full|contact|whatsapp|remark|note|comment)/i;
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

const seen = new Set<number | string>();
for (const r of rows) {
  const t = r.visit_type ?? "null";
  if (seen.has(t) || !r.id) continue;
  seen.add(t);
  try {
    const rr = (await post("/Services/CRM/CustomerVisits/Retrieve", { EntityId: r.id })) as {
      Entity?: Record<string, unknown>;
    };
    if (rr.Entity) {
      console.log(`  visit_type=${t} id=${r.id}:`);
      console.log("    ", JSON.stringify(redact(rr.Entity)));
    }
  } catch (e) {
    console.log(`  visit_type=${t} id=${r.id}: Retrieve FAILED → ${(e as Error).message}`);
  }
}
