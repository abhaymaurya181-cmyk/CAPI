// Standalone smoke test for OrnaVerse auth + invoice read.
// READ-ONLY — only POST to /connect/token (auth) and /POS/Invoice/List (list).
import "dotenv/config";

const base = (process.env.ORNAVERSE_API_BASE || "").replace(/\/$/, "");
const scope = process.env.ORNAVERSE_SCOPE || "openid";

async function getToken() {
  const tr = await fetch(base + "/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.ORNAVERSE_CLIENT_ID,
      client_secret: process.env.ORNAVERSE_CLIENT_SECRET,
      scope,
    }).toString(),
  });
  const tj = await tr.json();
  console.log("token HTTP:", tr.status, "len:", (tj.access_token || "").length);
  if (!tj.access_token) {
    console.log("token response:", JSON.stringify(tj, null, 2));
    process.exit(1);
  }
  return tj.access_token;
}

const token = await getToken();

async function list(label, body) {
  const r = await fetch(base + "/Services/POS/Invoice/List", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  return { status: r.status, body: j, raw: txt };
}

// H: Default order check — pull 5 rows, see if they're newest-first
console.log("\n[H: default order of 5 rows]");
{
  const { status, body } = await list("H", { Take: 5 });
  console.log("  HTTP", status, "returned", (body?.Entities || []).length);
  for (const row of body?.Entities || []) {
    console.log("  ", row.transaction_id, row.document_date, "status=" + row.document_status, "store=" + row.company_name);
  }
}

// I: Distinct document_status codes in the data — pull first 100, aggregate
console.log("\n[I: distinct document_status codes across first 100]");
{
  const { status, body } = await list("I", { Take: 100 });
  console.log("  HTTP", status);
  const counts = new Map();
  for (const row of body?.Entities || []) {
    counts.set(row.document_status, (counts.get(row.document_status) || 0) + 1);
  }
  for (const [code, n] of counts) console.log("  status=" + code + ":", n, "rows");
}

// J: Filter by document_status via EqualityFilter — confirm the filter path works
console.log("\n[J: EqualityFilter by document_status=1]");
{
  const { status, body } = await list("J", {
    Take: 3,
    EqualityFilter: { document_status: 1 },
  });
  console.log("  HTTP", status, "TotalCount:", body?.TotalCount, "returned:", (body?.Entities || []).length);
  for (const row of body?.Entities || []) {
    console.log("  ", row.transaction_id, "status=" + row.document_status, row.document_date);
  }
}

// K: Walk Skip in 100-row jumps to see if default order is stable + find oldest
console.log("\n[K: Skip pagination sanity — pages 0, 10, 19]");
for (const page of [0, 10, 19]) {
  const { status, body } = await list("K" + page, { Skip: page * 100, Take: 1 });
  const row = (body?.Entities || [])[0];
  console.log("  Skip=" + (page * 100), "HTTP", status, row ? `id=${row.transaction_id} date=${row.document_date}` : "no row");
}

// L: Check what EqualityFilter rejects as unknown vs accepts silently
console.log("\n[L: EqualityFilter with unknown field]");
{
  const { status, body, raw } = await list("L", { Take: 1, EqualityFilter: { nonexistent_field: "x" } });
  console.log("  HTTP", status);
  if (status !== 200) console.log("  resp:", raw.slice(0, 500));
  else console.log("  returned:", (body?.Entities || []).length, "TotalCount:", body?.TotalCount);
}
