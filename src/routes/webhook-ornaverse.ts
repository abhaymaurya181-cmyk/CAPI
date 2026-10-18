import type { FastifyInstance } from "fastify";

/**
 * OrnaVerse webhook stub. Payload shape and auth mechanism are TBC — depends
 * on what OrnaVerse exposes. Once Lucira shares API docs, replace this with:
 *   1. Signature / auth verification per OrnaVerse's scheme
 *   2. Row parsing matching upload-csv's expected fields
 *   3. Same hash + visitor-lookup + writeConversion + dispatch flow
 *
 * Until then, CSV upload via /admin/upload/offline-sales is the offline path.
 */
export default async function ornaverseWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post("/webhook/ornaverse", async (req, reply) => {
    req.log.info({ body: req.body }, "ornaverse webhook received (stub)");
    return reply.code(202).send({
      accepted: true,
      note: "ornaverse adapter pending Lucira's API docs; use /admin/upload/offline-sales for now",
    });
  });
}
