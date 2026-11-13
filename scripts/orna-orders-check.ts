// READ-ONLY probe: can we use POS/Order/List as the primary source?
//   1. POS/Order/List            Take 100  — field names, status distribution
//   2. POS/Order/Retrieve                  — one record per distinct status
//   3. POS/OrderItems/List       Take 5    — confirm line_id lives here
//   4. POS/Invoice/List          Take 1 of a RECENT invoice to see if it carries
//                                            the order's line_id / id for dedup
// All PII redacted. Run: npx tsx scripts/orna-orders-check.ts
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

// ---- 1. Order List, Take 100 ----
type OrderRow = {
  transaction_id?: number;
  document_no?: string;
  document_date?: string;
  document_status?: number;
  creation_date?: string;
  net_amount?: number;
  mobile?: string;
  email?: string;
  party_name?: string;
};
try {
  const resp = (await post("/Services/POS/Order/List", { Skip: 0, Take: 100 })) as {
    Entities?: OrderRow[];
    TotalCount?: number;
  };
  const rows = resp.Entities ?? [];
  console.log(`\nPOS/Order/List: ${rows.length} rows (TotalCount ${resp.TotalCount ?? "?"})`);

  if (rows.length) {
    console.log("\nfield names on first order (sorted):");
    console.log("  ", Object.keys(rows[0]).sort().join(", "));

    const statusDist = new Map<number | string, number>();
    for (const r of rows) statusDist.set(r.document_status ?? "null", (statusDist.get(r.document_status ?? "null") ?? 0) + 1);
    console.log("\ndocument_status distribution:");
    for (const [k, v] of [...statusDist].sort((a, b) => Number(b[1]) - Number(a[1]))) {
      console.log(`  document_status=${k}: ${v}`);
    }

    // Match keys present
    const hasPhone = rows.filter((r) => typeof r.mobile === "string" && r.mobile.length >= 10).length;
    const hasEmail = rows.filter((r) => typeof r.email === "string" && String(r.email).includes("@")).length;
    console.log(`\nmatch keys: phone=${hasPhone}, email=${hasEmail}, either=${rows.filter((r) => (typeof r.mobile === "string" && r.mobile.length >= 10) || (typeof r.email === "string" && String(r.email).includes("@"))).length}`);

    // Order date vs creation date — are they different?
    const sameDay = rows.filter((r) => {
      const d = r.document_date?.slice(0, 10);
      const c = r.creation_date?.slice(0, 10);
      return d && c && d === c;
    }).length;
    console.log(`\ndocument_date == creation_date (same day): ${sameDay}/${rows.length}`);

    // Dates span
    const dates = rows.map((r) => r.document_date).filter((d): d is string => !!d).sort();
    if (dates.length) console.log(`date range in sample: ${dates[0]} → ${dates.at(-1)}`);

    // Retrieve one of each status
    console.log("\nretrieving one row per distinct status (PII redacted):");
    const seen = new Set<number | string>();
    for (const r of rows) {
      const s = r.document_status ?? "null";
      if (seen.has(s) || !r.transaction_id) continue;
      seen.add(s);
      try {
        const rr = (await post("/Services/POS/Order/Retrieve", { EntityId: r.transaction_id })) as {
          Entity?: Record<string, unknown>;
        };
        if (rr.Entity) {
          console.log(`  status=${s} id=${r.transaction_id}:`);
          console.log("    ", JSON.stringify(redact(rr.Entity)));
        }
      } catch (e) {
        console.log(`  status=${s} id=${r.transaction_id}: Retrieve FAILED → ${(e as Error).message}`);
      }
    }
  }
} catch (e) {
  console.log(`\nPOS/Order/List: FAILED → ${(e as Error).message}`);
}

// ---- 2. POS/OrderItems/List for line_id semantics ----
try {
  const resp = (await post("/Services/POS/OrderItems/List", { Skip: 0, Take: 5 })) as {
    Entities?: Array<Record<string, unknown>>;
    TotalCount?: number;
  };
  const rows = resp.Entities ?? [];
  console.log(`\nPOS/OrderItems/List: ${rows.length} rows (TotalCount ${resp.TotalCount ?? "?"})`);
  if (rows.length) {
    console.log("field names on first row:");
    console.log("  ", Object.keys(rows[0]).sort().join(", "));
    console.log("first row (PII redacted):");
    console.log("  ", JSON.stringify(redact(rows[0])));
  }
} catch (e) {
  console.log(`\nPOS/OrderItems/List: FAILED → ${(e as Error).message}`);
}

// ---- 3. POS/Invoice/List: look for order-link fields ----
try {
  const resp = (await post("/Services/POS/Invoice/List", { Skip: 0, Take: 1 })) as {
    Entities?: Array<Record<string, unknown>>;
  };
  const row = (resp.Entities ?? [])[0];
  if (row) {
    const linkKeys = Object.keys(row).filter((k) => /order|ref_|line_id|source/i.test(k));
    console.log(`\nPOS/Invoice/List: link-ish keys on row = ${linkKeys.join(", ") || "(none)"}`);
    const picked: Record<string, unknown> = {};
    for (const k of linkKeys) picked[k] = row[k];
    console.log("  values:", JSON.stringify(picked));
  }
} catch (e) {
  console.log(`\nPOS/Invoice/List: FAILED → ${(e as Error).message}`);
}
