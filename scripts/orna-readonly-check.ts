// One-off READ-ONLY check against Lucira's PRODUCTION OrnaVerse tenant.
// Answers the questions only live data can: backdated bills, id order,
// Retrieve request format, webhook event names and payload shape.
//
// Calls (all reads; nothing is created, changed or posted):
//   1. POST /connect/token                                  (login)
//   2. POST /Services/POS/Invoice/List      Take 10         (latest bills)
//   3. POST /Services/POS/Invoice/Retrieve  newest id       (one bill)
//   4. POST .../WebhookSubscriptions/ListIntegrationEntityTypes
//   5. POST .../WebhookSubscriptions/SamplePayload          (generated example)
//
// Prints NO customer data: only ids, dates, status, and the *field names* /
// value types of the sample payload. Run: npx tsx scripts/orna-readonly-check.ts
import "dotenv/config";
import {
  fetchInvoicePage,
  getOrnaverseToken,
  ornaverseConfigured,
  parseOrnaverseDate,
  retrieveOrnaverseSale,
} from "../src/importers/ornaverse.js";

if (!ornaverseConfigured()) {
  console.log("OrnaVerse env not set (ORNAVERSE_API_BASE / CLIENT_ID / CLIENT_SECRET).");
  process.exit(1);
}
const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
const token = await getOrnaverseToken();
console.log("1. login: ok");

// ---- 2. latest bills: dates and id order ----
type Row = Record<string, unknown>;
const page = await fetchInvoicePage(token, { Skip: 0, Take: 10 });
const rows = (page.Entities ?? []) as Row[];
console.log(`\n2. Invoice/List: ${rows.length} rows (TotalCount ${page.TotalCount ?? "?"})`);
console.table(
  rows.map((r) => ({
    transaction_id: r.transaction_id,
    document_date: r.document_date,
    creation_date: r.creation_date,
    modification_date: r.modification_date,
    status: r.document_status,
  }))
);
const ms = (v: unknown) => parseOrnaverseDate(typeof v === "string" ? v : undefined);
const hasCreation = rows.filter((r) => r.creation_date != null).length;
const timeOnly = (v: unknown) => typeof v === "string" && !/T00:00:00(\.0+)?$/.test(v);
console.log(`   creation_date present: ${hasCreation}/${rows.length}`);
console.log(`   document_date has a real time: ${rows.filter((r) => timeOnly(r.document_date)).length}/${rows.length}`);
console.log(`   creation_date has a real time: ${rows.filter((r) => timeOnly(r.creation_date)).length}/${rows.length}`);
let inOrder = true;
for (let i = 1; i < rows.length; i++) {
  const prev = ms(rows[i - 1].creation_date);
  const cur = ms(rows[i].creation_date);
  if (prev != null && cur != null && cur > prev) inOrder = false;
}
console.log(`   newer id ⇒ newer-or-equal creation_date: ${hasCreation ? inOrder : "unknown (no creation_date)"}`);
const backdated = rows.filter((r) => {
  const d = ms(r.document_date);
  const c = ms(r.creation_date);
  return d != null && c != null && c - d > 24 * 3600 * 1000;
});
console.log(`   entered >1 day after bill date (backdated): ${backdated.map((r) => r.transaction_id).join(", ") || "none"}`);

// ---- 3. Retrieve one bill (checks the { EntityId } request format) ----
const newestId = rows[0]?.transaction_id;
if (newestId != null) {
  try {
    const out = await retrieveOrnaverseSale(newestId);
    console.log(
      `\n3. Invoice/Retrieve ${newestId}:`,
      out.kind === "sale" ? `ok → sale ${out.sale.sale_id}` : `skipped (${out.reason})`
    );
  } catch (err) {
    console.log(`\n3. Invoice/Retrieve ${newestId}: FAILED ${(err as Error).message}`);
  }
}

// ---- 4 + 5. webhook event names and sample payload shape ----
async function post(path: string, body: unknown): Promise<{ status: number; json: Row }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let json: Row = {};
  try {
    json = (await res.json()) as Row;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

const types = await post("/Services/Administration/WebhookSubscriptions/ListIntegrationEntityTypes", {});
const entityTypes = (types.json.EntityTypes ?? []) as Array<{ entity_type?: string; module?: string; display_name?: string }>;
console.log(`\n4. ListIntegrationEntityTypes: HTTP ${types.status}, ${entityTypes.length} types`);
console.table(entityTypes);
if (types.json.Error) console.log("   error:", JSON.stringify(types.json.Error));

/** Field paths + value types only — never the values themselves. */
function shape(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) {
    out.push(`${path || "(root)"}: array[${v.length}]`);
    if (v.length) shape(v[0], `${path}[0]`, out);
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) shape(val, path ? `${path}.${k}` : k, out);
  } else {
    out.push(`${path || "(root)"}: ${v === null ? "null" : typeof v}`);
  }
  return out;
}

const invoiceType = entityTypes.find(
  (t) => /invoice/i.test(`${t.entity_type} ${t.display_name}`) && /pos/i.test(`${t.module} ${t.entity_type}`)
)?.entity_type;
console.log(`\n5. SamplePayload for entity_type: ${invoiceType ?? "(no POS invoice type found)"}`);
if (invoiceType) {
  for (const operation of [1, 2, 3, 4, 5]) {
    const r = await post("/Services/Administration/WebhookSubscriptions/SamplePayload", {
      entity_type: invoiceType,
      operation,
    });
    const raw = r.json.Payload;
    console.log(`\n   operation ${operation}: HTTP ${r.status}${r.json.Error ? " error " + JSON.stringify(r.json.Error) : ""}`);
    if (typeof raw !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.log(`   payload is not JSON (${raw.length} chars)`);
      continue;
    }
    console.log(shape(parsed).map((l) => "     " + l).join("\n"));
  }
}
console.log("\nDone. Nothing was created or changed in OrnaVerse.");
