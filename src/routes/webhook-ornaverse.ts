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
    // Never log the body: OrnaVerse payloads carry customer phone/email/name.
    // Size, content type and top-level field names are enough to see that
    // deliveries arrive and what shape they have, without any PII.
    const body = req.body;
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body as Record<string, unknown>).slice(0, 50)
        : undefined;
    req.log.info(
      {
        bytes: req.rawBody?.length ?? 0,
        content_type: req.headers["content-type"],
        body_type: Array.isArray(body) ? "array" : typeof body,
        fields,
      },
      "ornaverse webhook received (stub)"
    );
    // The hourly pull is the source of truth until 5b is built, so a delivery
    // accepted here is not lost.
    return reply.code(202).send({
      accepted: true,
      note: "ornaverse adapter pending Lucira's API docs; use /admin/upload/offline-sales for now",
    });
  });
}
