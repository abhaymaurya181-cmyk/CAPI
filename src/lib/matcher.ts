import { Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  findVisitorCandidates,
  writeConversion,
  type ClickPair,
  type ConversionLog,
  type ConversionSource,
  type EventType,
  type MatchInfo,
  type Visitor,
  type VisitorMatch,
} from "./firestore.js";
import { hashIdentity, normalizeZipIndia } from "./hash.js";
import { clickMode, type ClickMode } from "./click-ids.js";
import { pendingSender } from "../senders/retry-policy.js";

/** One line item on a sale, display-only (admin UI). No PII. */
export interface SaleItem {
  /** Category, e.g. "Necklaces", "Earrings", "Rings". */
  type_name?: string;
  /** Metal, e.g. "Gold", "Platinum". */
  metal_name?: string;
  /** Karat, e.g. "14KT", "18KT". */
  karat_name?: string;
  /** Internal item name / SKU line, e.g. "Customer Order CON291". */
  item_name?: string;
  pieces?: number;
  amount?: number;
}

/** One offline sale, as any importer (CSV, OrnaVerse) hands it over. */
export interface SaleInput {
  sale_id: string;
  amount: number;
  currency: string;
  event_time: Date;
  phone?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  zip?: string;
  city?: string;
  state?: string;
  country?: string;
  store_name?: string;
  /** Line items for admin display; never sent to Meta / Google. */
  items?: SaleItem[];
}

const DAY_MS = 24 * 3600 * 1000;

/** How far back an ad click may be from the sale (Google's max click-through window). */
export function clickWindowMs(): number {
  const days = Number(process.env.CLICK_WINDOW_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 90) * DAY_MS;
}

/**
 * The click to credit for a sale: the CLICK_MODE one if it happened before
 * the sale and inside the window, else the other stored click if that one
 * qualifies, else none. A click after the sale cannot have caused it.
 */
export function pickEligibleClick<T extends { captured_at: Timestamp }>(
  pair: ClickPair<T> | undefined,
  mode: ClickMode,
  saleMs: number,
  windowMs: number
): { click: T; which: "first" | "last" } | null {
  if (!pair) return null;
  const order: Array<"first" | "last"> = mode === "first" ? ["first", "last"] : ["last", "first"];
  for (const which of order) {
    const click = pair[which];
    if (!click) continue;
    const at = click.captured_at.toMillis();
    if (at <= saleMs && saleMs - at <= windowMs) return { click, which };
  }
  return null;
}

type Platform = "meta" | "google";

/**
 * One person can have several visitor docs. Combine them into one match:
 * - per platform, the best eligible click across all docs (latest for
 *   CLICK_MODE=last, earliest for first; before the sale and in the window);
 * - every other field (fbp, IP, consent, external_id…) from the primary doc:
 *   the one supplying the most clicks, then a phone match over an email
 *   match, then the most recently seen.
 * No I/O; deterministic for the same input.
 */
export function combineCandidates(
  candidates: VisitorMatch[],
  mode: ClickMode,
  saleMs: number,
  windowMs: number
): VisitorMatch | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const best: Record<Platform, { cand: VisitorMatch; ms: number } | null> = { meta: null, google: null };
  for (const cand of candidates) {
    for (const p of ["meta", "google"] as const) {
      const pick = pickEligibleClick(cand.visitor.click_ids?.[p], mode, saleMs, windowMs);
      if (!pick) continue;
      const ms = pick.click.captured_at.toMillis();
      const cur = best[p];
      if (!cur || (mode === "first" ? ms < cur.ms : ms > cur.ms)) best[p] = { cand, ms };
    }
  }

  const clicksFrom = (c: VisitorMatch) => (best.meta?.cand === c ? 1 : 0) + (best.google?.cand === c ? 1 : 0);
  const seen = (c: VisitorMatch) => c.visitor.last_seen_at?.toMillis() ?? 0;
  const primary = [...candidates].sort(
    (a, b) =>
      clicksFrom(b) - clicksFrom(a) ||
      Number(b.matched_by === "phone") - Number(a.matched_by === "phone") ||
      seen(b) - seen(a)
  )[0];

  const merged = new Set<string>();
  const pairFor = (p: Platform) => {
    const src = best[p]?.cand;
    if (src && src !== primary) merged.add(src.key);
    return (src ?? primary).visitor.click_ids?.[p];
  };
  const click_ids = { meta: pairFor("meta"), google: pairFor("google") };

  return {
    key: primary.key,
    matched_by: primary.matched_by,
    visitor: { ...primary.visitor, click_ids },
    ...(merged.size ? { merged_keys: [...merged] } : {}),
  };
}

