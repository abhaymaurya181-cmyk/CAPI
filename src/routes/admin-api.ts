import type { FastifyInstance } from "fastify";
import { Filter, Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  getConversion,
  visitorsCol,
  type ConversionLog,
  type GoogleClick,
  type MetaClick,
  type SenderResult,
  type SendStatus,
  type Visitor,
} from "../lib/firestore.js";
import { clickMode } from "../lib/click-ids.js";
import { requireBearer } from "../lib/auth.js";
import { dispatchConversion } from "../senders/dispatcher.js";
import { requeueStuck } from "../lib/requeue.js";
import { sweepRetries } from "./retry-sweep.js";
import { hashEmail, hashPhoneForMeta } from "../lib/hash.js";
import { buildConversion, type SaleInput } from "../lib/matcher.js";
import { buildMetaPayload, metaPreflightError } from "../senders/meta.js";
import { summarizeConversions, type Channel } from "../lib/analytics.js";
import {
  INGEST_URL as GOOGLE_INGEST_URL,
  buildGooglePayload,
  googleConfig,
  googlePreflightError,
} from "../senders/google.js";

const BAD_STATUSES: SendStatus[] = ["pending", "failed", "retrying"];

function startOfTodayUtc(): Timestamp {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Timestamp.fromDate(now);
}

/**
 * Parse ?range= (today | 7d | 30d | all) or ?from=&to= into a start/end pair.
 * Returns null bounds when "all" so the caller can skip the where() clause.
 */
function parseRange(query: {
  range?: string;
  from?: string;
  to?: string;
}): { from: Timestamp | null; to: Timestamp | null; label: string } {
  const now = new Date();
  if (query.from || query.to) {
    return {
      from: query.from ? Timestamp.fromDate(new Date(query.from)) : null,
      to: query.to ? Timestamp.fromDate(new Date(query.to)) : null,
      label: "custom",
    };
  }
  const r = (query.range ?? "today").toLowerCase();
  if (r === "all") return { from: null, to: null, label: "all" };
  if (r === "7d") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 7);
    return { from: Timestamp.fromDate(d), to: null, label: "7d" };
  }
  if (r === "30d") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 30);
    return { from: Timestamp.fromDate(d), to: null, label: "30d" };
  }
  return { from: startOfTodayUtc(), to: null, label: "today" };
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
// Analytics loads every sale in the range; ~10 bills/day, so this is years.
const ANALYTICS_MAX_ROWS = 5000;

/**
 * Sale-date range for analytics, in India time: "today" starts at IST
 * midnight, and a custom ?to= day is included in full.
 */
export function parseIstSaleRange(
  query: { range?: string; from?: string; to?: string },
  nowMs = Date.now()
): { from: Date | null; to: Date | null } {
  const istMidnight = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
  const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (query.from || query.to) {
    return {
      from: isDay(query.from) ? istMidnight(query.from!) : null,
      to: isDay(query.to) ? new Date(istMidnight(query.to!).getTime() + DAY_MS) : null,
    };
  }
  const r = (query.range ?? "30d").toLowerCase();
  if (r === "all") return { from: null, to: null };
  if (r === "7d") return { from: new Date(nowMs - 7 * DAY_MS), to: null };
  if (r === "today") {
    const todayIst = new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
    return { from: istMidnight(todayIst), to: null };
  }
  return { from: new Date(nowMs - 30 * DAY_MS), to: null };
}

function applyRange(
  base: FirebaseFirestore.Query,
  range: { from: Timestamp | null; to: Timestamp | null }
): FirebaseFirestore.Query {
  let q = base;
  if (range.from) q = q.where("created_at", ">=", range.from);
  if (range.to) q = q.where("created_at", "<=", range.to);
  return q;
}

function serializeSender(r?: SenderResult) {
  if (!r) return undefined;
  return {
    ...r,
    sent_at: r.sent_at?.toDate().toISOString(),
    next_retry_at: r.next_retry_at?.toDate().toISOString(),
  };
}

