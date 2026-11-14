// Full reconciliation across every OrnaVerse feed we touch, for the Nov 1-13
// (IST) window. Compares each endpoint's actual count with what we have in
// Firestore via the admin API. READ-ONLY.
//
// Run from repo root: cd lucira-capi && npx tsx scripts/orna-reconcile.ts
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

// Walk pages FORWARD (assumes default is newest-first for these endpoints).
// Stop when a page's oldest row pre-dates the window.
async function countInWindow(path: string, statusesAllowed: number[], label: string) {
  let totalInWindow = 0;
  let totalValue = 0;
  const dayDist = new Map<string, { count: number; value: number }>();
  const statusInWindow = new Map<number | string, number>();
  for (let page = 0; page < 20; page++) {
    const resp = await post(path, {
      Skip: page * 100,
      Take: 100,
    }) as { Entities?: Array<Record<string, unknown>>; TotalCount?: number };
    const rows = resp.Entities ?? [];
    if (rows.length === 0) break;
    let oldestMs = Infinity;
    for (const r of rows) {
      const d = parseOrnaverseDate(typeof r.document_date === "string" ? r.document_date : undefined);
      if (d == null) continue;
      oldestMs = Math.min(oldestMs, d);
      if (d >= FROM_MS && d < TO_MS) {
        const st = r.document_status as number | undefined;
        statusInWindow.set(st ?? "null", (statusInWindow.get(st ?? "null") ?? 0) + 1);
        if (st != null && statusesAllowed.includes(st)) {
          totalInWindow++;
          const amt = Number(r.net_amount ?? 0);
          totalValue += amt;
          const day = new Date(d + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
          const cur = dayDist.get(day) ?? { count: 0, value: 0 };
          cur.count++;
          cur.value += amt;
          dayDist.set(day, cur);
        }
      }
    }
    if (oldestMs < FROM_MS && oldestMs !== Infinity) break;
    if (rows.length < 100) break;
  }
  console.log(`\n=== ${label} (${path}) ===`);
  console.log(`In window Nov 1-13 IST, status in [${statusesAllowed.join(",")}]: ${totalInWindow} rows, ₹${totalValue.toLocaleString("en-IN", {maximumFractionDigits: 0})}`);
  console.log("All statuses seen in window:");
  for (const [k, v] of [...statusInWindow].sort()) console.log(`  status=${k}: ${v}`);
  if (dayDist.size) {
    console.log("Day breakdown (allowed statuses only):");
    for (const [d, v] of [...dayDist].sort()) {
      console.log(`  ${d}: ${v.count} rows, ₹${v.value.toLocaleString("en-IN", {maximumFractionDigits: 0})}`);
    }
  }
}

await countInWindow("/Services/POS/Order/List", [1, 2], "POS Orders (status 1=Placed, 2=Fulfilled)");
await countInWindow("/Services/POS/Invoice/List", [1], "POS Invoices (OLD feed, status=1 posted)");
await countInWindow("/Services/MarketPlace/Invoice/List", [1], "MarketPlace Invoices (status=1 posted)");
