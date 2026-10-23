import type { FastifyInstance } from "fastify";
import { syncRunsCol, type SyncRun } from "../lib/firestore.js";
import { requireBearer } from "../lib/auth.js";
import { runOrnaverseSync } from "../lib/sync.js";

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

  // "Sync now" for the offline feed from the admin UI.
  app.post("/admin/api/sync-offline", async (req, reply) => {
    if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;
    const run = await runOrnaverseSync("manual");
    return reply.send(serializeRun(run.id, run));
  });

  // Sync log, newest first.
  app.get<{ Querystring: { limit?: string } }>("/admin/api/sync-runs", async (req, reply) => {
    if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const snap = await syncRunsCol.orderBy("started_at", "desc").limit(limit).get();
    const items = snap.docs.map((d) => serializeRun(d.id, d.data() as SyncRun));
    return reply.send({ items, count: items.length });
  });
}
