import { test } from "node:test";
import assert from "node:assert/strict";
import { hourlyLookback, keepNewSales, nextWindow, rescanDays } from "../src/lib/sync.js";
import type { SaleInput } from "../src/lib/matcher.js";

const sale = (id: string): SaleInput => ({
  sale_id: id,
  amount: 100,
  currency: "INR",
  event_time: new Date("2026-10-24T10:00:00Z"),
  phone: "9876543210",
});

test("rescanDays: default 30, whole days 1..60, junk → default", () => {
  assert.equal(rescanDays(undefined), 30);
  assert.equal(rescanDays(""), 30);
  assert.equal(rescanDays("7"), 7);
  assert.equal(rescanDays(" 45 "), 45);
  // Never past Meta's 62-day physical_store limit.
  assert.equal(rescanDays("90"), 60);
  assert.equal(rescanDays("60"), 60);
  for (const junk of ["0", "-5", "1.5", "abc", "30d"]) assert.equal(rescanDays(junk), 30, junk);
});

test("keepNewSales: drops already-recorded sales and repeats within the batch", () => {
  const out = keepNewSales([sale("1"), sale("2"), sale("3"), sale("2")], new Set(["1"]));
  assert.deepEqual(out.map((s) => s.sale_id), ["2", "3"]);
  assert.deepEqual(keepNewSales([], new Set()), []);
  assert.deepEqual(keepNewSales([sale("1")], new Set(["1"])), []);
});

test("nextWindow (hourly cursor) is unchanged by the re-scan design", () => {
  const now = Date.parse("2026-10-25T10:00:00Z");
  const w = nextWindow({ last_window_to: undefined }, now, 7);
  assert.equal(w.to.getTime(), now);
  assert.equal(now - w.from.getTime(), 7 * 24 * 3600 * 1000);
});

test("nextWindow: hourly pull re-reads the last N days (backdated bills), keeps the 1h overlap if older", () => {
  const DAY = 24 * 3600 * 1000;
  const now = Date.parse("2026-10-27T10:00:00Z");
  const lastHour = { last_window_to: { toMillis: () => now - 3600_000 } } as never;
  assert.equal(nextWindow(lastHour, now, 7, 3).from.getTime(), now - 3 * DAY);
  assert.equal(nextWindow(lastHour, now, 7, 0).from.getTime(), now - 2 * 3600_000);
  // Cursor 5 days old (outage): the overlap reaches further back than the look-back.
  const old = { last_window_to: { toMillis: () => now - 5 * DAY } } as never;
  assert.equal(nextWindow(old, now, 7, 3).from.getTime(), now - 5 * DAY - 3600_000);
});

test("hourlyLookback: default 3, whole days 0..7, junk → default", () => {
  assert.equal(hourlyLookback(undefined), 3);
  assert.equal(hourlyLookback("0"), 0);
  assert.equal(hourlyLookback(" 2 "), 2);
  assert.equal(hourlyLookback("30"), 7);
  for (const junk of ["", "-1", "1.5", "abc"]) assert.equal(hourlyLookback(junk), 3, junk);
});
