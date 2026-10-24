import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import geoip from "geoip-lite";
import { z } from "zod";
import {
  FieldValue,
  Timestamp,
  getVisitor,
  upsertVisitor,
  visitorKey,
  type Visitor,
} from "../lib/firestore.js";
import {
  hashDob,
  hashGender,
  hashIdentity,
  cleanEmail,
  normalizeDob,
  normalizeGender,
  normalizeName,
  normalizePhoneE164,
  sha256,
} from "../lib/hash.js";
import {
  googleClickFromCookies,
  mergeGoogleClick,
  mergeMetaClick,
  metaClickFromCookies,
  parseFbCookie,
  parseGaClientId,
} from "../lib/click-ids.js";

const LCID_COOKIE = "lcid";
const LCID_MAX_AGE = 63_072_000; // 2 years

// Derive the apex domain (`.example.com`) from the request Host so the lcid
// cookie survives across subdomains. Localhost / IP / single-label hosts get
// no Domain attribute, which scopes the cookie to just that host.
function cookieDomainFromHost(host?: string): string | undefined {
  if (!host) return undefined;
  const bare = host.split(":")[0];
  if (bare === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) return undefined;
  const parts = bare.split(".");
  if (parts.length < 2) return undefined;
  return "." + parts.slice(-2).join(".");
}

// IP-based geo lookup using an embedded MaxMind GeoLite2 database (offline,
// no API calls). Vanilla Cloud Run doesn't attach X-Appengine-* headers, so
// doing the lookup ourselves is the only way to show "where did this visitor
// come from" in the admin UI. Admin-UI only — never sent to Meta/Google.
function lookupGeo(
  ip: string | undefined
): { country?: string; region?: string; city?: string; lat_long?: string } | undefined {
  if (!ip) return undefined;
  const r = geoip.lookup(ip);
  if (!r) return undefined;
  const out = {
    country: r.country || undefined,
    region: r.region || undefined,
    city: r.city || undefined,
    lat_long: r.ll ? `${r.ll[0]},${r.ll[1]}` : undefined,
  };
  return Object.values(out).some((v) => v) ? out : undefined;
}

function ensureLcid(req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies?.[LCID_COOKIE];
  if (existing) return existing;
  const fresh = randomUUID();
  reply.setCookie(LCID_COOKIE, fresh, {
    path: "/",
    httpOnly: true,
    secure: req.protocol === "https",
    sameSite: "lax",
    maxAge: LCID_MAX_AGE,
    domain: cookieDomainFromHost(req.headers.host),
  });
  return fresh;
}

