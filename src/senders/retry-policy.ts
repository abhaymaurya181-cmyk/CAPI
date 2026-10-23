import { Timestamp } from "@google-cloud/firestore";
import type { SenderResult } from "../lib/firestore.js";
import type { SendResult } from "./types.js";

export const MAX_ATTEMPTS = 6;
// Wait before attempt 2, 3, ... (index = attempts already made - 1).
const BACKOFF_MS = [5, 15, 60, 240, 720].map((m) => m * 60 * 1000);
// A new conversion is dispatched inline; the sweep only picks it up if that
// first attempt never recorded anything.
export const FIRST_ATTEMPT_GRACE_MS = 2 * 60 * 1000;

// Our own preflight rejections: sending again cannot change the answer.
const PERMANENT_ERRORS = new Set(["no_match_keys", "event_too_old", "event_time_in_future"]);

/**
 * Whether a failed send is worth repeating. Network errors, timeouts,
 * rate limits, 5xx and missing config/auth (fixable without touching the
 * data) are retried; a 400-type rejection of the payload is not.
 */
export function isRetryable(res: SendResult): boolean {
  if (res.error && PERMANENT_ERRORS.has(res.error)) return false;
  if (res.status === 400 || res.status === 404 || res.status === 422) return false;
  return true;
}

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
}

/** Turn one send attempt into the stored per-sender record. */
export function toSenderResult(res: SendResult, attempts: number, nowMs = Date.now()): SenderResult {
  const base = {
    response_code: res.status,
    response_body: res.body ? res.body.slice(0, 2000) : undefined,
    retries: attempts,
    sent_at: Timestamp.fromMillis(nowMs),
    error: res.error,
  };
  if (res.ok) return { ...base, status: "success" };
  if (res.validated) return { ...base, status: "validated" };
  if (isRetryable(res) && attempts < MAX_ATTEMPTS) {
    return {
      ...base,
      status: "retrying",
      next_retry_at: Timestamp.fromMillis(nowMs + backoffMs(attempts)),
    };
  }
  return { ...base, status: "failed" };
}

/** Initial record for a sender on a newly written conversion. */
export function pendingSender(nowMs = Date.now()): SenderResult {
  return {
    status: "pending",
    retries: 0,
    next_retry_at: Timestamp.fromMillis(nowMs + FIRST_ATTEMPT_GRACE_MS),
  };
}
