import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetTokenCache,
  fetchOrnaverseSales,
  fetchOrnaverseSalesDetailed,
  getOrnaverseToken,
  joinPhone,
  mapInvoiceRow,
  parseOrnaverseDate,
  parseTransactionId,
  postedStatuses,
  retrieveOrnaverseSale,
  splitPartyName,
  type InvoiceRow,
} from "../src/importers/ornaverse.js";

/** Build a tiny stand-in for fetch that returns the queued responses in order. */
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
  process.env.ORNAVERSE_CLIENT_SECRET = "sec";
  delete process.env.ORNAVERSE_POSTED_STATUSES;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIG)) delete process.env[k];
  Object.assign(process.env, ORIG);
});

// ---------- small units ----------

test("splitPartyName: single-word, two-word, three-word, empty", () => {
  assert.deepEqual(splitPartyName("Abhay"), { first: "Abhay" });
  assert.deepEqual(splitPartyName("Abhay Maurya"), { first: "Abhay", last: "Maurya" });
  assert.deepEqual(splitPartyName("Rohan Kumar Sharma"), { first: "Rohan Kumar", last: "Sharma" });
  assert.deepEqual(splitPartyName(""), {});
  assert.deepEqual(splitPartyName("   "), {});
});

test("joinPhone: adds + and country code; strips non-digits", () => {
  assert.equal(joinPhone("91", "9988007700"), "+919988007700");
  assert.equal(joinPhone("+91", "99880-07700"), "+919988007700");
  assert.equal(joinPhone(undefined, "9988007700"), "9988007700");
  assert.equal(joinPhone("91", undefined), undefined);
  assert.equal(joinPhone("91", "   "), undefined);
});

test("parseOrnaverseDate: naive IST, explicit offset, invalid", () => {
  // 2026-10-24T10:00:00 IST = 04:30 UTC
  assert.equal(parseOrnaverseDate("2026-10-24T10:00:00"), Date.parse("2026-10-24T04:30:00Z"));
  assert.equal(parseOrnaverseDate("2026-10-24T10:00:00Z"), Date.parse("2026-10-24T10:00:00Z"));
  assert.equal(parseOrnaverseDate("2026-10-24T10:00:00+05:30"), Date.parse("2026-10-24T04:30:00Z"));
  assert.equal(parseOrnaverseDate(""), null);
  assert.equal(parseOrnaverseDate(undefined), null);
  assert.equal(parseOrnaverseDate("garbage"), null);
});

test("mapInvoiceRow: happy path", () => {
  const row: InvoiceRow = {
    transaction_id: 12345,
    document_no: "LUC-0001",
    document_date: "2026-10-24T10:00:00",
    document_status: 2,
    net_amount: 49999,
    phone_code: "91",
    mobile: "9988007700",
    email: "priya@gmail.com",
    party_name: "Priya Sharma",
    shipping_city: "Mumbai",
    shipping_state: "MH",
    shipping_pin_code: "400001",
    mailing_name: "Lucira Pune",
  };
  const sale = mapInvoiceRow(row);
  assert.ok(sale);
  assert.equal(sale!.sale_id, "12345");
  assert.equal(sale!.amount, 49999);
  assert.equal(sale!.currency, "INR");
  assert.equal(sale!.phone, "+919988007700");
  assert.equal(sale!.email, "priya@gmail.com");
  assert.equal(sale!.first_name, "Priya");
  assert.equal(sale!.last_name, "Sharma");
  assert.equal(sale!.city, "Mumbai");
  assert.equal(sale!.state, "MH");
  assert.equal(sale!.zip, "400001");
  assert.equal(sale!.country, "IN");
  assert.equal(sale!.store_name, "Lucira Pune");
  assert.equal(sale!.event_time.toISOString(), "2026-10-24T04:30:00.000Z");
});

test("mapInvoiceRow: missing transaction_id or document_date → null", () => {
  assert.equal(mapInvoiceRow({ transaction_id: 1 }), null); // no date
  assert.equal(mapInvoiceRow({ document_date: "2026-10-24T10:00:00" }), null); // no id
});

