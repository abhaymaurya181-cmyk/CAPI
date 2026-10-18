import type { FastifyInstance } from "fastify";
import { Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  getConversion,
  visitorsCol,
  type ConversionLog,
  type SendStatus,
} from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import { dispatchConversion } from "../senders/dispatcher.js";

const BAD_STATUSES: SendStatus[] = ["pending", "failed", "retrying"];

function startOfTodayUtc(): Timestamp {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Timestamp.fromDate(now);
}

/**
 * Parse ?range= (today | 7d | 30d | all) or ?from=&to= into a start/end pair.
 * Returns null bounds when "all" so the caller can skip the where() clause.
 */
function parseRange(query: {
  range?: string;
  from?: string;
  to?: string;
}): { from: Timestamp | null; to: Timestamp | null; label: string } {
  const now = new Date();
  if (query.from || query.to) {
    return {
      from: query.from ? Timestamp.fromDate(new Date(query.from)) : null,
      to: query.to ? Timestamp.fromDate(new Date(query.to)) : null,
      label: "custom",
    };
  }
  const r = (query.range ?? "today").toLowerCase();
  if (r === "all") return { from: null, to: null, label: "all" };
  if (r === "7d") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 7);
    return { from: Timestamp.fromDate(d), to: null, label: "7d" };
  }
  if (r === "30d") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 30);
    return { from: Timestamp.fromDate(d), to: null, label: "30d" };
  }
  return { from: startOfTodayUtc(), to: null, label: "today" };
}

function applyRange(
  base: FirebaseFirestore.Query,
  range: { from: Timestamp | null; to: Timestamp | null }
): FirebaseFirestore.Query {
  let q = base;
  if (range.from) q = q.where("created_at", ">=", range.from);
  if (range.to) q = q.where("created_at", "<=", range.to);
  return q;
}

export default async function adminApiRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>(
    "/admin/api/login",
    async (req, reply) => {
      const { username, password } = req.body ?? {};
      const expectedUser = process.env.ADMIN_USERNAME ?? "admin";
      const expectedPass = process.env.ADMIN_TOKEN;
      if (!expectedPass) {
        return reply.code(500).send({ error: "server_misconfigured" });
      }
      if (username !== expectedUser || password !== expectedPass) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      return reply.send({ token: expectedPass });
    }
  );

  app.get<{ Querystring: { range?: string; from?: string; to?: string } }>(
    "/admin/api/stats",
    async (req, reply) => {
      if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;

      const range = parseRange(req.query);
      const rangedConversions = applyRange(conversionsCol, range);

      const [
        visitorsTotal,
        conversionsTotal,
        metaOk,
        googleOk,
        metaFailing,
        googleFailing,
      ] = await Promise.all([
        visitorsCol.count().get(),
        rangedConversions.count().get(),
        applyRange(conversionsCol, range)
          .where("meta_capi.status", "==", "success")
          .count()
          .get(),
        applyRange(conversionsCol, range)
          .where("google_ads.status", "==", "success")
          .count()
          .get(),
        conversionsCol.where("meta_capi.status", "in", BAD_STATUSES).count().get(),
        conversionsCol.where("google_ads.status", "in", BAD_STATUSES).count().get(),
      ]);

      const total = conversionsTotal.data().count;
      const metaOkCount = metaOk.data().count;
      const googleOkCount = googleOk.data().count;

      return reply.send({
        range: {
          label: range.label,
          from: range.from?.toDate().toISOString() ?? null,
          to: range.to?.toDate().toISOString() ?? null,
        },
        visitors: {
          total: visitorsTotal.data().count,
        },
        conversions: {
          total,
          meta_success: metaOkCount,
          google_success: googleOkCount,
          meta_match_rate: total > 0 ? +(metaOkCount / total).toFixed(3) : 0,
          google_match_rate: total > 0 ? +(googleOkCount / total).toFixed(3) : 0,
        },
        backlog: {
          meta_pending_or_failed: metaFailing.data().count,
          google_pending_or_failed: googleFailing.data().count,
        },
      });
    }
  );

  /**
   * Manual sync-now from the admin UI. Scans up to SWEEP_LIMIT pending/failed
   * conversions and re-dispatches them. Mirrors /internal/retry-sweep but is
   * gated by ADMIN_TOKEN so it can be triggered from the browser.
   */
  app.post("/admin/api/sync-now", async (req, reply) => {
    if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;
    const SWEEP_LIMIT = 50;
    const [metaQ, googleQ] = await Promise.all([
      conversionsCol
        .where("meta_capi.status", "in", BAD_STATUSES)
        .limit(SWEEP_LIMIT)
        .get(),
      conversionsCol
        .where("google_ads.status", "in", BAD_STATUSES)
        .limit(SWEEP_LIMIT)
        .get(),
    ]);
    const ids = new Set<string>();
    for (const doc of [...metaQ.docs, ...googleQ.docs]) ids.add(doc.id);
    const results = await Promise.allSettled(
      [...ids].map((id) => dispatchConversion(id))
    );
    return reply.send({
      dispatched: results.length,
      errored: results.filter((r) => r.status === "rejected").length,
    });
  });

  app.get<{
    Querystring: { status?: string; limit?: string; range?: string; from?: string; to?: string };
  }>("/admin/api/conversions", async (req, reply) => {
    if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;

    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const range = parseRange(req.query);
    let q: FirebaseFirestore.Query = conversionsCol;

    if (req.query.status === "failed") {
      q = q.where("meta_capi.status", "in", ["failed", "retrying"]);
    } else if (req.query.status === "pending") {
      q = q.where("meta_capi.status", "==", "pending");
    }
    q = applyRange(q, range).orderBy("created_at", "desc").limit(limit);

    const snap = await q.get();
      const items = snap.docs.map((d) => {
        const log = d.data() as ConversionLog;
        return {
          order_id: log.order_id,
          source: log.source,
          amount: log.order_amount,
          currency: log.currency,
          created_at: log.created_at?.toDate().toISOString(),
          meta_status: log.meta_capi?.status,
          meta_retries: log.meta_capi?.retries,
          google_status: log.google_ads?.status,
          google_retries: log.google_ads?.retries,
          has_gclid: Boolean(log.gclid),
          has_fbc: Boolean(log.fbc),
        };
      });
      return reply.send({ items, count: items.length });
    }
  );

  app.get<{ Params: { orderId: string } }>(
    "/admin/api/conversions/:orderId",
    async (req, reply) => {
      if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;

      const log = await getConversion(req.params.orderId);
      if (!log) return reply.code(404).send({ error: "not_found" });

      return reply.send({
        ...log,
        created_at: log.created_at?.toDate().toISOString(),
        updated_at: log.updated_at?.toDate().toISOString(),
        event_time: log.event_time?.toDate().toISOString(),
        meta_capi: log.meta_capi
          ? { ...log.meta_capi, sent_at: log.meta_capi.sent_at?.toDate().toISOString() }
          : undefined,
        google_ads: log.google_ads
          ? { ...log.google_ads, sent_at: log.google_ads.sent_at?.toDate().toISOString() }
          : undefined,
      });
    }
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/conversions/:orderId/retry",
    async (req, reply) => {
      if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;

      const log = await getConversion(req.params.orderId);
      if (!log) return reply.code(404).send({ error: "not_found" });

      void dispatchConversion(req.params.orderId).catch((err) => {
        req.log.error({ err, orderId: req.params.orderId }, "manual retry failed");
      });
      return reply.send({ accepted: true });
    }
  );
}
