import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireBearer } from "../lib/auth.js";
import { runCsvImport } from "../lib/sync.js";

const row = z.object({
  sale_id: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  amount: z.number().nonnegative(),
  currency: z.string().default("INR"),
  zip: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().default("IN"),
  store_name: z.string().optional(),
  event_time: z.string().optional(),
});

const body = z.object({
  rows: z.array(row).min(1).max(1000),
});

export default async function uploadCsvRoute(app: FastifyInstance): Promise<void> {
  app.post("/admin/api/upload/offline-sales", async (req, reply) => {
    if (!requireBearer(req, reply, "ADMIN_TOKEN")) return;

    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_payload",
        issues: parsed.error.issues,
      });
    }

    const run = await runCsvImport(
      parsed.data.rows.map((r) => ({
        ...r,
        event_time: r.event_time ? new Date(r.event_time) : new Date(),
      }))
    );

    return reply.code(200).send({
      sync_run_id: run.id,
      status: run.status,
      processed: run.processed,
      skipped_duplicate: run.skipped_duplicate,
      matched_with_visitor: run.matched,
      matched_with_click: run.matched_with_click,
      failures: run.failures,
    });
  });
}
