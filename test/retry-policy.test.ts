import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, MAX_ATTEMPTS, requeueReason, toSenderResult } from "../src/senders/retry-policy.js";
import { Timestamp } from "@google-cloud/firestore";
import type { SenderResult } from "../src/lib/firestore.js";

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

// ---------- stuck sales ----------

test("toSenderResult: missing credentials don't burn attempts and don't keep retrying", () => {
  const r = toSenderResult({ ok: false, status: 0, body: "", error: "google_not_configured" }, 1, 1_000);
  assert.equal(r.status, "failed");
  assert.equal(r.retries, 0);
  assert.equal(r.next_retry_at, undefined);
});

const DAY = 24 * 3600 * 1000;
const T0 = 1_760_000_000_000;
const ctx = (over: Partial<{ eventMs: number; configured: boolean; googleLive: boolean }> = {}) => ({
  eventMs: T0 - 5 * DAY,
  nowMs: T0,
  configured: true,
  googleLive: true,
  ...over,
});
const rec = (over: Partial<SenderResult>): SenderResult => ({ status: "failed", retries: 1, ...over });

test("requeueReason: the three stuck cases come back", () => {
  assert.equal(requeueReason("meta_capi", rec({ error: "meta_not_configured", retries: 0 }), ctx()), "was_not_configured");
  assert.equal(requeueReason("google_ads", rec({ status: "validated" }), ctx()), "validated_now_live");
  assert.equal(requeueReason("meta_capi", rec({ status: "retrying" }), ctx()), "no_retry_time");
  assert.equal(requeueReason("meta_capi", rec({ status: "pending", retries: 0 }), ctx()), "no_retry_time");
  assert.equal(requeueReason("meta_capi", undefined, ctx()), "no_retry_time");
  // Old-style failure from before the retry policy, retryable, attempts left.
  assert.equal(requeueReason("meta_capi", rec({ response_code: 503, retries: 2 }), ctx()), "retryable_failure");
});

test("requeueReason: never touches what must not be sent again", () => {
  assert.equal(requeueReason("meta_capi", rec({ status: "success" }), ctx()), null);
  // Already queued.
  assert.equal(requeueReason("meta_capi", rec({ status: "retrying", next_retry_at: Timestamp.fromMillis(T0) }), ctx()), null);
  // Permanent: bad payload, no match keys, too old, attempts used up.
  assert.equal(requeueReason("meta_capi", rec({ response_code: 400 }), ctx()), null);
  assert.equal(requeueReason("meta_capi", rec({ error: "no_match_keys" }), ctx()), null);
  assert.equal(requeueReason("meta_capi", rec({ error: "event_too_old" }), ctx()), null);
  assert.equal(requeueReason("meta_capi", rec({ response_code: 503, retries: MAX_ATTEMPTS }), ctx()), null);
});

test("requeueReason: only when a send can work now", () => {
  // Credentials still missing → would just fail again.
  assert.equal(requeueReason("meta_capi", rec({ error: "meta_not_configured" }), ctx({ configured: false })), null);
  // Google still in check-only mode → validated stays validated.
  assert.equal(requeueReason("google_ads", rec({ status: "validated" }), ctx({ googleLive: false })), null);
  // Meta can't have "validated" sales.
  assert.equal(requeueReason("meta_capi", rec({ status: "validated" }), ctx()), null);
  // Too old for the platform: Meta 62 days, Google 90 days.
  assert.equal(requeueReason("meta_capi", rec({ error: "meta_not_configured" }), ctx({ eventMs: T0 - 70 * DAY })), null);
  assert.equal(requeueReason("google_ads", rec({ error: "google_not_configured" }), ctx({ eventMs: T0 - 70 * DAY })), "was_not_configured");
  assert.equal(requeueReason("google_ads", rec({ error: "google_not_configured" }), ctx({ eventMs: T0 - 95 * DAY })), null);
});