const landingInfo = z.object({
  url: z.string().max(1000).optional(),
  referrer: z.string().max(1000).optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
});

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
  date_of_birth: z.string().optional(),
  gender: z.string().optional(),
  cookies: z
    .object({
      gclid: z.string().optional(),
      gclid_at: z.number().optional(),
      wbraid: z.string().optional(),
      wbraid_at: z.number().optional(),
      gbraid: z.string().optional(),
      gbraid_at: z.number().optional(),
      _gcl_aw: z.string().optional(),
      _gcl_gb: z.string().optional(),
      _gcl_au: z.string().optional(),
      _ga: z.string().optional(),
      fbclid: z.string().optional(),
      _fbc: z.string().optional(),
      _fbp: z.string().optional(),
      client_cookie_id: z.string().optional(),
    })
    .optional(),
  landing: z
    .object({
      google: landingInfo.optional(),
      meta: landingInfo.optional(),
    })
    .optional(),
  consent: z
    .object({
      marketing: z.boolean(),
      version: z.string(),
      ad_user_data: z.enum(["granted", "denied"]).optional(),
      ad_personalization: z.enum(["granted", "denied"]).optional(),
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

    // Mint-or-reuse the first-party visitor cookie BEFORE any Firestore work
    // so the Set-Cookie header is always on the response (even on anonymous
    // 202 returns). The cookie value is stored on the visitor doc when a
    // key resolves, so later lookups by lcid are possible.
    const lcid = ensureLcid(req, reply);

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
      return reply.code(202).send({ accepted: true, stored: false, lcid });
    }

    const now = Timestamp.now();
    // Read the current doc so first_seen_at and the first click are kept,
    // and a click we already have doesn't move `last`.
    const existing = await getVisitor(key);

    const update: Partial<Visitor> = {
      first_seen_at: existing?.first_seen_at ?? now,
      // `?? undefined` everywhere: ignoreUndefinedProperties on the Firestore
      // client skips undefined, so an event that lacks (or has a malformed)
      // field never wipes a value stored by an earlier event. A null would.
      phone_meta: identity.phone_meta ?? undefined,
      phone_google: identity.phone_google ?? undefined,
      email_hash: identity.email ?? undefined,
      email_google_hash: identity.email_google ?? undefined,
      first_name_hash: identity.first_name ?? undefined,
      last_name_hash: identity.last_name ?? undefined,
      zip_hash: identity.zip ?? undefined,
      city_hash: identity.city ?? undefined,
      state_hash: identity.state ?? undefined,
      // Only when sent: hashIdentity defaults country to IN.
      country_hash: body.country ? identity.country ?? undefined : undefined,
      // Raw (normalized) values persisted alongside hashes for admin display.
      raw_phone: normalizePhoneE164(body.phone) ?? undefined,
      raw_email: cleanEmail(body.email, body.phone) ?? undefined,
      raw_first_name: normalizeName(body.first_name) ?? undefined,
      raw_last_name: normalizeName(body.last_name) ?? undefined,
      raw_zip: body.zip?.trim() || undefined,
      raw_city: body.city?.trim() || undefined,
      raw_state: body.state?.trim() || undefined,
      raw_country: body.country?.trim().toUpperCase() || undefined,
      raw_dob: normalizeDob(body.date_of_birth) ?? undefined,
      raw_gender: normalizeGender(body.gender) ?? undefined,
      dob_hash: hashDob(body.date_of_birth) ?? undefined,
      gender_hash: hashGender(body.gender) ?? undefined,
      lcid,
      user_id: body.user_id,
      shopify_customer_id: body.shopify_customer_id,
      client_ip_address: req.ip,
      client_user_agent: req.headers["user-agent"] ?? undefined,
      geo: lookupGeo(req.ip),
      // arrayUnion appends uniquely; cast required because the typed field is string[]
      touchpoints: FieldValue.arrayUnion(body.event) as unknown as string[],
    };

    // Meta external_id: the most stable id we have for this person. Upgrades
    // from lcid to a customer id once one is known, never downgrades.
    const extId =
      (body.shopify_customer_id && { v: body.shopify_customer_id, s: "shopify_customer_id" as const }) ||
      (body.user_id && { v: body.user_id, s: "user_id" as const }) ||
      (!existing?.external_id && { v: lcid, s: "lcid" as const }) ||
      null;
    if (extId) {
      update.external_id = sha256(extId.v.trim().toLowerCase());
      update.external_id_source = extId.s;
    }

    const c = body.cookies;
    const device = {
      ip_address: req.ip,
      user_agent: req.headers["user-agent"] ?? undefined,
    };
    const nowMs = now.toMillis();
    const meta = mergeMetaClick(
      existing,
      metaClickFromCookies(c, body.landing?.meta, device, nowMs)
    );
    const google = mergeGoogleClick(
      existing,
      googleClickFromCookies(c, body.landing?.google, device, nowMs)
    );
    if (meta || google) {
      update.click_ids = {
        ...(meta ? { meta } : {}),
        ...(google ? { google } : {}),
      };
    }

    if (c?._fbp) {
      update.fbp = c._fbp;
      const at = parseFbCookie(c._fbp).at;
      if (at) update.fbp_captured_at = Timestamp.fromMillis(at);
    }
    if (c?._gcl_au) update.gcl_au = c._gcl_au;
    const gaClientId = parseGaClientId(c?._ga);
    if (gaClientId) update.ga_client_id = gaClientId;
    const cookieIds = Array.from(
      new Set([lcid, c?.client_cookie_id].filter(Boolean) as string[])
    );
    if (cookieIds.length > 0) {
      update.cookie_ids = FieldValue.arrayUnion(...cookieIds) as unknown as string[];
    }

    if (body.consent) {
      update.consent = {
        marketing: body.consent.marketing,
        timestamp: now,
        version: body.consent.version,
        ad_user_data: body.consent.ad_user_data,
        ad_personalization: body.consent.ad_personalization,
      };
    }

    await upsertVisitor(key, update);

    return reply.code(202).send({
      accepted: true,
      stored: true,
      visitor_key_prefix: key.slice(0, 8),
      lcid,
    });
  });
}
