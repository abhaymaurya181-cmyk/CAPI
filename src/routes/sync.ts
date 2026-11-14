import type { FastifyInstance } from "fastify";
import { syncRunsCol, type SyncRun } from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import {
  runOrnaverseMarketplaceOrdersRescan,
  runOrnaverseMarketplaceOrdersSync,
  runOrnaverseMarketplaceRescan,
  runOrnaverseMarketplaceSync,
  runOrnaversePosOrdersRescan,
  runOrnaversePosOrdersSync,
  runOrnaverseRescan,
  runOrnaverseSync,
  runOrnaverseVisitsRescan,
  runOrnaverseVisitsSync,
} from "../lib/sync.js";
import { requeueStuck } from "../lib/requeue.js";

function serializeRun(id: string, r: SyncRun) {
  return {
    id,
    ...r,
    started_at: r.started_at?.toDate().toISOString(),
    finished_at: r.finished_at?.toDate().toISOString(),
    window_from: r.window_from?.toDate().toISOString(),
    window_to: r.window_to?.toDate().toISOString(),
  };
}

export default async function syncRoute(app: FastifyInstance): Promise<void> {
  // Cloud Scheduler (SYNC_SCHEDULE).
  app.post("/internal/sync-offline", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseSync("schedule");
    req.log.info({ run: run.id, status: run.status, error: run.error }, "offline sync complete");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler, daily (RESCAN_SCHEDULE): safety re-scan of recent days.
  app.post("/internal/sync-offline-rescan", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseRescan();
    req.log.info(
      { run: run.id, status: run.status, error: run.error, new: run.processed, existing: run.skipped_duplicate },
      "offline rescan complete"
    );
    // Daily self-heal: sales stuck because credentials were missing or Google
    // was in check-only mode go back in the queue once that's fixed — no one
    // has to remember the admin button. A failure here doesn't fail the rescan.
    let requeue: Awaited<ReturnType<typeof requeueStuck>> | { error: string };
    try {
      requeue = await requeueStuck();
      req.log.info({ ...requeue, sample: undefined }, "daily requeue of stuck sales complete");
    } catch (err) {
      requeue = { error: (err as Error).message };
      req.log.error({ err }, "daily requeue of stuck sales failed");
    }
    return reply.send({ ...serializeRun(run.id, run), requeue });
  });

  // "Sync now" for the offline feed from the admin UI.
  app.post("/admin/api/sync-offline", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const run = await runOrnaverseSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler: MarketPlace (online) hourly pull.
  app.post("/internal/sync-online", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseMarketplaceSync("schedule");
    req.log.info({ run: run.id, status: run.status, error: run.error }, "online sync complete");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler, daily: MarketPlace re-scan.
  app.post("/internal/sync-online-rescan", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseMarketplaceRescan();
    req.log.info(
      { run: run.id, status: run.status, error: run.error, new: run.processed, existing: run.skipped_duplicate },
      "online rescan complete"
    );
    return reply.send(serializeRun(run.id, run));
  });

  // "Sync now" for the online feed from the admin UI.
  app.post("/admin/api/sync-online", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const run = await runOrnaverseMarketplaceSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler: CRM customer visits (store walk-ins) hourly pull.
  app.post("/internal/sync-visits", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseVisitsSync("schedule");
    req.log.info({ run: run.id, status: run.status, error: run.error }, "visits sync complete");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler, daily: visits re-scan.
  app.post("/internal/sync-visits-rescan", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseVisitsRescan();
    req.log.info(
      { run: run.id, status: run.status, error: run.error, new: run.processed, existing: run.skipped_duplicate },
      "visits rescan complete"
    );
    return reply.send(serializeRun(run.id, run));
  });

  app.post("/admin/api/sync-visits", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const run = await runOrnaverseVisitsSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler: POS Orders (event_time = order creation date). Replaces
  // the older POS/Invoice feed as the primary store-sale source. Invoice
  // scheduler is paused separately in Cloud Scheduler (code kept).
  app.post("/internal/sync-pos-orders", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaversePosOrdersSync("schedule");
    req.log.info({ run: run.id, status: run.status, error: run.error }, "pos orders sync complete");
    return reply.send(serializeRun(run.id, run));
  });

  app.post("/internal/sync-pos-orders-rescan", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaversePosOrdersRescan();
    req.log.info(
      { run: run.id, status: run.status, error: run.error, new: run.processed, existing: run.skipped_duplicate },
      "pos orders rescan complete"
    );
    return reply.send(serializeRun(run.id, run));
  });

  app.post("/admin/api/sync-pos-orders", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const run = await runOrnaversePosOrdersSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Cloud Scheduler: MarketPlace Order placeholders (show on dashboard the
  // moment Shopify creates them, don't send to ads until Invoice posts).
  app.post("/internal/sync-online-orders", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseMarketplaceOrdersSync("schedule");
    req.log.info({ run: run.id, status: run.status, error: run.error }, "mp orders sync complete");
    return reply.send(serializeRun(run.id, run));
  });

  app.post("/internal/sync-online-orders-rescan", async (req, reply) => {
    if (!requireBearer(req, reply, "INTERNAL_TOKEN")) return;
    const run = await runOrnaverseMarketplaceOrdersRescan();
    req.log.info(
      { run: run.id, status: run.status, error: run.error, new: run.processed, existing: run.skipped_duplicate },
      "mp orders rescan complete"
    );
    return reply.send(serializeRun(run.id, run));
  });

  app.post("/admin/api/sync-online-orders", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const run = await runOrnaverseMarketplaceOrdersSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Sync log, newest first.
  app.get<{ Querystring: { limit?: string } }>("/admin/api/sync-runs", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const snap = await syncRunsCol.orderBy("started_at", "desc").limit(limit).get();
    const items = snap.docs.map((d) => serializeRun(d.id, d.data() as SyncRun));
    return reply.send({ items, count: items.length });
  });
}