// ---------- token caching ----------

test("getOrnaverseToken: caches token until near expiry", async () => {
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok-1", expires_in: 3600 } },
  ]);
  const t1 = await getOrnaverseToken(f);
  const t2 = await getOrnaverseToken(f); // same cached value
  assert.equal(t1, "tok-1");
  assert.equal(t2, "tok-1");
  assert.equal(calls.length, 1, "token should be fetched only once");
});

test("getOrnaverseToken: refreshes when near expiry", async () => {
  const { fetch: f } = mockFetch([
    { body: { access_token: "tok-1", expires_in: 30 } }, // < 60s skew window
    { body: { access_token: "tok-2", expires_in: 3600 } },
  ]);
  const t1 = await getOrnaverseToken(f);
  const t2 = await getOrnaverseToken(f);
  assert.equal(t1, "tok-1");
  assert.equal(t2, "tok-2");
});

test("getOrnaverseToken: non-200 throws", async () => {
  const { fetch: f } = mockFetch([{ status: 401, body: { error: "invalid_client" } }]);
  await assert.rejects(getOrnaverseToken(f), /ornaverse_token_failed:401/);
});

test("getOrnaverseToken: sends scope (default openid, env override wins)", async () => {
  // Default scope
  {
    const { fetch: f, calls } = mockFetch([{ body: { access_token: "t", expires_in: 3600 } }]);
    await getOrnaverseToken(f);
    const body = calls[0].init?.body as string;
    assert.match(body, /scope=openid/);
    assert.match(body, /grant_type=client_credentials/);
  }
  // Overridden scope
  _resetTokenCache();
  process.env.ORNAVERSE_SCOPE = "custom.scope";
  {
    const { fetch: f, calls } = mockFetch([{ body: { access_token: "t", expires_in: 3600 } }]);
    await getOrnaverseToken(f);
    const body = calls[0].init?.body as string;
    assert.match(body, /scope=custom\.scope/);
  }
  delete process.env.ORNAVERSE_SCOPE;
});

// ---------- pagination ----------

test("fetchOrnaverseSales: single page, filters out rows outside window", async () => {
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-10-24T12:00:00Z");
  const { fetch: f } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    {
      body: {
        Entities: [
          { transaction_id: 1, document_status: 1, document_date: "2026-10-24T10:00:00Z", modification_date: "2026-10-24T10:00:00Z", net_amount: 100, mobile: "9988001001", phone_code: "91" }, // in window
          { transaction_id: 2, document_status: 1, document_date: "2026-10-23T10:00:00Z", modification_date: "2026-10-23T10:00:00Z", net_amount: 200 }, // before from
          { transaction_id: 3, document_status: 1, document_date: "2026-10-24T15:00:00Z", modification_date: "2026-10-24T15:00:00Z", net_amount: 300 }, // after to
        ],
        TotalCount: 3,
      },
    },
  ]);
  const sales = await fetchOrnaverseSales(from, to, f);
  // Row 2's modification_date is before `from`, which triggers the early-stop
  // after processing this page. Rows 1 and 3 are checked individually.
  assert.equal(sales.length, 1);
  assert.equal(sales[0].sale_id, "1");
});

test("fetchOrnaverseSales: stops paging when a page's oldest row predates from", async () => {
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-10-24T12:00:00Z");
  // Page 1 has one row older than `from` — must stop, must NOT fetch page 2.
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    {
      body: {
        Entities: [
          { transaction_id: 101, document_status: 1, document_date: "2026-10-24T11:00:00Z", modification_date: "2026-10-24T11:00:00Z", net_amount: 500 },
          { transaction_id: 102, document_status: 1, document_date: "2026-10-23T22:00:00Z", modification_date: "2026-10-23T22:00:00Z", net_amount: 500 },
        ],
        TotalCount: 999, // pretend lots more exist
      },
    },
  ]);
  const sales = await fetchOrnaverseSales(from, to, f);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].sale_id, "101");
  // 2 calls total: token + 1 page. No second page.
  assert.equal(calls.length, 2);
});

