import { test } from "node:test";
import assert from "node:assert/strict";
import { pickParentOrderId } from "../src/importers/ornaverse-pos-smart.js";

test("pickParentOrderId: returns first non-placeholder ref_transaction_id", () => {
  const items = [
    { ref_transaction_id: 1 }, // placeholder, skipped
    { ref_transaction_id: 537 },
    { ref_transaction_id: 1061 },
  ];
  assert.equal(pickParentOrderId(items), 537);
});

test("pickParentOrderId: null when all items have placeholder or missing ref", () => {
  assert.equal(pickParentOrderId([{ ref_transaction_id: 1 }, { ref_transaction_id: 0 }]), null);
  assert.equal(pickParentOrderId([{}, { ref_transaction_id: null }]), null);
  assert.equal(pickParentOrderId([]), null);
});

test("pickParentOrderId: ignores non-numeric values", () => {
  assert.equal(pickParentOrderId([{ ref_transaction_id: "537" as unknown as number }]), null);
});
