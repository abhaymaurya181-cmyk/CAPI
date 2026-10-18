import type { FastifyInstance } from "fastify";
import {
  conversionsCol,
  type ConversionLog,
  type SendStatus,
} from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import { dispatchConversion } from "../senders/dispatcher.js";

const MAX_RETRIES = 5;
const MIN_AGE_MS = 5 * 60 * 1000; // don't re-fire within 5 min of last attempt
const SWEEP_LIMIT = 50;
const RETRY_STATUSES: SendStatus[] = ["pending", "failed", "retrying"];

interface Candidate {
  orderId: string;
  needsMeta: boolean;
  needsGoogle: boolean;
}

function pickCandidate(doc: FirebaseFirestore.QueryDocumentSnapshot): Candidate | null {
  const d = doc.data() as ConversionLog;
  const now = Date.now();

  const metaStatus = d.meta_capi?.status;
  const metaRetries = d.meta_capi?.retries ?? 0;
  const metaLast = d.meta_capi?.sent_at?.toMillis() ?? 0;
  const metaRetry =
    metaStatus !== "success" &&
    metaRetries < MAX_RETRIES &&
    (metaLast === 0 || now - metaLast > MIN_AGE_MS);

  const googleStatus = d.google_ads?.status;
  const googleRetries = d.google_ads?.retries ?? 0;
  const googleLast = d.google_ads?.sent_at?.toMillis() ?? 0;
  const googleRetry =
    googleStatus !== "success" &&
    googleRetries < MAX_RETRIES &&
    (googleLast === 0 || now - googleLast > MIN_AGE_MS);

  if (!metaRetry && !googleRetry) return null;
  return { orderId: doc.id, needsMeta: metaRetry, needsGoogle: googleRetry };
}

export default async function retrySweepRoute(app: FastifyInstance): Promise<void> {
  app.post("/internal/retry-sweep", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;

    const [metaQ, googleQ] = await Promise.all([
      conversionsCol
        .where("meta_capi.status", "in", RETRY_STATUSES)
        .limit(SWEEP_LIMIT)
        .get(),
      conversionsCol
        .where("google_ads.status", "in", RETRY_STATUSES)
        .limit(SWEEP_LIMIT)
        .get(),
    ]);

    const candidates = new Map<string, Candidate>();
    for (const doc of [...metaQ.docs, ...googleQ.docs]) {
      if (candidates.has(doc.id)) continue;
      const c = pickCandidate(doc);
      if (c) candidates.set(doc.id, c);
    }

    const results = await Promise.allSettled(
      [...candidates.values()].map((c) => dispatchConversion(c.orderId))
    );

    const dispatched = results.length;
    const errored = results.filter((r) => r.status === "rejected").length;

    req.log.info({ dispatched, errored }, "retry sweep complete");

    return reply.code(200).send({
      examined: metaQ.size + googleQ.size,
      dispatched,
      errored,
    });
  });
}
