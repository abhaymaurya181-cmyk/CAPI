import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  FieldValue,
  Timestamp,
  upsertVisitor,
  visitorKey,
  type Visitor,
} from "../lib/firestore.js";
import { hashIdentity } from "../lib/hash.js";

const identifyBody = z.object({
  event: z.enum([
    "page_view",
    "addToCart",
    "login",
    "signup",
    "begin_checkout",
    "purchase",
    "customerData",
    "newsletterSubscription",
  ]),
  event_id: z.string().optional(),
  user_id: z.string().optional(),
  shopify_customer_id: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  cookies: z
    .object({
      gclid: z.string().optional(),
      fbclid: z.string().optional(),
      _fbc: z.string().optional(),
      _fbp: z.string().optional(),
      client_cookie_id: z.string().optional(),
    })
    .optional(),
  consent: z
    .object({
      marketing: z.boolean(),
      version: z.string(),
    })
    .optional(),
});

export type IdentifyBody = z.infer<typeof identifyBody>;

export default async function identifyRoute(app: FastifyInstance): Promise<void> {
  app.post("/identify", async (req, reply) => {
    const parsed = identifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_payload",
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const identity = hashIdentity({
      phone: body.phone,
      email: body.email,
      firstName: body.first_name,
      lastName: body.last_name,
      zip: body.zip,
      city: body.city,
      state: body.state,
      country: body.country,
    });

    const key = visitorKey({
      phone_meta: identity.phone_meta,
      email_hash: identity.email,
      user_id: body.user_id,
    });

    // Anonymous events (no identifier) are not persisted. Click IDs stay in
    // the browser cookie until the next identified event.
    if (!key) {
      return reply.code(202).send({ accepted: true, stored: false });
    }

    const now = Timestamp.now();
    const update: Partial<Visitor> = {
      phone_meta: identity.phone_meta,
      phone_google: identity.phone_google,
      email_hash: identity.email,
      first_name_hash: identity.first_name,
      last_name_hash: identity.last_name,
      zip_hash: identity.zip,
      city_hash: identity.city,
      state_hash: identity.state,
      country_hash: identity.country,
      user_id: body.user_id,
      shopify_customer_id: body.shopify_customer_id,
      client_ip_address: req.ip,
      client_user_agent: req.headers["user-agent"] ?? undefined,
      // arrayUnion appends uniquely; cast required because the typed field is string[]
      touchpoints: FieldValue.arrayUnion(body.event) as unknown as string[],
    };

    const c = body.cookies;
    const click_ids: NonNullable<Visitor["click_ids"]> = {};
    if (c?.gclid) click_ids.gclid = { value: c.gclid, captured_at: now };
    if (c?.fbclid) click_ids.fbclid = { value: c.fbclid, captured_at: now };
    if (Object.keys(click_ids).length > 0) update.click_ids = click_ids;

    if (c?._fbc) update.fbc = c._fbc;
    if (c?._fbp) update.fbp = c._fbp;
    if (c?.client_cookie_id) {
      update.cookie_ids = FieldValue.arrayUnion(c.client_cookie_id) as unknown as string[];
    }

    if (body.consent) {
      update.consent = {
        marketing: body.consent.marketing,
        timestamp: now,
        version: body.consent.version,
      };
    }

    await upsertVisitor(key, update);

    return reply.code(202).send({
      accepted: true,
      stored: true,
      visitor_key_prefix: key.slice(0, 8),
    });
  });
}