export default async function adminApiRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>(
    "/admin/api/login",
    async (req, reply) => {
      const { username, password } = req.body ?? {};
      const expectedUser = process.env.ADMIN_USERNAME ?? "admin";
      const expectedPass = process.env.LUCIRA_CREDS_CAPI;
      if (!expectedPass) {
        return reply.code(500).send({ error: "server_misconfigured" });
      }
      if (username !== expectedUser || password !== expectedPass) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      return reply.send({ token: expectedPass });
    }
  );

  app.get<{ Querystring: { range?: string; from?: string; to?: string } }>(
    "/admin/api/stats",
    async (req, reply) => {
      if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;

      const range = parseRange(req.query);
      const rangedConversions = applyRange(conversionsCol, range);

      const [
        visitorsTotal,
        conversionsTotal,
        metaOk,
        googleOk,
        metaFailing,
        googleFailing,
      ] = await Promise.all([
        visitorsCol.count().get(),
        rangedConversions.count().get(),
        applyRange(conversionsCol, range)
          .where("meta_capi.status", "==", "success")
          .count()
          .get(),
        applyRange(conversionsCol, range)
          .where("google_ads.status", "==", "success")
          .count()
          .get(),
        conversionsCol.where("meta_capi.status", "in", BAD_STATUSES).count().get(),
        conversionsCol.where("google_ads.status", "in", BAD_STATUSES).count().get(),
      ]);

      const total = conversionsTotal.data().count;
      const metaOkCount = metaOk.data().count;
      const googleOkCount = googleOk.data().count;

      return reply.send({
        range: {
          label: range.label,
          from: range.from?.toDate().toISOString() ?? null,
          to: range.to?.toDate().toISOString() ?? null,
        },
        visitors: {
          total: visitorsTotal.data().count,
        },
        conversions: {
          total,
          meta_success: metaOkCount,
          google_success: googleOkCount,
          meta_match_rate: total > 0 ? +(metaOkCount / total).toFixed(3) : 0,
          google_match_rate: total > 0 ? +(googleOkCount / total).toFixed(3) : 0,
        },
        backlog: {
          meta_pending_or_failed: metaFailing.data().count,
          google_pending_or_failed: googleFailing.data().count,
        },
      });
    }
  );

  // Analytics page: totals, status counts, per-store and per-day breakdowns
  // for sales whose sale date (event_time) falls in the range.
  app.get<{
    Querystring: { range?: string; from?: string; to?: string; channel?: string; store?: string };
  }>("/admin/api/analytics", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const range = parseIstSaleRange(req.query);
    let q: FirebaseFirestore.Query = conversionsCol;
    if (range.from) q = q.where("event_time", ">=", Timestamp.fromDate(range.from));
    if (range.to) q = q.where("event_time", "<", Timestamp.fromDate(range.to));
    const snap = await q.orderBy("event_time", "desc").limit(ANALYTICS_MAX_ROWS).get();

    const channel = req.query.channel === "online" || req.query.channel === "offline"
      ? (req.query.channel as Channel)
      : undefined;
    const summary = summarizeConversions(
      snap.docs.map((d) => d.data() as ConversionLog),
      { channel, store: req.query.store || undefined }
    );
    return reply.send({
      range: { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
      truncated: snap.size === ANALYTICS_MAX_ROWS,
      ...summary,
    });
  });

  /**
   * "Resend stuck" in the admin UI. Requeues every stuck sale that can be sent
   * now (see lib/requeue.ts — e.g. after adding Meta/Google credentials or
   * switching Google live), then runs one retry sweep so the first batch goes
   * out right away; the 5-minute sweep sends the rest. Sales that already
   * succeeded or failed for a permanent reason are never re-sent.
   * ?dry_run=1 only counts.
   */
  app.post<{ Querystring: { dry_run?: string } }>("/admin/api/sync-now", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const dryRun = req.query.dry_run === "1";
    const requeue = await requeueStuck({ dryRun });
    const sweep = dryRun ? null : await sweepRetries();
    req.log.info({ requeue: { ...requeue, sample: undefined }, sweep }, "admin resend stuck");
    return reply.send({ ...requeue, sweep });
  });

  app.get<{
    Querystring: { status?: string; limit?: string; range?: string; from?: string; to?: string };
  }>("/admin/api/conversions", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;

    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const range = parseRange(req.query);
    let q: FirebaseFirestore.Query = conversionsCol;

    // Status filter matches if either sender is in that state.
    const statusFilter: Record<string, SendStatus[]> = {
      pending: ["pending"],
      retrying: ["retrying"],
      failed: ["failed"],
      validated: ["validated"],
      unsent: BAD_STATUSES,
    };
    const statuses = statusFilter[req.query.status ?? ""];
    if (statuses) {
      q = q.where(
        Filter.or(
          Filter.where("meta_capi.status", "in", statuses),
          Filter.where("google_ads.status", "in", statuses)
        )
      );
    }
    q = applyRange(q, range).orderBy("created_at", "desc").limit(limit);

    const snap = await q.get();
      const items = snap.docs.map((d) => {
        const log = d.data() as ConversionLog;
        return {
          order_id: log.order_id,
          source: log.source,
          store_name: log.store_name,
          matched_by: log.match?.matched_by ?? null,
          amount: log.order_amount,
          currency: log.currency,
          created_at: log.created_at?.toDate().toISOString(),
          meta_status: log.meta_capi?.status,
          meta_retries: log.meta_capi?.retries,
          google_status: log.google_ads?.status,
          google_retries: log.google_ads?.retries,
          has_gclid: Boolean(log.gclid),
          has_gbraid: Boolean(log.gbraid),
          has_wbraid: Boolean(log.wbraid),
          has_fbc: Boolean(log.fbc),
        };
      });
      return reply.send({ items, count: items.length });
    }
  );

  app.get<{ Params: { orderId: string } }>(
    "/admin/api/conversions/:orderId",
    async (req, reply) => {
      if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;

      const log = await getConversion(req.params.orderId);
      if (!log) return reply.code(404).send({ error: "not_found" });

      return reply.send({
        ...log,
        created_at: log.created_at?.toDate().toISOString(),
        updated_at: log.updated_at?.toDate().toISOString(),
        event_time: log.event_time?.toDate().toISOString(),
        match: log.match
          ? {
              ...log.match,
              meta_click_at: log.match.meta_click_at?.toDate().toISOString(),
              google_click_at: log.match.google_click_at?.toDate().toISOString(),
            }
          : undefined,
        meta_capi: serializeSender(log.meta_capi),
        google_ads: serializeSender(log.google_ads),
      });
    }
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/conversions/:orderId/retry",
    async (req, reply) => {
      if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;

      const log = await getConversion(req.params.orderId);
      if (!log) return reply.code(404).send({ error: "not_found" });

      void dispatchConversion(req.params.orderId).catch((err) => {
        req.log.error({ err, orderId: req.params.orderId }, "manual retry failed");
      });
      return reply.send({ accepted: true });
    }
  );

  app.get<{
    Querystring: { search?: string; range?: string; from?: string; to?: string; limit?: string };
  }>("/admin/api/visitors", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;

    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const search = (req.query.search ?? "").trim();

    let q: FirebaseFirestore.Query = visitorsCol;

    if (search) {
      // Exact-match search: hash the raw input the same way identify does, so
      // the stored hash lines up. Three auto-detected shapes: email (contains
      // @), phone (digits with optional +), or a plain string treated as the
      // Shopify customer id. No composite index is needed for an equality +
      // single orderBy on the same collection.
      if (search.includes("@")) {
        const h = hashEmail(search);
        if (!h) return reply.send({ items: [], count: 0, matched: "email_invalid" });
        q = q.where("email_hash", "==", h);
      } else if (/^[+\d\s-]+$/.test(search)) {
        const h = hashPhoneForMeta(search);
        if (!h) return reply.send({ items: [], count: 0, matched: "phone_invalid" });
        q = q.where("phone_meta", "==", h);
      } else {
        q = q.where("shopify_customer_id", "==", search);
      }
      q = q.limit(limit);
    } else {
      const range = parseRange(req.query);
      if (range.from) q = q.where("last_seen_at", ">=", range.from);
      if (range.to) q = q.where("last_seen_at", "<=", range.to);
      q = q.orderBy("last_seen_at", "desc").limit(limit);
    }

    const snap = await q.get();
    const items = snap.docs.map((d) => serializeVisitor(d.id, d.data() as Visitor));
    return reply.send({ items, count: items.length });
  });

  app.get<{ Params: { key: string } }>(
    "/admin/api/visitors/:key",
    async (req, reply) => {
      if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
      const snap = await visitorsCol.doc(req.params.key).get();
      if (!snap.exists) return reply.code(404).send({ error: "not_found" });
      return reply.send(serializeVisitor(snap.id, snap.data() as Visitor));
    }
  );

  // Preview an existing conversion row — exact payloads that would reach
  // Meta + Google. Purely read-only, zero network. For engineer debugging
  // and demos: "here's what we WOULD send for this sale."
  app.get<{ Params: { orderId: string } }>(
    "/admin/api/conversions/:orderId/preview",
    async (req, reply) => {
      if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
      const log = await getConversion(req.params.orderId);
      if (!log) return reply.code(404).send({ error: "not_found" });
      return reply.send(previewPayloads(log, { simulated: false }));
    }
  );

  // Preview a HYPOTHETICAL sale against an existing visitor. Lets you
  // demo the end-to-end payload before OrnaVerse credentials arrive:
  // "if this visitor buys ₹X at store Y right now, this is exactly what
  //  Meta and Google receive." No Firestore writes, no network calls.
  app.get<{
    Params: { key: string };
    Querystring: { amount?: string; currency?: string; store?: string };
  }>("/admin/api/visitors/:key/preview", async (req, reply) => {
    if (!requireBearer(req, reply, "LUCIRA_CREDS_CAPI")) return;
    const snap = await visitorsCol.doc(req.params.key).get();
    if (!snap.exists) return reply.code(404).send({ error: "not_found" });
    const visitor = snap.data() as Visitor;
    const amount = Number(req.query.amount || 50000);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "invalid_amount" });
    }
    const sale: SaleInput = {
      sale_id: `preview-${Date.now()}`,
      amount,
      currency: (req.query.currency || "INR").toUpperCase(),
      event_time: new Date(),
      phone: visitor.raw_phone,
      email: visitor.raw_email,
      first_name: visitor.raw_first_name,
      last_name: visitor.raw_last_name,
      zip: visitor.raw_zip,
      city: visitor.raw_city,
      state: visitor.raw_state,
      country: visitor.raw_country,
      store_name: req.query.store || undefined,
    };
    const log: ConversionLog = {
      ...buildConversion(sale, "ornaverse_offline", { visitor, key: snap.id, matched_by: "phone" }),
      created_at: Timestamp.now(),
      updated_at: Timestamp.now(),
    };
    return reply.send({ sale, ...previewPayloads(log, { simulated: true }) });
  });
}

