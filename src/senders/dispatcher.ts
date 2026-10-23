import {
  getConversion,
  updateConversionSender,
} from "../lib/firestore.js";
import { sendPurchaseToMeta } from "./meta.js";
import { sendPurchaseToGoogle } from "./google.js";
import { toSenderResult } from "./retry-policy.js";

export type Sender = "meta_capi" | "google_ads";

/**
 * Load the conversion, fire whichever senders are still unsent in parallel,
 * and update the log with each result. Never throws — failures are recorded
 * on the per-sender record (`retrying` with next_retry_at, or `failed`).
 * `only` limits the dispatch to one sender (used by the retry sweep).
 */
export async function dispatchConversion(orderId: string, only?: Sender): Promise<void> {
  const log = await getConversion(orderId);
  if (!log) return;

  const tasks: Promise<void>[] = [];

  if (log.meta_capi?.status !== "success" && (!only || only === "meta_capi")) {
    const attempts = (log.meta_capi?.retries ?? 0) + 1;
    tasks.push(
      sendPurchaseToMeta(log).then((res) =>
        updateConversionSender(orderId, "meta_capi", toSenderResult(res, attempts))
      )
    );
  }

  if (log.google_ads?.status !== "success" && (!only || only === "google_ads")) {
    const attempts = (log.google_ads?.retries ?? 0) + 1;
    tasks.push(
      sendPurchaseToGoogle(log).then((res) =>
        updateConversionSender(orderId, "google_ads", toSenderResult(res, attempts))
      )
    );
  }

  await Promise.allSettled(tasks);
}

/** Run fn over items with at most `limit` in flight. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<number> {
  let next = 0;
  let errored = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        errored++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return errored;
}
