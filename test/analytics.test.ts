import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { channelOf, istDay, summarizeConversions } from "../src/lib/analytics.js";
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
