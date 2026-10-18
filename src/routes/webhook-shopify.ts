import type { FastifyInstance } from "fastify";
import { Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  findVisitorByIdentifiers,
  writeConversion,
  type ConversionLog,
} from "../lib/firestore.js";
import { hashIdentity } from "../lib/hash.js";
import { verifyShopifyHmac } from "../lib/shopify-hmac.js";
import { dispatchConversion } from "../senders/dispatcher.js";

interface ShopifyAddress {
  first_name?: string;
  last_name?: string;
  zip?: string;
  city?: string;
  province_code?: string;
  province?: string;
  country_code?: string;
}

interface ShopifyNoteAttribute {
  name: string;
  value: string;
}

interface ShopifyOrder {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  total_price?: string;
  current_total_price?: string;
  currency?: string;
  created_at?: string;
  customer?: {
    id?: number;
    email?: string;
    phone?: string;
    first_name?: string;
    last_name?: string;
    default_address?: ShopifyAddress;
  };
  billing_address?: ShopifyAddress;
  shipping_address?: ShopifyAddress;
  note_attributes?: ShopifyNoteAttribute[];
}

function noteAttr(order: ShopifyOrder, key: string): string | undefined {
  return order.note_attributes?.find((a) => a.name === key)?.value;
}

function stripOrderHash(name: string): string {
  return name.startsWith("#") ? name.slice(1) : name;
}

export default async function shopifyWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post("/webhook/shopify", async (req, reply) => {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) {
      req.log.error("SHOPIFY_WEBHOOK_SECRET not configured");
      return reply.code(500).send({ error: "server_misconfigured" });
    }

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const hmac = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;
    if (!req.rawBody || !verifyShopifyHmac(req.rawBody, hmac, secret)) {
      req.log.warn({ hmacPresent: Boolean(hmac) }, "shopify hmac verification failed");
      return reply.code(401).send({ error: "invalid_hmac" });
    }

    const order = req.body as ShopifyOrder;
    const orderId = stripOrderHash(order.name ?? String(order.id));
    if (!orderId) {
      return reply.code(400).send({ error: "missing_order_id" });
    }

    // Idempotency: skip if we've already successfully sent to both platforms.
    const existing = await conversionsCol.doc(orderId).get();
    if (existing.exists) {
      const d = existing.data() as ConversionLog;
      if (d.meta_capi?.status === "success" && d.google_ads?.status === "success") {
        req.log.info({ orderId }, "shopify webhook: already sent, skipping");
        return reply.code(200).send({ accepted: true, duplicate: true });
      }
    }

    const customer = order.customer;
    const address = order.billing_address ?? order.shipping_address ?? customer?.default_address;

    const identity = hashIdentity({
      phone: customer?.phone ?? order.phone,
      email: customer?.email ?? order.email,
      firstName: customer?.first_name ?? address?.first_name,
      lastName: customer?.last_name ?? address?.last_name,
      zip: address?.zip,
      city: address?.city,
      state: address?.province_code ?? address?.province,
      country: address?.country_code ?? "IN",
    });

    const visitor = await findVisitorByIdentifiers({
      phone_meta: identity.phone_meta,
      email_hash: identity.email,
    });

    // Click IDs from cart attributes (if frontend writes them) take precedence
    // over the visitor record, since they're the exact click that led to this order.
    const gclid = noteAttr(order, "gclid") ?? visitor?.click_ids?.gclid?.value;
    const fbc = noteAttr(order, "fbc") ?? visitor?.fbc;
    const fbp = noteAttr(order, "fbp") ?? visitor?.fbp;
    const fbclid = noteAttr(order, "fbclid") ?? visitor?.click_ids?.fbclid?.value;
    // Google uses raw gclid; Meta prefers fbc/fbp but can accept raw fbclid.
    void fbclid;

    const amount = Number(order.current_total_price ?? order.total_price ?? 0);
    const eventTime = order.created_at
      ? Timestamp.fromDate(new Date(order.created_at))
      : Timestamp.now();

    const conversion: Omit<ConversionLog, "created_at" | "updated_at"> = {
      source: "shopify_online",
      order_id: orderId,
      order_amount: amount,
      currency: order.currency ?? "INR",
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
      gclid,
      fbc,
      fbp,
      client_ip_address: visitor?.client_ip_address,
      client_user_agent: visitor?.client_user_agent,
      action_source: "website",
      meta_capi: { status: "pending", retries: 0 },
      google_ads: { status: "pending", retries: 0 },
    };

    await writeConversion(orderId, conversion);

    req.log.info(
      { orderId, amount, hasVisitor: Boolean(visitor), hasGclid: Boolean(gclid) },
      "shopify order queued for send"
    );

    // Fire-and-forget dispatch so Shopify gets its 200 within its 5s window.
    // On process crash a pending record stays pending; a scheduled sweep will
    // retry (step 6, Cloud Tasks).
    void dispatchConversion(orderId).catch((err) => {
      req.log.error({ err, orderId }, "dispatch failed");
    });

    return reply.code(200).send({ accepted: true, order_id: orderId });
  });
}
