import type { FastifyInstance } from "fastify";
import { Timestamp } from "@google-cloud/firestore";
import { conversionsCol } from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import { dispatchConversion, mapLimit, type Sender } from "../senders/dispatcher.js";

const SWEEP_LIMIT = 50;
const CONCURRENCY = 10;

/**
 * Re-dispatch every sender whose next_retry_at is due. The field is only set
 * while an automatic attempt is owed (pending / retrying), so success,
 * validated and terminal failures never come back here.
 */
export async function sweepRetries(): Promise<{ due: number; errored: number }> {
  const now = Timestamp.now();
  const senders: Sender[] = ["meta_capi", "google_ads"];
  const snaps = await Promise.all(
    senders.map((s) =>
      conversionsCol
        .where(`${s}.next_retry_at`, "<=", now)
        .orderBy(`${s}.next_retry_at`)
        .limit(SWEEP_LIMIT)
        .get()
    )
  );

  const jobs: Array<{ orderId: string; sender: Sender }> = [];
  snaps.forEach((snap, i) => {
    for (const doc of snap.docs) jobs.push({ orderId: doc.id, sender: senders[i] });
  });

  const errored = await mapLimit(jobs, CONCURRENCY, (j) => dispatchConversion(j.orderId, j.sender));
  return { due: jobs.length, errored };
}

export default async function retrySweepRoute(app: FastifyInstance): Promise<void> {
  app.post("/internal/retry-sweep", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const result = await sweepRetries();
    req.log.info(result, "retry sweep complete");
    return reply.code(200).send(result);
  });
}
