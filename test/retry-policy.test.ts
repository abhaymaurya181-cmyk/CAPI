import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, MAX_ATTEMPTS, toSenderResult } from "../src/senders/retry-policy.js";

const NOW = 1_760_000_000_000;
const MIN = 60 * 1000;

test("success / validated: no next retry", () => {
  const ok = toSenderResult({ ok: true, status: 200, body: "{}" }, 1, NOW);
  assert.equal(ok.status, "success");
  assert.equal(ok.next_retry_at, undefined);
  const v = toSenderResult({ ok: false, validated: true, status: 200, body: "{}" }, 1, NOW);
  assert.equal(v.status, "validated");
  assert.equal(v.next_retry_at, undefined);
});

test("transient failure: retrying with growing back-off", () => {
  const r1 = toSenderResult({ ok: false, status: 503, body: "" }, 1, NOW);
  assert.equal(r1.status, "retrying");
  assert.equal(r1.next_retry_at?.toMillis(), NOW + 5 * MIN);
  const r3 = toSenderResult({ ok: false, status: 0, body: "", error: "fetch failed" }, 3, NOW);
  assert.equal(r3.next_retry_at?.toMillis(), NOW + 60 * MIN);
  const r5 = toSenderResult({ ok: false, status: 429, body: "" }, 5, NOW);
  assert.equal(r5.next_retry_at?.toMillis(), NOW + 720 * MIN);
});

test("retries used up → failed", () => {
  const r = toSenderResult({ ok: false, status: 500, body: "" }, MAX_ATTEMPTS, NOW);
  assert.equal(r.status, "failed");
  assert.equal(r.next_retry_at, undefined);
  assert.equal(r.retries, MAX_ATTEMPTS);
});

test("permanent errors are not retried", () => {
  assert.equal(isRetryable({ ok: false, status: 400, body: "" }), false);
  assert.equal(isRetryable({ ok: false, status: 0, body: "", error: "event_too_old" }), false);
  assert.equal(isRetryable({ ok: false, status: 0, body: "", error: "no_match_keys" }), false);
  assert.equal(toSenderResult({ ok: false, status: 400, body: "" }, 1, NOW).status, "failed");
  // Config / auth problems can be fixed without changing the data.
  assert.equal(isRetryable({ ok: false, status: 0, body: "", error: "meta_not_configured" }), true);
  assert.equal(isRetryable({ ok: false, status: 401, body: "" }), true);
});