function previewPayloads(log: ConversionLog, opts: { simulated: boolean }) {
  const testCode = process.env.META_TEST_EVENT_CODE || undefined;
  const metaPayload = buildMetaPayload(log, testCode);
  const metaErr = metaPreflightError(log);
  const pixelId = process.env.META_PIXEL_ID || "<META_PIXEL_ID-not-set>";
  const metaVersion = process.env.META_API_VERSION || "v20.0";

  const gcfg = googleConfig();
  const googleErr = googlePreflightError(log);
  const googleSection = gcfg
    ? {
        // Same constant the sender posts to, so the preview can't drift from reality.
        endpoint: GOOGLE_INGEST_URL,
        config_present: true,
        preflight_error: googleErr,
        would_be_sent: !googleErr,
        payload: buildGooglePayload(log, gcfg),
      }
    : {
        endpoint: null,
        config_present: false,
        preflight_error: "google_config_missing",
        would_be_sent: false,
        payload: null,
      };

  return {
    simulated: opts.simulated,
    order_id: log.order_id,
    source: log.source,
    event_time: log.event_time.toDate().toISOString(),
    action_source: log.action_source,
    meta: {
      endpoint: `https://graph.facebook.com/${metaVersion}/${pixelId}/events`,
      preflight_error: metaErr,
      would_be_sent: !metaErr,
      payload: metaPayload,
    },
    google: googleSection,
  };
}

