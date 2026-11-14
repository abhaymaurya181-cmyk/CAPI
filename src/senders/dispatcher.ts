import {
  getConversion,
  updateConversionSender,
} from "../lib/firestore.js";
import { sendPurchaseToMeta } from "./meta.js";
import { sendToGoogle } from "./google.js";
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

  const isStoreVisit = log.event_type === "store_visit";
  const isWebsite = log.action_source === "website";

  // Orders pulled from MarketPlace/Order/List without a matching Invoice are
  // placeholders — they show in the admin so the dashboard matches Shopify's
  // raw order count, but we don't send to ad platforms until the Invoice
  // posts. buildConversion omits sender records for these, but double-guard
  // in case an existing row flips state during a sync run.
  if (log.pending_invoice) return;

  // Website orders: Shopify's own pixel already reports to Meta client-side,
  // so a server CAPI would double-count. Google Ads server-side send IS wanted
  // (Google dedupes by transactionId across gtag + server), gated by a
  // dedicated validate flag so we can stage it on separately from store sales.
  // Store Visits have no Meta equivalent — the sale itself fires Meta.
  if (
    !isStoreVisit &&
    !isWebsite &&
    log.meta_capi?.status !== "success" &&
    (!only || only === "meta_capi")
  ) {
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
      sendToGoogle(log).then((res) =>
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
