import { Timestamp } from "@google-cloud/firestore";
import {
  getConversion,
  updateConversionSender,
  type SenderResult,
} from "../lib/firestore.js";
import { sendPurchaseToMeta } from "./meta.js";
import { sendPurchaseToGoogle } from "./google.js";
import type { SendResult } from "./types.js";

function toSenderResult(res: SendResult, retries: number): SenderResult {
  return {
    status: res.ok ? "success" : res.validated ? "validated" : "failed",
    response_code: res.status,
    response_body: res.body ? res.body.slice(0, 2000) : undefined,
    retries,
    sent_at: Timestamp.now(),
    error: res.error,
  };
}

/**
 * Load the conversion, fire whichever senders are still pending in parallel,
 * and update the log with each result. Never throws — failures are recorded
 * as `status: failed` on the per-sender record for the retry sweep to pick up.
 */
export async function dispatchConversion(orderId: string): Promise<void> {
  const log = await getConversion(orderId);
  if (!log) return;

  const tasks: Promise<void>[] = [];

  if (log.meta_capi?.status !== "success") {
    const retries = (log.meta_capi?.retries ?? 0) + 1;
    tasks.push(
      sendPurchaseToMeta(log).then((res) =>
        updateConversionSender(orderId, "meta_capi", toSenderResult(res, retries))
      )
    );
  }

  if (log.google_ads?.status !== "success") {
    const retries = (log.google_ads?.retries ?? 0) + 1;
    tasks.push(
      sendPurchaseToGoogle(log).then((res) =>
        updateConversionSender(orderId, "google_ads", toSenderResult(res, retries))
      )
    );
  }

  await Promise.allSettled(tasks);
}
