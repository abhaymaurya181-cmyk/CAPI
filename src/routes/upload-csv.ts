import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  findVisitorByIdentifiers,
  writeConversion,
  type ConversionLog,
} from "../lib/firestore.js";
import { hashIdentity } from "../lib/hash.js";
import { selectClicks } from "../lib/click-ids.js";
import { requireBearer } from "../lib/auth.js";
import { dispatchConversion } from "../senders/dispatcher.js";

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

    let processed = 0;
    let skippedDuplicate = 0;
    let matchedWithVisitor = 0;
    const failures: Array<{ sale_id: string; error: string }> = [];

    for (const r of parsed.data.rows) {
      try {
        if (!r.phone && !r.email) {
          failures.push({ sale_id: r.sale_id, error: "no_identifier" });
          continue;
        }

        const existing = await conversionsCol.doc(r.sale_id).get();
        if (existing.exists) {
          const d = existing.data() as ConversionLog;
          if (d.meta_capi?.status === "success" && d.google_ads?.status === "success") {
            skippedDuplicate++;
            continue;
          }
        }

        const identity = hashIdentity({
          phone: r.phone,
          email: r.email,
          firstName: r.first_name,
          lastName: r.last_name,
          zip: r.zip,
          city: r.city,
          state: r.state,
          country: r.country,
        });

        const visitor = await findVisitorByIdentifiers({
          phone_meta: identity.phone_meta,
          email_hash: identity.email,
        });
        if (visitor) matchedWithVisitor++;
        const clicks = selectClicks(visitor);

        const eventTime = r.event_time
          ? Timestamp.fromDate(new Date(r.event_time))
          : Timestamp.now();

        const conversion: Omit<ConversionLog, "created_at" | "updated_at"> = {
          source: "csv_upload",
          order_id: r.sale_id,
          order_amount: r.amount,
          currency: r.currency,
          event_time: eventTime,
          phone_meta: identity.phone_meta,
          phone_google: identity.phone_google,
          email_hash: identity.email,
          first_name_hash: identity.first_name,
          last_name_hash: identity.last_name,
          zip_hash: identity.zip,
          city_hash: identity.city,
          state_hash: identity.state,
          country_hash: identity.country,
          gclid: clicks.google?.gclid,
          gbraid: clicks.google?.gbraid,
          wbraid: clicks.google?.wbraid,
          fbc: clicks.meta?.fbc,
          fbp: visitor?.fbp,
          client_ip_address: visitor?.client_ip_address,
          client_user_agent: visitor?.client_user_agent,
          action_source: "physical_store",
          meta_capi: { status: "pending", retries: 0 },
          google_ads: { status: "pending", retries: 0 },
        };

        await writeConversion(r.sale_id, conversion);
        void dispatchConversion(r.sale_id).catch((err) => {
          req.log.error({ err, saleId: r.sale_id }, "csv dispatch failed");
        });
        processed++;
      } catch (err) {
        failures.push({ sale_id: r.sale_id, error: (err as Error).message });
      }
    }

    return reply.code(200).send({
      processed,
      skipped_duplicate: skippedDuplicate,
      matched_with_visitor: matchedWithVisitor,
      failures,
    });
  });
}
