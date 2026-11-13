import type { FastifyInstance } from "fastify";
import { syncRunsCol, type SyncRun } from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import {
  runOrnaverseMarketplaceRescan,
  runOrnaverseMarketplaceSync,
  runOrnaverseRescan,
  runOrnaverseSync,
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

  // Sync log, newest first.
  app.get<{ Querystring: { limit?: string } }>("/admin/api/sync-runs", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const snap = await syncRunsCol.orderBy("started_at", "desc").limit(limit).get();
    const items = snap.docs.map((d) => serializeRun(d.id, d.data() as SyncRun));
    return reply.send({ items, count: items.length });
  });
}
