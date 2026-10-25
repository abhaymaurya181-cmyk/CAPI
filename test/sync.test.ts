import { test } from "node:test";
import assert from "node:assert/strict";
import { keepNewSales, nextWindow, rescanDays } from "../src/lib/sync.js";
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
