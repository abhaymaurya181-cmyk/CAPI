import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import {
  attributeOrders,
  channelOf,
  istDay,
  summarizeAttribution,
  summarizeConversions,
  summarizeFunnel,
  summarizeVisitorAttribution,
  type AttributionClicks,
} from "../src/lib/analytics.js";
import { parseIstSaleRange } from "../src/routes/admin-api.js";
import type { ConversionLog } from "../src/lib/firestore.js";

const at = (iso: string) => Timestamp.fromDate(new Date(iso));

function log(over: Partial<ConversionLog>): ConversionLog {
  return {
    source: "ornaverse_offline",
    order_id: "1",
    order_amount: 1000,
    currency: "INR",
    event_time: at("2026-11-10T06:00:00Z"),
    action_source: "physical_store",
    created_at: at("2026-11-10T06:05:00Z"),
    updated_at: at("2026-11-10T06:05:00Z"),
    ...over,
  } as ConversionLog;
}

const rows: ConversionLog[] = [
  log({
    order_id: "a", order_amount: 50000, store_name: "Borivali",
    match: { matched_by: "phone", click_mode: "last" }, gclid: "G1",
    google_ads: { status: "success", retries: 1 },
  }),
  log({
    order_id: "b", order_amount: 20000, store_name: "Borivali",
    match: { matched_by: "email", click_mode: "last" }, fbc: "fb.1.x",
    google_ads: { status: "failed", retries: 6 },
  }),
  log({
    order_id: "c", order_amount: 10000.5, store_name: "Delhi",
    event_time: at("2026-11-09T20:00:00Z"), // 10 Nov 01:30 IST
    match: { matched_by: null, click_mode: "last" },
  }),
  log({
    order_id: "d", order_amount: 7000, action_source: "website",
    event_time: at("2026-11-08T10:00:00Z"),
  }),
];

test("summarizeConversions: totals, rates and status counts", () => {
  const s = summarizeConversions(rows);
  assert.equal(s.totals.orders, 4);
  assert.equal(s.totals.value, 87000.5);
  assert.equal(s.totals.matched, 2);
  assert.equal(s.totals.with_click, 2);
  assert.equal(s.totals.match_rate, 0.5);
  assert.equal(s.totals.avg_order_value, 21750.13);
  assert.deepEqual(s.matched_by, { phone: 1, email: 1, none: 2 });
  assert.deepEqual(s.ad_click, { google: 1, meta: 1, none: 2 });
  assert.equal(s.google.success, 1);
  assert.equal(s.google.failed, 1);
  assert.equal(s.google.none, 2);
  assert.deepEqual(s.channel, { offline: 3, online: 1 });
});

test("summarizeConversions: by store (highest value first) and by IST day (newest first)", () => {
  const s = summarizeConversions(rows);
  assert.deepEqual(s.by_store.map((b) => [b.store, b.orders, b.value]), [
    ["Borivali", 2, 70000],
    ["Delhi", 1, 10000.5],
    ["(no store)", 1, 7000],
  ]);
  // "c" was sold at 01:30 IST on 10 Nov, so it counts on the 10th, not the 9th.
  assert.deepEqual(s.by_day.map((b) => [b.date, b.orders]), [
    ["2026-11-10", 3],
    ["2026-11-08", 1],
  ]);
});

test("summarizeConversions: channel and store filters; store list ignores the store filter", () => {
  assert.equal(summarizeConversions(rows, { channel: "online" }).totals.orders, 1);
  assert.equal(summarizeConversions(rows, { channel: "offline" }).totals.orders, 3);
  const borivali = summarizeConversions(rows, { store: "Borivali" });
  assert.equal(borivali.totals.orders, 2);
  assert.deepEqual(borivali.stores, ["(no store)", "Borivali", "Delhi"]);
  assert.equal(summarizeConversions([]).totals.match_rate, 0);
});

test("channelOf / istDay", () => {
  assert.equal(channelOf({ action_source: "physical_store" }), "offline");
  assert.equal(channelOf({ action_source: "website" }), "online");
  assert.equal(istDay(Date.parse("2026-11-10T18:29:00Z")), "2026-11-10");
  assert.equal(istDay(Date.parse("2026-11-10T18:31:00Z")), "2026-11-11");
});