test("fetchOrnaverseSales: paginates when every page is in-window and full", async () => {
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-10-24T23:59:59Z");
  // Build a page of exactly 100 rows all in-window.
  const page = (startId: number, modStartMs: number) => ({
    Entities: Array.from({ length: 100 }, (_, i) => ({
      transaction_id: startId + i,
      document_status: 1,
      document_date: "2026-10-24T10:00:00Z",
      modification_date: new Date(modStartMs - i * 1000).toISOString(),
      net_amount: 10,
    })),
    TotalCount: 250,
  });
  const t0 = Date.parse("2026-10-24T20:00:00Z");
  const t1 = Date.parse("2026-10-24T12:00:00Z");
  const t2 = Date.parse("2026-10-24T05:00:00Z");
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    { body: page(1, t0) },     // oldest ~20:00 Z — still > from, keep going
    { body: page(101, t1) },   // oldest ~12:00 Z — still > from
    { body: page(201, t2) },   // oldest ~05:00 Z — still > from (but short page would stop)
    { body: { Entities: [] } }, // empty = stop
  ]);
  const sales = await fetchOrnaverseSales(from, to, f);
  assert.equal(sales.length, 300);
  assert.equal(calls.length, 5); // token + 4 list calls
});

test("fetchOrnaverseSales: ORNAVERSE_POSTED_STATUSES drops rows with other statuses", async () => {
  process.env.ORNAVERSE_POSTED_STATUSES = "2,3";
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-10-25T00:00:00Z");
  const { fetch: f } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    {
      body: {
        Entities: [
          { transaction_id: 10, document_date: "2026-10-24T10:00:00Z", modification_date: "2026-10-24T10:00:00Z", net_amount: 100, document_status: 2 }, // keep
          { transaction_id: 11, document_date: "2026-10-24T11:00:00Z", modification_date: "2026-10-24T11:00:00Z", net_amount: 200, document_status: 1 }, // drop
          { transaction_id: 12, document_date: "2026-10-24T12:00:00Z", modification_date: "2026-10-24T12:00:00Z", net_amount: 300, document_status: 3 }, // keep
        ],
        TotalCount: 3,
      },
    },
  ]);
  const sales = await fetchOrnaverseSales(from, to, f);
  const ids = sales.map((s) => s.sale_id).sort();
  assert.deepEqual(ids, ["10", "12"]);
});

test("fetchOrnaverseSales: not configured → throws", async () => {
  delete process.env.ORNAVERSE_CLIENT_ID;
  await assert.rejects(
    fetchOrnaverseSales(new Date(), new Date()),
    /ornaverse_not_configured/
  );
});

test("fetchOrnaverseSales: list body never includes Sort (triggers 500 on OrnaVerse)", async () => {
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-10-25T00:00:00Z");
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    { body: { Entities: [], TotalCount: 0 } },
  ]);
  await fetchOrnaverseSales(from, to, f);
  const listCall = calls[1];
  assert.ok(listCall.init?.body, "list body must be present");
  const body = JSON.parse(String(listCall.init!.body));
  assert.equal(body.Sort, undefined, "Sort must be omitted — any Sort clause 500s");
});

test("fetchOrnaverseSales: ORNAVERSE_POSTED_STATUSES=1 sends EqualityFilter as scalar", async () => {
  process.env.ORNAVERSE_POSTED_STATUSES = "1";
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    { body: { Entities: [], TotalCount: 0 } },
  ]);
  await fetchOrnaverseSales(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-25T00:00:00Z"), f);
  const body = JSON.parse(String(calls[1].init!.body));
  assert.deepEqual(body.EqualityFilter, { document_status: 1 });
});

test("fetchOrnaverseSales: ORNAVERSE_POSTED_STATUSES=1,2 sends EqualityFilter as array (IN)", async () => {
  process.env.ORNAVERSE_POSTED_STATUSES = "1,2";
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    { body: { Entities: [], TotalCount: 0 } },
  ]);
  await fetchOrnaverseSales(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-25T00:00:00Z"), f);
  const body = JSON.parse(String(calls[1].init!.body));
  assert.deepEqual(body.EqualityFilter, { document_status: [1, 2] });
});

