import { FieldPath, Timestamp } from "@google-cloud/firestore";
import { conversionsCol, db, type ConversionLog } from "./firestore.js";
import { requeueReason, type RequeueReason } from "../senders/retry-policy.js";
import { metaConfigured } from "../senders/meta.js";
import { googleConfig } from "../senders/google.js";
import type { Sender } from "../senders/dispatcher.js";

const PAGE = 500;
// Safety bound on one pass; at ~10 store sales/day this is years of history.
const MAX_SCAN = 20_000;
const SAMPLE = 20;

export interface RequeueSummary {
  dry_run: boolean;
  scanned: number;
  requeued: number;
  by_reason: Partial<Record<RequeueReason, number>>;
  by_sender: Record<Sender, number>;
  // A few order ids, for checking in the admin.
  sample: string[];
  truncated: boolean;
}

/**
 * Put stuck sales back in the retry queue (next_retry_at = now), so the
 * retry sweep sends them. "Stuck" = see requeueReason: records from before
 * the retry system, sales that failed only because Meta/Google credentials
 * were missing, Google check-only ("validated") sales once Google is live,
 * and retryable failures with attempts left. Nothing else is touched.
 *
 * Safe to run any time and repeatedly: a requeued sender has next_retry_at
 * set, so the next pass skips it. `dryRun` only counts.
 */
export async function requeueStuck(
  opts: { dryRun?: boolean; nowMs?: number } = {}
): Promise<RequeueSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const gcfg = googleConfig();
  const ctxFor = (sender: Sender, eventMs: number) => ({
    eventMs,
    nowMs,
    configured: sender === "meta_capi" ? metaConfigured() : gcfg != null,
    googleLive: gcfg != null && !gcfg.validateOnly,
  });

  const out: RequeueSummary = {
    dry_run: Boolean(opts.dryRun),
    scanned: 0,
    requeued: 0,
    by_reason: {},
    by_sender: { meta_capi: 0, google_ads: 0 },
    sample: [],
    truncated: false,
  };

  /** Field updates for one conversion, or null if nothing should change. */
  const planUpdate = (log: ConversionLog) => {
    const eventMs = log.event_time?.toMillis();
    if (eventMs == null) return null; // malformed row: leave it for a human
    const update: Record<string, unknown> = {};
    const reasons: Array<{ sender: Sender; reason: RequeueReason }> = [];
    for (const sender of ["meta_capi", "google_ads"] as const) {
      const reason = requeueReason(sender, log[sender], ctxFor(sender, eventMs));
      if (!reason) continue;
      // Credentials / live mode were the only problem: give the sale its full attempts.
      const freshStart = reason === "was_not_configured" || reason === "validated_now_live";
      update[`${sender}.status`] = "pending";
      update[`${sender}.next_retry_at`] = Timestamp.fromMillis(nowMs);
      update[`${sender}.requeued_at`] = Timestamp.fromMillis(nowMs);
      update[`${sender}.requeue_reason`] = reason;
      if (freshStart || log[sender] == null) update[`${sender}.retries`] = 0;
      reasons.push({ sender, reason });
    }
    return reasons.length ? { update, reasons } : null;
  };

  let last: string | undefined;
  while (out.scanned < MAX_SCAN) {
    let q = conversionsCol.orderBy(FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      out.scanned++;
      const planned = planUpdate(doc.data() as ConversionLog);
      if (!planned) continue;

      let applied: typeof planned | null = planned;
      if (!opts.dryRun) {
        // Re-read and re-decide inside a transaction: a retry may have just
        // sent this sale; never turn a fresh "success" back into "pending".
        applied = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return null;
          const p = planUpdate(fresh.data() as ConversionLog);
          if (p) tx.update(doc.ref, { ...p.update, updated_at: Timestamp.fromMillis(nowMs) });
          return p;
        });
        if (!applied) continue;
      }
      out.requeued++;
      if (out.sample.length < SAMPLE) out.sample.push(doc.id);
      for (const { sender, reason } of applied.reasons) {
        out.by_reason[reason] = (out.by_reason[reason] ?? 0) + 1;
        out.by_sender[sender]++;
      }
    }

    last = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGE) break;
  }
  out.truncated = out.scanned >= MAX_SCAN;
  return out;
}