test("parseIstSaleRange: today starts at IST midnight; custom 'to' day is included", () => {
  const now = Date.parse("2026-11-11T03:00:00Z"); // 08:30 IST
  assert.equal(parseIstSaleRange({ range: "today" }, now).from?.toISOString(), "2026-11-10T18:30:00.000Z");
  const c = parseIstSaleRange({ from: "2026-11-01", to: "2026-11-10" }, now);
  assert.equal(c.from?.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(c.to?.toISOString(), "2026-11-10T18:30:00.000Z");
  assert.deepEqual(parseIstSaleRange({ range: "all" }, now), { from: null, to: null });
  assert.equal(parseIstSaleRange({}, now).from?.getTime(), now - 30 * 24 * 3600 * 1000);
});

// Attribution — fixed timestamps for clarity (ms since epoch).
const T = { D1: 1000, D2: 2000, D3: 3000, D4: 4000 };

test("summarizeAttribution: first-click wins by earliest timestamp", () => {
  const items = [
    { log: log({}), clicks: { first_google_at: T.D1, last_google_at: T.D2, first_meta_at: T.D3, last_meta_at: T.D4 } },
    { log: log({}), clicks: { first_meta_at: T.D1, first_google_at: T.D2 } },
  ];
  const a = summarizeAttribution(items);
  assert.deepEqual(a.first_click.google, { share: 0.5, count: 1 });
  assert.deepEqual(a.first_click.meta, { share: 0.5, count: 1 });
  assert.deepEqual(a.first_click.direct, { share: 0, count: 0 });
});

test("summarizeAttribution: last-click wins by latest timestamp", () => {
  const items = [
    { log: log({}), clicks: { first_google_at: T.D1, last_google_at: T.D2, first_meta_at: T.D3, last_meta_at: T.D4 } },
    { log: log({}), clicks: { last_google_at: T.D4, last_meta_at: T.D1 } },
  ];
  const a = summarizeAttribution(items);
  assert.deepEqual(a.last_click.meta, { share: 0.5, count: 1 });
  assert.deepEqual(a.last_click.google, { share: 0.5, count: 1 });
});

test("summarizeAttribution: linear splits by unique touchpoints, same-click dedupes", () => {
  const items: Array<{ log: ReturnType<typeof log>; clicks?: AttributionClicks }> = [
    // 4 unique touches → Google gets 2/4, Meta gets 2/4.
    { log: log({}), clicks: { first_google_at: T.D1, last_google_at: T.D2, first_meta_at: T.D3, last_meta_at: T.D4 } },
    // Google first==last, no Meta → 1 Google touch only.
    { log: log({}), clicks: { first_google_at: T.D1, last_google_at: T.D1 } },
  ];
  const a = summarizeAttribution(items);
  // Order 1: g 0.5 + m 0.5. Order 2: g 1.0. Sum: g 1.5, m 0.5 over 2 orders.
  assert.deepEqual(a.linear.google, { share: 0.75, count: 1.5 });
  assert.deepEqual(a.linear.meta, { share: 0.25, count: 0.5 });
  assert.deepEqual(a.linear.direct, { share: 0, count: 0 });
});

test("summarizeAttribution: no clicks → direct for all models", () => {
  const items = [{ log: log({}), clicks: undefined }, { log: log({}), clicks: {} }];
  const a = summarizeAttribution(items);
  assert.deepEqual(a.first_click.direct, { share: 1, count: 2 });
  assert.deepEqual(a.last_click.direct, { share: 1, count: 2 });
  assert.deepEqual(a.linear.direct, { share: 1, count: 2 });
  assert.equal(a.total_orders, 2);
});

test("summarizeAttribution: channel filter applies (online vs offline)", () => {
  const items = [
    { log: log({ action_source: "website" }), clicks: { first_google_at: T.D1 } },
    { log: log({ action_source: "physical_store" }), clicks: { first_meta_at: T.D1 } },
  ];
  assert.deepEqual(summarizeAttribution(items, { channel: "online" }).first_click.google, { share: 1, count: 1 });
  assert.deepEqual(summarizeAttribution(items, { channel: "offline" }).first_click.meta, { share: 1, count: 1 });
});

test("summarizeAttribution: empty input returns zeros", () => {
  const a = summarizeAttribution([]);
  assert.equal(a.total_orders, 0);
  assert.deepEqual(a.first_click.google, { share: 0, count: 0 });
  assert.deepEqual(a.last_click.direct, { share: 0, count: 0 });
});

test("attributeOrders: per-order verdict under each model, newest first", () => {
  const items = [
    {
      log: log({ order_id: "a", event_time: at("2026-11-10T06:00:00Z") }),
      clicks: { first_google_at: T.D1, last_meta_at: T.D4 }, // G first, M last
    },
    {
      log: log({ order_id: "b", event_time: at("2026-11-09T06:00:00Z") }),
      clicks: undefined, // no clicks
    },
    {
      log: log({ order_id: "c", event_time: at("2026-11-11T06:00:00Z") }),
      clicks: { first_meta_at: T.D1, last_meta_at: T.D2 }, // pure Meta
    },
  ];
  const out = attributeOrders(items);
  // Newest first: c, a, b.
  assert.deepEqual(out.map((o) => o.order_id), ["c", "a", "b"]);
  const a_row = out.find((o) => o.order_id === "a")!;
  assert.equal(a_row.first_click, "google");
  assert.equal(a_row.last_click, "meta");
  // Linear split: 1 Google touch, 1 Meta touch → 0.5/0.5; dominant = google (tiebreak).
  assert.equal(a_row.linear, "google");
  assert.deepEqual(a_row.linear_split, { google: 0.5, meta: 0.5, direct: 0 });
  const b_row = out.find((o) => o.order_id === "b")!;
  assert.equal(b_row.first_click, "direct");
  assert.equal(b_row.last_click, "direct");
  assert.equal(b_row.linear, "direct");
  const c_row = out.find((o) => o.order_id === "c")!;
  assert.equal(c_row.first_click, "meta");
  assert.equal(c_row.last_click, "meta");
  assert.equal(c_row.linear, "meta");
});

test("summarizeVisitorAttribution: counts visitors, not orders; no click-window filter", () => {
  const visitors = [
    { clicks: { first_google_at: T.D1 } },                      // Google only
    { clicks: { first_meta_at: T.D2 } },                        // Meta only
    { clicks: { first_google_at: T.D1, last_meta_at: T.D4 } },  // Both — G first, M last
    { clicks: undefined },                                      // Direct
  ];
  const a = summarizeVisitorAttribution(visitors);
  assert.equal(a.total_visitors, 4);
  // First click: G=2 (visitors 1 & 3), M=1 (visitor 2), Direct=1 (visitor 4).
  assert.deepEqual(a.first_click.google, { share: 0.5, count: 2 });
  assert.deepEqual(a.first_click.meta, { share: 0.25, count: 1 });
  assert.deepEqual(a.first_click.direct, { share: 0.25, count: 1 });
  // Last click: G=1 (visitor 1), M=2 (visitors 2 & 3), Direct=1.
  assert.deepEqual(a.last_click.google, { share: 0.25, count: 1 });
  assert.deepEqual(a.last_click.meta, { share: 0.5, count: 2 });
  assert.deepEqual(a.last_click.direct, { share: 0.25, count: 1 });
});

test("summarizeVisitorAttribution: empty input returns zeros", () => {
  const a = summarizeVisitorAttribution([]);
  assert.equal(a.total_visitors, 0);
  assert.deepEqual(a.first_click.google, { share: 0, count: 0 });
});

const day = (iso: string) => Date.parse(iso + "T12:00:00Z");

test("summarizeFunnel: strict order — store visit before first_seen is NOT counted", () => {
  const visitors = [{ key: "v1", first_seen_ms: day("2026-11-01") }];
  // Store visit happened BEFORE first_seen — must be ignored.
  const conversions = [
    {
      log: log({ event_type: "store_visit" }),
      event_ms: day("2026-10-15"),
      visitor_key: "v1",
    },
  ];
  const f = summarizeFunnel(visitors, conversions);
  assert.equal(f.visitors.count, 1);
  assert.equal(f.store_visits.count, 0);
  assert.equal(f.buyers.count, 0);
});

test("summarizeFunnel: full journey — visitor → store → buy, dates tracked", () => {
  const visitors = [{ key: "v1", first_seen_ms: day("2026-10-01") }];
  const conversions = [
    { log: log({ event_type: "store_visit" }), event_ms: day("2026-10-05"), visitor_key: "v1" },
    {
      log: log({
        event_type: "purchase",
        order_amount: 50000,
        store_name: "Borivali",
        items: [{ type_name: "Rings", metal_name: "Gold", karat_name: "18KT", pieces: 1, amount: 50000 }],
      }),
      event_ms: day("2026-10-20"),
      visitor_key: "v1",
    },
  ];
  const f = summarizeFunnel(visitors, conversions);
  assert.equal(f.visitors.count, 1);
  assert.equal(f.store_visits.count, 1);
  assert.equal(f.buyers.count, 1);
  assert.equal(f.buyers.rate_from_prev, 1);
  assert.equal(f.buyers.rate_from_top, 1);
  assert.equal(f.buyers_detail.length, 1);
  assert.equal(f.buyers_detail[0].days_visitor_to_store, 4);
  assert.equal(f.buyers_detail[0].days_store_to_buy, 15);
  assert.equal(f.buyers_detail[0].store, "Borivali");
  assert.equal(f.buyers_detail[0].items[0].type_name, "Rings");
  assert.equal(f.avg_days_visitor_to_store, 4);
  assert.equal(f.avg_days_store_to_buy, 15);
});

test("summarizeFunnel: buyer with NO store visit is excluded from strict funnel", () => {
  const visitors = [{ key: "v1", first_seen_ms: day("2026-10-01") }];
  const conversions = [
    // Pure online purchase, no store visit — strict funnel drops it at stage 2.
    { log: log({ event_type: "purchase" }), event_ms: day("2026-10-10"), visitor_key: "v1" },
  ];
  const f = summarizeFunnel(visitors, conversions);
  assert.equal(f.visitors.count, 1);
  assert.equal(f.store_visits.count, 0);
  assert.equal(f.buyers.count, 0);
});

test("summarizeFunnel: multi-visitor rates", () => {
  const visitors = [
    { key: "a", first_seen_ms: day("2026-10-01") },
    { key: "b", first_seen_ms: day("2026-10-01") },
    { key: "c", first_seen_ms: day("2026-10-01") },
    { key: "d", first_seen_ms: day("2026-10-01") },
  ];
  const conversions = [
    { log: log({ event_type: "store_visit" }), event_ms: day("2026-10-05"), visitor_key: "a" },
    { log: log({ event_type: "store_visit" }), event_ms: day("2026-10-05"), visitor_key: "b" },
    { log: log({ event_type: "purchase" }), event_ms: day("2026-10-10"), visitor_key: "a" },
  ];
  const f = summarizeFunnel(visitors, conversions);
  assert.equal(f.visitors.count, 4);
  assert.equal(f.store_visits.count, 2); // a and b
  assert.equal(f.buyers.count, 1); // only a
  assert.equal(f.store_visits.rate_from_top, 0.5);
  assert.equal(f.buyers.rate_from_prev, 0.5);
  assert.equal(f.buyers.rate_from_top, 0.25);
});

test("attributeOrders: respects channel and store filters", () => {
  const items: Array<{ log: ReturnType<typeof log>; clicks?: AttributionClicks }> = [
    { log: log({ order_id: "web", action_source: "website" }), clicks: { first_google_at: T.D1 } },
    { log: log({ order_id: "store", action_source: "physical_store", store_name: "Delhi" }), clicks: { first_meta_at: T.D1 } },
  ];
  assert.deepEqual(attributeOrders(items, { channel: "online" }).map((o) => o.order_id), ["web"]);
  assert.deepEqual(attributeOrders(items, { store: "Delhi" }).map((o) => o.order_id), ["store"]);
});