test("fetchOrnaverseSales: no POSTED_STATUSES → defaults to posted only (1), never everything", async () => {
  const { fetch: f, calls } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    { body: { Entities: [], TotalCount: 0 } },
  ]);
  await fetchOrnaverseSales(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-25T00:00:00Z"), f);
  const body = JSON.parse(String(calls[1].init!.body));
  assert.deepEqual(body.EqualityFilter, { document_status: 1 });
});

test("postedStatuses: unset / empty / junk → [1]; stray commas and junk never add 0 or NaN", () => {
  for (const raw of [undefined, "", "  ", "abc", ",", "1.5", "-1"]) {
    if (raw === undefined) delete process.env.ORNAVERSE_POSTED_STATUSES;
    else process.env.ORNAVERSE_POSTED_STATUSES = raw;
    assert.deepEqual([...postedStatuses()], [1], String(raw));
  }
  process.env.ORNAVERSE_POSTED_STATUSES = "1,";
  assert.deepEqual([...postedStatuses()], [1]);
  process.env.ORNAVERSE_POSTED_STATUSES = " 1 , x, 2 ";
  assert.deepEqual([...postedStatuses()], [1, 2]);
});

test("fetchOrnaverseSales: returns (status 2) and rows without a status are never imported by default", async () => {
  const { fetch: f } = mockFetch([
    { body: { access_token: "tok", expires_in: 3600 } },
    {
      body: {
        Entities: [
          { transaction_id: 20, document_status: 1, document_date: "2026-10-24T10:00:00Z", net_amount: 100 }, // keep
          { transaction_id: 21, document_status: 2, document_date: "2026-10-24T10:30:00Z", net_amount: 100 }, // return → drop
          { transaction_id: 22, document_date: "2026-10-24T11:00:00Z", net_amount: 100 }, // no status → drop
        ],
        TotalCount: 3,
      },
    },
  ]);
  const sales = await fetchOrnaverseSales(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-25T00:00:00Z"), f);
  assert.deepEqual(sales.map((s) => s.sale_id), ["20"]);
});

// ---------- single bill (Retrieve) ----------

const TOKEN = { body: { access_token: "tok", expires_in: 3600 } };

/** Fresh login per call: the token cache would otherwise eat the queued TOKEN response. */
function billFetch(resp: { status?: number; body: unknown }) {
  _resetTokenCache();
  return mockFetch([TOKEN, resp]).fetch;
}
const POSTED_BILL = {
  transaction_id: 777,
  document_status: 1,
  document_date: "2026-10-24T10:00:00",
  net_amount: 52000,
  phone_code: "91",
  mobile: "9876543210",
  party_name: "Test Customer",
};

test("parseTransactionId: accepts positive integers, rejects everything else", () => {
  assert.equal(parseTransactionId(777), 777);
  assert.equal(parseTransactionId(" 777 "), 777);
  for (const bad of [0, -1, 1.5, "1e3", "0777", "abc", "", null, undefined, {}, [], "99999999999999999"]) {
    assert.equal(parseTransactionId(bad), null, JSON.stringify(bad));
  }
});

test("retrieveOrnaverseSale: posted bill → sale; sends { EntityId } read-only", async () => {
  const { fetch: f, calls } = mockFetch([TOKEN, { body: { Entity: POSTED_BILL } }]);
  const out = await retrieveOrnaverseSale("777", f);
  assert.equal(out.kind, "sale");
  assert.equal(out.kind === "sale" && out.sale.sale_id, "777");
  assert.match(calls[1].url, /\/Services\/POS\/Invoice\/Retrieve$/);
  assert.deepEqual(JSON.parse(String(calls[1].init!.body)), { EntityId: 777 });
  assert.ok(calls[1].init!.signal, "request must have a timeout");
});

test("retrieveOrnaverseSale: return / unposted / no-status bills are skipped, not sent", async () => {
  for (const status of [2, 0, undefined]) {
    const f = billFetch({ body: { Entity: { ...POSTED_BILL, document_status: status } } });
    const out = await retrieveOrnaverseSale(777, f);
    assert.deepEqual(out, { kind: "skipped", reason: "status_not_posted", document_status: status });
  }
});

test("retrieveOrnaverseSale: not found (404, empty Entity, NotFound error) → skipped", async () => {
  for (const resp of [
    { status: 404, body: {} },
    { body: {} },
    { body: { Error: { Code: "RecordNotFound", Message: "Record not found" } } },
  ]) {
    assert.deepEqual(await retrieveOrnaverseSale(777, billFetch(resp)), { kind: "skipped", reason: "not_found" });
  }
});

test("retrieveOrnaverseSale: a different bill coming back is never used", async () => {
  const { fetch: f } = mockFetch([TOKEN, { body: { Entity: { ...POSTED_BILL, transaction_id: 778 } } }]);
  assert.deepEqual(await retrieveOrnaverseSale(777, f), { kind: "skipped", reason: "id_mismatch" });
});

test("retrieveOrnaverseSale: 401 → fresh token and one retry", async () => {
  const { fetch: f, calls } = mockFetch([
    TOKEN,
    { status: 401, body: {} },
    { body: { access_token: "tok2", expires_in: 3600 } },
    { body: { Entity: POSTED_BILL } },
  ]);
  const out = await retrieveOrnaverseSale(777, f);
  assert.equal(out.kind, "sale");
  assert.equal(calls.length, 4);
  assert.equal((calls[3].init!.headers as Record<string, string>).Authorization, "Bearer tok2");
});

test("retrieveOrnaverseSale: bad id, server errors and other API errors throw (caller retries)", async () => {
  await assert.rejects(retrieveOrnaverseSale("abc", mockFetch([]).fetch), /ornaverse_bad_transaction_id/);
  await assert.rejects(
    retrieveOrnaverseSale(777, billFetch({ status: 500, body: {} })),
    /ornaverse_retrieve_failed:500/
  );
  await assert.rejects(
    retrieveOrnaverseSale(777, billFetch({ body: { Error: { Code: "AccessDenied" } } })),
    /ornaverse_retrieve_error:AccessDenied/
  );
  delete process.env.ORNAVERSE_CLIENT_SECRET;
  await assert.rejects(retrieveOrnaverseSale(777, mockFetch([]).fetch), /ornaverse_not_configured/);
});

// ---------- page-limit signal (used by the daily re-scan) ----------

test("fetchOrnaverseSalesDetailed: capped only when every page is full and still in the window", async () => {
  const from = new Date("2026-10-01T00:00:00Z");
  const to = new Date("2026-10-25T00:00:00Z");
  const fullPage = (start: number) => ({
    body: {
      Entities: Array.from({ length: 100 }, (_, i) => ({
        transaction_id: start + i,
        document_status: 1,
        document_date: "2026-10-20T10:00:00Z",
        net_amount: 10,
      })),
    },
  });
  // 50 full in-window pages = the safety limit → capped.
  _resetTokenCache();
  const many = mockFetch([TOKEN, ...Array.from({ length: 50 }, (_, p) => fullPage(p * 100 + 1))]);
  const capped = await fetchOrnaverseSalesDetailed(from, to, many.fetch);
  assert.equal(capped.capped, true);
  assert.equal(capped.sales.length, 5000);

  // Empty page, short page, or reaching `from` → not capped.
  for (const last of [{ body: { Entities: [] } }, { body: { Entities: fullPage(9001).body.Entities.slice(0, 3) } }]) {
    _resetTokenCache();
    const r = await fetchOrnaverseSalesDetailed(from, to, mockFetch([TOKEN, fullPage(1), last]).fetch);
    assert.equal(r.capped, false);
  }
  _resetTokenCache();
  const old = { body: { Entities: [{ transaction_id: 5, document_status: 1, document_date: "2026-09-01T10:00:00Z" }] } };
  assert.equal((await fetchOrnaverseSalesDetailed(from, to, mockFetch([TOKEN, old]).fetch)).capped, false);
});
