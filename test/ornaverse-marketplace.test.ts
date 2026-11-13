import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _resetTokenCache } from "../src/importers/ornaverse.js";
import {
  fetchMarketplaceInvoicePage,
  fetchOrnaverseMarketplaceSales,
  mapMarketplaceRow,
  type MarketPlaceInvoiceRow,
} from "../src/importers/ornaverse-marketplace.js";

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

test("mapMarketplaceRow: prefixes sale_id with 'mp-' and uses company_code in store_name", () => {
  const row: MarketPlaceInvoiceRow = {
    transaction_id: 391,
    document_date: "2026-11-13T12:26:32.602Z",
    document_status: 1,
    net_amount: 15060.35,
    phone_code: "91",
    mobile: "9876543210",
    party_name: "Ravi Kumar",
    shipping_pin_code: "400001",
    shipping_city: "Mumbai",
    shipping_state: "Maharashtra",
    company_code: "N18",
  };
  const sale = mapMarketplaceRow(row);
  assert.equal(sale?.sale_id, "mp-391");
  assert.equal(sale?.amount, 15060.35);
  assert.equal(sale?.currency, "INR");
  assert.equal(sale?.phone, "+919876543210");
  assert.equal(sale?.first_name, "Ravi");
  assert.equal(sale?.last_name, "Kumar");
  assert.equal(sale?.zip, "400001");
  assert.equal(sale?.store_name, "Online (N18)");
});

test("mapMarketplaceRow: falls back to billing_* when no shipping_* and 'Online' when no company_code", () => {
  const row: MarketPlaceInvoiceRow = {
    transaction_id: 392,
    document_date: "2026-11-13T12:00:00Z",
    document_status: 1,
    net_amount: 10000,
    billing_pin_code: "560001",
    billing_city: "Bengaluru",
    billing_state: "Karnataka",
    mobile: "9000000001",
  };
  const sale = mapMarketplaceRow(row);
  assert.equal(sale?.zip, "560001");
  assert.equal(sale?.city, "Bengaluru");
  assert.equal(sale?.store_name, "Online");
});

test("mapMarketplaceRow: rejects ₹0 and missing fields", () => {
  assert.equal(mapMarketplaceRow({ transaction_id: 1, document_date: "2026-11-13", document_status: 1, net_amount: 0 }), null);
  assert.equal(mapMarketplaceRow({ transaction_id: 1, document_status: 1, net_amount: 100 }), null); // no date
  assert.equal(mapMarketplaceRow({ document_date: "2026-11-13", document_status: 1, net_amount: 100 }), null); // no id
});

test("fetchMarketplaceInvoicePage: POSTs to MarketPlace/Invoice/List with the body", async () => {
  const m = mockFetch([{ body: { Entities: [], TotalCount: 0 } }]);
  await fetchMarketplaceInvoicePage("tok", { Skip: 0, Take: 10 }, m.fetch);
  assert.equal(m.calls[0].url, "https://test.ornaverse.in/Services/MarketPlace/Invoice/List");
  assert.equal((m.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("fetchOrnaverseMarketplaceSales: filters by posted status and document_date window", async () => {
  const rows: MarketPlaceInvoiceRow[] = [
    { transaction_id: 3, document_date: "2026-11-13T10:00:00Z", document_status: 1, net_amount: 1000, mobile: "9000000001", party_name: "A" },
    { transaction_id: 2, document_date: "2026-11-12T10:00:00Z", document_status: 2, net_amount: 500, mobile: "9000000002", party_name: "B" }, // not posted
    { transaction_id: 1, document_date: "2026-11-05T10:00:00Z", document_status: 1, net_amount: 2000, mobile: "9000000003", party_name: "C" }, // outside window
  ];
  const m = mockFetch([tokenResp, { body: { Entities: rows, TotalCount: 3 } }]);
  const sales = await fetchOrnaverseMarketplaceSales(
    new Date("2026-11-10T00:00:00Z"),
    new Date("2026-11-14T00:00:00Z"),
    m.fetch
  );
  assert.equal(sales.length, 1);
  assert.equal(sales[0].sale_id, "mp-3");
});
