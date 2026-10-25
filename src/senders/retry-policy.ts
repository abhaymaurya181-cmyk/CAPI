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

/** "meta_not_configured" / "google_not_configured": our setup, not the sale. */
export function isNotConfigured(error?: string): boolean {
  return Boolean(error && error.endsWith("_not_configured"));
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
  // Credentials not set yet: nothing reached Meta/Google, so don't burn an
  // attempt or keep retrying. The sale waits as failed/*_not_configured and
  // requeueStuck (daily, or the admin button) puts it back once configured.
  if (isNotConfigured(res.error)) return { ...base, retries: attempts - 1, status: "failed" };
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

const DAY_MS = 24 * 3600 * 1000;
// Older than this, the platform rejects the event anyway (Meta physical_store:
// 62 days; Google click conversions: 90-day click window), so requeueing is pointless.
export const MAX_SEND_AGE_MS = { meta_capi: 62 * DAY_MS, google_ads: 90 * DAY_MS } as const;

export type RequeueReason =
  | "no_retry_time" // pending/retrying record from before the retry system
  | "was_not_configured" // failed only because credentials were missing
  | "validated_now_live" // passed Google's check-only mode; now live
  | "retryable_failure"; // failed with a retryable error, attempts left

/**
 * Whether a stuck sender should go back in the queue, and why. Only when a
 * send can actually work now: credentials present, Google live for validated
 * ones, not too old for the platform. Never touches success, things already
 * queued, or failures that would fail again (bad payload, no match keys…).
 */
export function requeueReason(
  sender: "meta_capi" | "google_ads",
  r: SenderResult | undefined,
  ctx: { eventMs: number; nowMs: number; configured: boolean; googleLive: boolean }
): RequeueReason | null {
  if (r?.status === "success") return null;
  if (!ctx.configured) return null;
  if (ctx.nowMs - ctx.eventMs > MAX_SEND_AGE_MS[sender]) return null;
  if (!r) return "no_retry_time";
  switch (r.status) {
    case "validated":
      return sender === "google_ads" && ctx.googleLive ? "validated_now_live" : null;
    case "pending":
    case "retrying":
      return r.next_retry_at ? null : "no_retry_time";
    case "failed": {
      if (isNotConfigured(r.error)) return "was_not_configured";
      const res: SendResult = { ok: false, status: r.response_code ?? 0, body: "", error: r.error };
      return isRetryable(res) && r.retries < MAX_ATTEMPTS ? "retryable_failure" : null;
    }
    default:
      return null;
  }
}
