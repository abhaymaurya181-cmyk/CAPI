import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _resetTokenCache } from "../src/importers/ornaverse.js";
import {
  fetchOrnaverseVisits,
  mapVisitRow,
  type CustomerVisitRow,
} from "../src/importers/ornaverse-visits.js";

function mockFetch(responses: Array<{ status?: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("mock_fetch_out_of_responses:" + url);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: impl, calls };
}

const ORIG = { ...process.env };
beforeEach(() => {
  _resetTokenCache();
  process.env.ORNAVERSE_API_BASE = "https://test.ornaverse.in";
  process.env.ORNAVERSE_CLIENT_ID = "cid";
  process.env.ORNAVERSE_CLIENT_SECRET = "csec";
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIG)) delete process.env[k];
  Object.assign(process.env, ORIG);
});

const tokenResp = { status: 200, body: { access_token: "t", expires_in: 3600 } };

test("mapVisitRow: walk-in → SaleInput with amount 0, visit- prefix, Walk-in store name", () => {
  const row: CustomerVisitRow = {
    id: 5134,
    date: "2026-11-11T10:11:44.913Z",
    visit_type: 1,
    mobile: "9876543210",
    email: "abc@example.com",
    customer_name: "Ravi Kumar",
    company_code: "PN1",
  };
  const sale = mapVisitRow(row);
  assert.equal(sale?.sale_id, "visit-5134");
  assert.equal(sale?.amount, 0);
  assert.equal(sale?.phone, "9876543210");
  assert.equal(sale?.email, "abc@example.com");
  assert.equal(sale?.first_name, "Ravi");
  assert.equal(sale?.last_name, "Kumar");
  assert.equal(sale?.store_name, "Walk-in (PN1)");
});

test("mapVisitRow: rejects rows with no phone AND no email (no match key)", () => {
  const row: CustomerVisitRow = {
    id: 1, date: "2026-11-11T10:11:44Z", visit_type: 1, customer_name: "Ghost Customer",
  };
  assert.equal(mapVisitRow(row), null);
});

test("mapVisitRow: rejects rows with no id or no date", () => {
  assert.equal(mapVisitRow({ date: "2026-11-11", visit_type: 1, mobile: "9876543210" }), null);
  assert.equal(mapVisitRow({ id: 1, visit_type: 1, mobile: "9876543210" }), null);
});

test("fetchOrnaverseVisits: EqualityFilter sends visit_type=1 and keeps only walk-ins", async () => {
  const rows: CustomerVisitRow[] = [
    { id: 10, date: "2026-11-13T10:00:00Z", visit_type: 1, mobile: "9000000001", customer_name: "A" },
    { id: 11, date: "2026-11-13T11:00:00Z", visit_type: 2, mobile: "9000000002", customer_name: "B" }, // not walk-in
    { id: 12, date: "2026-11-13T12:00:00Z", visit_type: 1, mobile: "9000000003", customer_name: "C" },
  ];
  // Reverse-page importer: head call (TotalCount=3), then one page with Skip:0 Take:3.
  const m = mockFetch([
    tokenResp,
    { body: { Entities: [], TotalCount: 3 } },
    { body: { Entities: rows, TotalCount: 3 } },
  ]);
  const visits = await fetchOrnaverseVisits(
    new Date("2026-11-12T00:00:00Z"),
    new Date("2026-11-14T00:00:00Z"),
    m.fetch
  );
  // visit_type=2 must be dropped; order follows the reversed-page iteration.
  const ids = visits.map((v) => v.sale_id).sort();
  assert.deepEqual(ids, ["visit-10", "visit-12"]);
  // EqualityFilter on every call.
  for (const c of m.calls.slice(1)) {
    const body = JSON.parse((c.init?.body as string) ?? "{}");
    assert.deepEqual(body.EqualityFilter, { visit_type: 1 });
  }
});
