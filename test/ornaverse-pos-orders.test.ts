import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _resetTokenCache } from "../src/importers/ornaverse.js";
import {
  allowedOrderStatuses,
  fetchOrnaversePosOrders,
  fetchPosOrderPage,
  mapOrderRow,
  type OrderRow,
} from "../src/importers/ornaverse-pos-orders.js";

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

test("mapOrderRow: prefixes sale_id with 'po-', uses order document_date, joins phone", () => {
  const row: OrderRow = {
    transaction_id: 558,
    document_date: "2026-11-13T11:28:07.237Z",
    document_status: 1,
    net_amount: 255336,
    phone_code: "91",
    mobile: "9876543210",
    email: "customer@example.com",
    party_name: "Ravi Kumar",
    shipping_pin_code: "400001",
    company_code: "FCS",
  };
  const sale = mapOrderRow(row);
  assert.equal(sale?.sale_id, "po-558");
  assert.equal(sale?.amount, 255336);
  assert.equal(sale?.phone, "+919876543210");
  assert.equal(sale?.email, "customer@example.com");
  assert.equal(sale?.first_name, "Ravi");
  assert.equal(sale?.last_name, "Kumar");
  assert.equal(sale?.zip, "400001");
  assert.equal(sale?.event_time.toISOString(), "2026-11-13T11:28:07.237Z");
});

test("mapOrderRow: rejects ₹0, missing id, missing date", () => {
  assert.equal(mapOrderRow({ transaction_id: 1, document_date: "2026-11-13", document_status: 1, net_amount: 0 }), null);
  assert.equal(mapOrderRow({ document_date: "2026-11-13", document_status: 1, net_amount: 100 }), null);
  assert.equal(mapOrderRow({ transaction_id: 1, document_status: 1, net_amount: 100 }), null);
});

test("allowedOrderStatuses: backfill → {1}, ongoing → {1,2}, env override honoured", () => {
  assert.deepEqual([...allowedOrderStatuses(true)], [1]);
  assert.deepEqual([...allowedOrderStatuses(false)].sort(), [1, 2]);
  process.env.ORNAVERSE_ORDER_STATUSES = "1,2,3";
  assert.deepEqual([...allowedOrderStatuses(true)].sort(), [1, 2, 3]);
});

test("fetchPosOrderPage: POSTs to POS/Order/List", async () => {
  const m = mockFetch([{ body: { Entities: [], TotalCount: 0 } }]);
  await fetchPosOrderPage("tok", { Skip: 0, Take: 10 }, m.fetch);
  assert.equal(m.calls[0].url, "https://test.ornaverse.in/Services/POS/Order/List");
  assert.equal((m.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("fetchOrnaversePosOrders backfill: only status=1 rows land, status=2 dropped", async () => {
  const rows: OrderRow[] = [
    { transaction_id: 100, document_date: "2026-11-13T10:00:00Z", document_status: 1, net_amount: 1000, mobile: "9000000001", party_name: "A" },
    { transaction_id: 101, document_date: "2026-11-13T11:00:00Z", document_status: 2, net_amount: 2000, mobile: "9000000002", party_name: "B" },
    { transaction_id: 102, document_date: "2026-11-13T12:00:00Z", document_status: 1, net_amount: 3000, mobile: "9000000003", party_name: "C" },
  ];
  const m = mockFetch([tokenResp, { body: { Entities: rows, TotalCount: 3 } }]);
  const sales = await fetchOrnaversePosOrders(
    new Date("2026-11-10T00:00:00Z"),
    new Date("2026-11-14T00:00:00Z"),
    { backfill: true },
    m.fetch
  );
  assert.deepEqual(sales.map((s) => s.sale_id).sort(), ["po-100", "po-102"]);
});

test("fetchOrnaversePosOrders ongoing: both status=1 and status=2 land", async () => {
  const rows: OrderRow[] = [
    { transaction_id: 100, document_date: "2026-11-13T10:00:00Z", document_status: 1, net_amount: 1000, mobile: "9000000001", party_name: "A" },
    { transaction_id: 101, document_date: "2026-11-13T11:00:00Z", document_status: 2, net_amount: 2000, mobile: "9000000002", party_name: "B" },
  ];
  const m = mockFetch([tokenResp, { body: { Entities: rows, TotalCount: 2 } }]);
  const sales = await fetchOrnaversePosOrders(
    new Date("2026-11-10T00:00:00Z"),
    new Date("2026-11-14T00:00:00Z"),
    { backfill: false },
    m.fetch
  );
  assert.deepEqual(sales.map((s) => s.sale_id).sort(), ["po-100", "po-101"]);
});