function iso(t?: Timestamp): string | null {
  return t?.toDate().toISOString() ?? null;
}

function serializeClick(c?: MetaClick | GoogleClick) {
  if (!c) return null;
  return { ...c, captured_at: iso(c.captured_at) };
}

function serializeVisitor(key: string, v: Visitor) {
  return {
    key,
    key_prefix: key.slice(0, 10),
    // Raw values for admin display
    phone: v.raw_phone ?? null,
    email: v.raw_email ?? null,
    first_name: v.raw_first_name ?? null,
    last_name: v.raw_last_name ?? null,
    zip: v.raw_zip ?? null,
    city: v.raw_city ?? null,
    state: v.raw_state ?? null,
    country: v.raw_country ?? null,
    shopify_customer_id: v.shopify_customer_id ?? null,
    user_id: v.user_id ?? null,
    dob: v.raw_dob ?? null,
    gender: v.raw_gender ?? null,
    // Click IDs: first + last per platform; click_mode says which one is sent.
    click_mode: clickMode(),
    meta_click: {
      first: serializeClick(v.click_ids?.meta?.first),
      last: serializeClick(v.click_ids?.meta?.last),
    },
    google_click: {
      first: serializeClick(v.click_ids?.google?.first),
      last: serializeClick(v.click_ids?.google?.last),
    },
    fbp: v.fbp ?? null,
    fbp_captured_at: iso(v.fbp_captured_at),
    gcl_au: v.gcl_au ?? null,
    ga_client_id: v.ga_client_id ?? null,
    external_id: v.external_id ?? null,
    external_id_source: v.external_id_source ?? null,
    // Cookie / device
    lcid: v.lcid ?? null,
    cookie_ids: v.cookie_ids ?? [],
    client_ip: v.client_ip_address ?? null,
    client_user_agent: v.client_user_agent ?? null,
    geo: v.geo ?? null,
    // Behavioral
    touchpoints: v.touchpoints ?? [],
    first_seen_at: v.first_seen_at?.toDate().toISOString() ?? null,
    last_seen_at: v.last_seen_at?.toDate().toISOString() ?? null,
    consent: v.consent
      ? {
          marketing: v.consent.marketing,
          version: v.consent.version,
          ad_user_data: v.consent.ad_user_data ?? null,
          ad_personalization: v.consent.ad_personalization ?? null,
          timestamp: v.consent.timestamp?.toDate().toISOString() ?? null,
        }
      : null,
    // Hashes (muted — for engineer debugging/dedup verification)
    hashes: {
      phone_meta: v.phone_meta ?? null,
      phone_google: v.phone_google ?? null,
      email: v.email_hash ?? null,
      first_name: v.first_name_hash ?? null,
      last_name: v.last_name_hash ?? null,
      zip: v.zip_hash ?? null,
      city: v.city_hash ?? null,
      state: v.state_hash ?? null,
      country: v.country_hash ?? null,
    },
  };
}
