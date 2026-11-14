// READ-ONLY probe: walk MarketPlace/Invoice forward from Skip=0 (newest first)
// and count rows per day for the Nov 1-13 window. Compare to our import count.
// Run from repo root: cd lucira-capi && npx tsx scripts/orna-mp-count-check.ts
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

const totalPosted = (await post("/Services/MarketPlace/Invoice/List", {
  Skip: 0, Take: 1, EqualityFilter: { document_status: 1 },
}) as { TotalCount?: number }).TotalCount ?? 0;
console.log(`TotalCount (posted): ${totalPosted}`);

// Walk FORWARD from Skip=0 (newest should be first for marketplace)
console.log("\n=== Forward Skip pages, status=1, scanning for Nov 1-13 window ===");
let scanned = 0;
let inWindow = 0;
const dayDist = new Map<string, number>();
const dayValue = new Map<string, number>();
const firstPageDates: string[] = [];

for (let page = 0; page < 10; page++) {
  const resp = await post("/Services/MarketPlace/Invoice/List", {
    Skip: page * 100,
    Take: 100,
    EqualityFilter: { document_status: 1 },
  }) as { Entities?: Array<Record<string, unknown>> };
  const rows = resp.Entities ?? [];
  if (rows.length === 0) break;
  scanned += rows.length;

  let newestOnPage = -Infinity;
  let oldestOnPage = Infinity;
  for (const r of rows) {
    const d = parseOrnaverseDate(typeof r.document_date === "string" ? r.document_date : undefined);
    if (d == null) continue;
    if (d > newestOnPage) newestOnPage = d;
    if (d < oldestOnPage) oldestOnPage = d;
    if (page === 0 && firstPageDates.length < 5) firstPageDates.push(new Date(d).toISOString().slice(0,10));
    if (d >= FROM_MS && d < TO_MS) {
      inWindow++;
      const day = new Date(d + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      dayDist.set(day, (dayDist.get(day) ?? 0) + 1);
      const amt = Number(r.net_amount ?? 0);
      dayValue.set(day, (dayValue.get(day) ?? 0) + amt);
    }
  }
  const newestISO = newestOnPage === -Infinity ? "n/a" : new Date(newestOnPage).toISOString().slice(0,10);
  const oldestISO = oldestOnPage === Infinity ? "n/a" : new Date(oldestOnPage).toISOString().slice(0,10);
  console.log(`  page ${page+1}: skip=${page*100} rows=${rows.length} newest=${newestISO} oldest=${oldestISO}`);
  if (oldestOnPage < FROM_MS && oldestOnPage !== Infinity) {
    console.log("  -> oldest-on-page pre-dates window. Stopping.");
    break;
  }
  if (rows.length < 100) break;
}

console.log(`\nFirst-page sample dates: ${firstPageDates.join(", ")}`);
console.log(`In window Nov 1-13 IST (posted): ${inWindow}`);
console.log("\nDay distribution (Nov 1-13 IST):");
for (const [d,c] of [...dayDist].sort()) {
  const v = dayValue.get(d) ?? 0;
  console.log(`  ${d}: ${c} invoices, ₹${v.toLocaleString("en-IN")}`);
}