/** Sale → conversion log row (no I/O). `match` is the visitor lookup result. */
export function buildConversion(
  sale: SaleInput,
  source: ConversionSource,
  match: VisitorMatch | null,
  opts: {
    mode?: ClickMode;
    windowMs?: number;
    nowMs?: number;
    syncRunId?: string;
    action_source?: "website" | "physical_store";
    event_type?: EventType;
  } = {}
): Omit<ConversionLog, "created_at" | "updated_at"> {
  const mode = opts.mode ?? clickMode();
  const windowMs = opts.windowMs ?? clickWindowMs();
  const saleMs = sale.event_time.getTime();
  const visitor: Visitor | undefined = match?.visitor;

  const identity = hashIdentity({
    phone: sale.phone,
    email: sale.email,
    firstName: sale.first_name,
    lastName: sale.last_name,
    zip: sale.zip,
    city: sale.city,
    state: sale.state,
    country: sale.country,
  });

  const meta = pickEligibleClick(visitor?.click_ids?.meta, mode, saleMs, windowMs);
  const google = pickEligibleClick(visitor?.click_ids?.google, mode, saleMs, windowMs);

  const info: MatchInfo = {
    matched_by: match?.matched_by ?? null,
    visitor_key: match?.key,
    merged_visitor_keys: match?.merged_keys,
    click_mode: mode,
    meta_click: meta?.which,
    meta_click_at: meta?.click.captured_at,
    google_click: google?.which,
    google_click_at: google?.click.captured_at,
  };

  const country = (sale.country ?? "IN").trim();
  const action_source: "website" | "physical_store" = opts.action_source ?? "physical_store";
  const isWebsite = action_source === "website";
  const event_type = opts.event_type ?? "purchase";
  // Meta: skipped for website (Shopify client-side pixel already fires) and
  //       for Store Visit (no Meta equivalent event; the eventual sale fires).
  // Google: sent in both cases; dedupes server-vs-gtag by transactionId.
  const skipMeta = isWebsite || event_type === "store_visit";
  const skipGoogle = false;

  return {
    source,
    event_type,
    ...(sale.items && sale.items.length ? { items: sale.items } : {}),
    order_id: sale.sale_id,
    order_amount: sale.amount,
    currency: sale.currency,
    event_time: Timestamp.fromDate(sale.event_time),
    store_name: sale.store_name,
    sync_run_id: opts.syncRunId,
    match: info,
    phone_meta: identity.phone_meta,
    phone_google: identity.phone_google,
    email_hash: identity.email,
    email_google_hash: identity.email_google,
    first_name_hash: identity.first_name,
    last_name_hash: identity.last_name,
    zip_hash: identity.zip,
    city_hash: identity.city,
    state_hash: identity.state,
    country_hash: identity.country,
    dob_hash: visitor?.dob_hash,
    gender_hash: visitor?.gender_hash,
    external_id: visitor?.external_id,
    postal_code: normalizeZipIndia(sale.zip) ?? undefined,
    region_code: /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined,
    consent: visitor?.consent
      ? {
          ad_user_data: visitor.consent.ad_user_data,
          ad_personalization: visitor.consent.ad_personalization,
        }
      : undefined,
    gclid: google?.click.gclid,
    gbraid: google?.click.gbraid,
    wbraid: google?.click.wbraid,
    fbc: meta?.click.fbc,
    fbp: visitor?.fbp,
    client_ip_address: visitor?.client_ip_address,
    client_user_agent: visitor?.client_user_agent,
    action_source,
    ...(skipMeta ? {} : { meta_capi: pendingSender(opts.nowMs) }),
    ...(skipGoogle ? {} : { google_ads: pendingSender(opts.nowMs) }),
  };
}

export type IngestOutcome =
  | { kind: "written"; matched: boolean; withClick: boolean }
  | { kind: "duplicate" }
  | { kind: "invalid"; error: string };

/**
 * Validate, match and store one sale. A sale already in the log keeps any
 * sender that already succeeded (so it is never sent twice) and its
 * created_at; everything else is refreshed from the new data.
 * The caller dispatches written sales.
 */
export async function ingestSale(
  sale: SaleInput,
  source: ConversionSource,
  syncRunId?: string,
  action_source: "website" | "physical_store" = "physical_store",
  event_type: EventType = "purchase"
): Promise<IngestOutcome> {
  if (!sale.phone && !sale.email) return { kind: "invalid", error: "no_identifier" };
  if (Number.isNaN(sale.event_time.getTime())) return { kind: "invalid", error: "bad_event_time" };

  const existingSnap = await conversionsCol.doc(sale.sale_id).get();
  const existing = existingSnap.exists ? (existingSnap.data() as ConversionLog) : null;
  if (existing?.meta_capi?.status === "success" && existing?.google_ads?.status === "success") {
    return { kind: "duplicate" };
  }

  const identity = hashIdentity({ phone: sale.phone, email: sale.email });
  const candidates = await findVisitorCandidates({
    phone_meta: identity.phone_meta,
    email_hash: identity.email,
    email_google_hash: identity.email_google,
  });
  // Same mode + window for combining and for building, so the click chosen
  // across docs is exactly the one buildConversion sends.
  const mode = clickMode();
  const windowMs = clickWindowMs();
  const match = combineCandidates(candidates, mode, sale.event_time.getTime(), windowMs);

  const row = buildConversion(sale, source, match, { syncRunId, mode, windowMs, action_source, event_type });
  if (existing?.meta_capi?.status === "success") row.meta_capi = existing.meta_capi;
  if (existing?.google_ads?.status === "success") row.google_ads = existing.google_ads;

  await writeConversion(sale.sale_id, row, existing?.created_at);
  return {
    kind: "written",
    matched: match != null,
    withClick: Boolean(row.match?.meta_click || row.match?.google_click),
  };
}
