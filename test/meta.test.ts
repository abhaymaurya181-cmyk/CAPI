import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { buildMetaPayload, metaPreflightError } from "../src/senders/meta.js";
import type { ConversionLog } from "../src/lib/firestore.js";

const NOW = 1_760_000_000_000;
const DAY = 24 * 3600 * 1000;

function log(over: Partial<ConversionLog> = {}): ConversionLog {
  return {
    source: "csv_upload",
    order_id: "S-1001",
    order_amount: 45999,
    currency: "inr",
    event_time: Timestamp.fromMillis(NOW - DAY),
    phone_meta: "ph",
    email_hash: "em",
    dob_hash: "db",
    gender_hash: "ge",
    external_id: "ext",
    fbc: "fb.1.1759000000000.F1",
    action_source: "physical_store",
    created_at: Timestamp.fromMillis(NOW),
    updated_at: Timestamp.fromMillis(NOW),
    ...over,
  };
}

test("payload: physical_store Purchase with order_id as event_id", () => {
  const p = buildMetaPayload(log());
  const e = p.data[0];
  assert.equal(e.event_name, "Purchase");
  assert.equal(e.action_source, "physical_store");
  assert.equal(e.event_id, "S-1001");
  assert.equal(e.event_time, Math.floor((NOW - DAY) / 1000));
  assert.deepEqual(e.custom_data, { currency: "INR", value: 45999, order_id: "S-1001" });
  assert.equal("test_event_code" in p, false);
});

test("payload: user_data arrays for hashes, plain strings for fbc/fbp/ip/ua", () => {
  const ud = buildMetaPayload(log({ fbp: "fb.1.1.2", client_ip_address: "1.2.3.4" })).data[0].user_data;
  assert.deepEqual(ud.em, ["em"]);
  assert.deepEqual(ud.ph, ["ph"]);
  assert.deepEqual(ud.db, ["db"]);
  assert.deepEqual(ud.ge, ["ge"]);
  assert.deepEqual(ud.external_id, ["ext"]);
  assert.equal(ud.fbc, "fb.1.1759000000000.F1");
  assert.equal(ud.fbp, "fb.1.1.2");
  assert.equal(ud.client_ip_address, "1.2.3.4");
  assert.equal("fn" in ud, false, "missing fields are left out, not null");
});

test("payload: test_event_code only when given", () => {
  assert.equal(buildMetaPayload(log(), "TEST123").test_event_code, "TEST123");
});

test("preflight: time window per action_source", () => {
  assert.equal(metaPreflightError(log(), NOW), null);
  assert.equal(metaPreflightError(log({ event_time: Timestamp.fromMillis(NOW - 61 * DAY) }), NOW), null);
  assert.equal(metaPreflightError(log({ event_time: Timestamp.fromMillis(NOW - 63 * DAY) }), NOW), "event_too_old");
  assert.equal(
    metaPreflightError(log({ action_source: "website", event_time: Timestamp.fromMillis(NOW - 8 * DAY) }), NOW),
    "event_too_old"
  );
  assert.equal(metaPreflightError(log({ event_time: Timestamp.fromMillis(NOW + DAY) }), NOW), "event_time_in_future");
});

test("preflight: needs at least one match key", () => {
  const bare = log({ phone_meta: null, email_hash: null, external_id: undefined, fbc: undefined });
  assert.equal(metaPreflightError(bare, NOW), "no_match_keys");
});
