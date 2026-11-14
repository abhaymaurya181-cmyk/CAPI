import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _resetTokenCache } from "../src/importers/ornaverse.js";
import {
  fetchMarketPlaceOrderPage,
  fetchMarketPlaceOrders,
  mapMarketPlaceOrderRow,
  type MarketPlaceOrderRow,
} from "../src/importers/ornaverse-marketplace-orders.js";

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

test("mapMarketPlaceOrderRow: tags pending_invoice:true and carries shopify_order_id", () => {
  const row: MarketPlaceOrderRow = {
    transaction_id: 999,
    document_date: "2026-11-13T12:00:00Z",
    document_status: 1,
    is_confirmed: true,
    net_amount: 15060,
    mobile: "9876543210",
    email: "customer@example.com",
    party_name: "Ravi Kumar",
    marketplace_order_id: 18994047385818,
    company_code: "BO1",
  };
  const sale = mapMarketPlaceOrderRow(row);
  assert.equal(sale?.sale_id, "mp-ord-999");
  assert.equal(sale?.pending_invoice, true);
  assert.equal(sale?.shopify_order_id, 18994047385818);
  assert.equal(sale?.store_name, "Online (BO1)");
});

test("mapMarketPlaceOrderRow: rejects ₹0 / missing id / missing date", () => {
  assert.equal(mapMarketPlaceOrderRow({ transaction_id: 1, document_date: "x", document_status: 1, net_amount: 0 }), null);
  assert.equal(mapMarketPlaceOrderRow({ document_date: "2026-11-13", document_status: 1, net_amount: 100 }), null);
  assert.equal(mapMarketPlaceOrderRow({ transaction_id: 1, document_status: 1, net_amount: 100 }), null);
});

test("fetchMarketPlaceOrderPage: POSTs to MarketPlace/Order/List", async () => {
  const m = mockFetch([{ body: { Entities: [], TotalCount: 0 } }]);
  await fetchMarketPlaceOrderPage("tok", { Skip: 0, Take: 10 }, m.fetch);
  assert.equal(m.calls[0].url, "https://test.ornaverse.in/Services/MarketPlace/Order/List");
});

test("fetchMarketPlaceOrders: keeps only is_confirmed=true orders", async () => {
  const rows: MarketPlaceOrderRow[] = [
    { transaction_id: 10, document_date: "2026-11-13T10:00:00Z", document_status: 1, is_confirmed: true, net_amount: 1000, mobile: "9000000001", marketplace_order_id: 1 },
    { transaction_id: 11, document_date: "2026-11-13T11:00:00Z", document_status: 1, is_confirmed: false, net_amount: 2000, mobile: "9000000002" }, // unconfirmed
    { transaction_id: 12, document_date: "2026-11-13T12:00:00Z", document_status: 1, is_confirmed: true, net_amount: 3000, mobile: "9000000003" },
  ];
  const m = mockFetch([tokenResp, { body: { Entities: rows, TotalCount: 3 } }]);
  const sales = await fetchMarketPlaceOrders(
    new Date("2026-11-10T00:00:00Z"),
    new Date("2026-11-14T00:00:00Z"),
    m.fetch
  );
  assert.deepEqual(sales.map((s) => s.sale_id).sort(), ["mp-ord-10", "mp-ord-12"]);
  // EqualityFilter must include is_confirmed.
  const body = JSON.parse((m.calls[1].init?.body as string) ?? "{}");
  assert.deepEqual(body.EqualityFilter, { document_status: 1, is_confirmed: true });
});
