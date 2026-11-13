import type { ConversionItem, ConversionLog, SendStatus } from "./firestore.js";

/**
 * Admin analytics: totals, status counts and breakdowns over the conversions
 * in a date range. Pure (no Firestore) so it is easy to test; the route loads
 * the rows and passes them in.
 */

export type Channel = "offline" | "online";

export interface AnalyticsFilters {
  channel?: Channel;
  store?: string;
}

type StatusCounts = Record<SendStatus | "none", number>;

interface Bucket {
  orders: number;
  value: number;
  matched: number;
  with_click: number;
}

export interface AnalyticsSummary {
  totals: Bucket & { match_rate: number; click_rate: number; avg_order_value: number };
  google: StatusCounts;
  meta: StatusCounts;
  matched_by: { phone: number; email: number; none: number };
  ad_click: { google: number; meta: number; none: number };
  channel: Record<Channel, number>;
  by_store: Array<Bucket & { store: string }>;
  by_day: Array<Bucket & { date: string }>;
  /** Every store in the range (ignores the store filter), for the filter dropdown. */
  stores: string[];
}

/** First + last click timestamps (ms since epoch) from the matched visitor. */
export interface AttributionClicks {
  first_google_at?: number;
  last_google_at?: number;
  first_meta_at?: number;
  last_meta_at?: number;
}

/** Per-source result in one attribution model. */
export interface AttributionCell {
  /** Fractional share of orders in the range, 0..1. */
  share: number;
  /** Order count attributed to this source. Fractional for linear. */
  count: number;
}

export interface AttributionModelResult {
  google: AttributionCell;
  meta: AttributionCell;
  direct: AttributionCell;
}

export interface AttributionSummary {
  first_click: AttributionModelResult;
  last_click: AttributionModelResult;
  linear: AttributionModelResult;
  total_orders: number;
}

export type AttributedSource = "google" | "meta" | "direct";

/** Per-order attribution under each model, for the orders-detail table. */
export interface AttributedOrder {
  order_id: string;
  event_time_ms: number;
  store: string;
  amount: number;
  currency: string;
  first_click: AttributedSource;
  last_click: AttributedSource;
  /** Dominant source under linear (>50% share). "google" on G↔M tie; "direct" when no clicks. */
  linear: AttributedSource;
  /** Full linear split, 0..1 each, sum ≈ 1. */
  linear_split: { google: number; meta: number; direct: number };
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const NO_STORE = "(no store)";

/** Store bills and CSV rows are offline; website orders (Shopify, later) are online. */
export function channelOf(log: Pick<ConversionLog, "action_source">): Channel {
  return log.action_source === "website" ? "online" : "offline";
}

/** Calendar day of the sale in India time, e.g. "2026-11-11". */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const hasGoogleClick = (l: ConversionLog) => Boolean(l.gclid || l.gbraid || l.wbraid);
const hasMetaClick = (l: ConversionLog) => Boolean(l.fbc);

function emptyStatuses(): StatusCounts {
  return { pending: 0, success: 0, failed: 0, retrying: 0, validated: 0, none: 0 };
}

function emptyBucket(): Bucket {
  return { orders: 0, value: 0, matched: 0, with_click: 0 };
}

function add(b: Bucket, l: ConversionLog): void {
  b.orders++;
  b.value += Number(l.order_amount) || 0;
  if (l.match?.matched_by) b.matched++;
  if (hasGoogleClick(l) || hasMetaClick(l)) b.with_click++;
}

const rate = (n: number, d: number) => (d > 0 ? +(n / d).toFixed(3) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeConversions(
  logs: ConversionLog[],
  filters: AnalyticsFilters = {}
): AnalyticsSummary {
  const stores = [...new Set(logs.map((l) => l.store_name || NO_STORE))].sort();
  const rows = logs.filter(
    (l) =>
      (!filters.channel || channelOf(l) === filters.channel) &&
      (!filters.store || (l.store_name || NO_STORE) === filters.store)
  );

  const totals = emptyBucket();
  const google = emptyStatuses();
  const meta = emptyStatuses();
  const matched_by = { phone: 0, email: 0, none: 0 };
  const ad_click = { google: 0, meta: 0, none: 0 };
  const channel: Record<Channel, number> = { offline: 0, online: 0 };
  const byStore = new Map<string, Bucket>();
  const byDay = new Map<string, Bucket>();

  for (const l of rows) {
    add(totals, l);
    google[l.google_ads?.status ?? "none"]++;
    meta[l.meta_capi?.status ?? "none"]++;
    matched_by[l.match?.matched_by ?? "none"]++;
    if (hasGoogleClick(l)) ad_click.google++;
    if (hasMetaClick(l)) ad_click.meta++;
    if (!hasGoogleClick(l) && !hasMetaClick(l)) ad_click.none++;
    channel[channelOf(l)]++;

    const store = l.store_name || NO_STORE;
    if (!byStore.has(store)) byStore.set(store, emptyBucket());
    add(byStore.get(store)!, l);

    const day = istDay(l.event_time.toMillis());
    if (!byDay.has(day)) byDay.set(day, emptyBucket());
    add(byDay.get(day)!, l);
  }

  const roundBucket = <T extends Bucket>(b: T): T => ({ ...b, value: round2(b.value) });
  return {
    totals: {
      ...roundBucket(totals),
      match_rate: rate(totals.matched, totals.orders),
      click_rate: rate(totals.with_click, totals.orders),
      avg_order_value: totals.orders ? round2(totals.value / totals.orders) : 0,
    },
    google,
    meta,
    matched_by,
    ad_click,
    channel,
    by_store: [...byStore]
      .map(([store, b]) => roundBucket({ store, ...b }))
      .sort((a, b) => b.value - a.value),
    by_day: [...byDay]
      .map(([date, b]) => roundBucket({ date, ...b }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    stores,
  };
}

function emptyShare(): { google: number; meta: number; direct: number } {
  return { google: 0, meta: 0, direct: 0 };
}

/** Attribution outcome for a single conversion under all 3 models. */
interface OrderAttribution {
  first_click: AttributedSource;
  last_click: AttributedSource;
  linear: AttributedSource;
  linear_split: { google: number; meta: number; direct: number };
}

/** Compute every model's verdict on one order. Centralises the attribution rules. */
function attributeOrder(clicks: AttributionClicks | undefined): OrderAttribution {
  const fg = clicks?.first_google_at;
  const lg = clicks?.last_google_at;
  const fm = clicks?.first_meta_at;
  const lm = clicks?.last_meta_at;

  // First-click: earliest known touch wins, Google on tie (stable).
  const firstG = fg ?? lg;
  const firstM = fm ?? lm;
  let first_click: AttributedSource;
  if (firstG == null && firstM == null) first_click = "direct";
  else if (firstM == null || (firstG != null && firstG <= firstM)) first_click = "google";
  else first_click = "meta";

  // Last-click: latest known touch wins, Meta on tie (stable).
  const lastG = lg ?? fg;
  const lastM = lm ?? fm;
  let last_click: AttributedSource;
  if (lastG == null && lastM == null) last_click = "direct";
  else if (lastG == null || (lastM != null && lastM >= lastG)) last_click = "meta";
  else last_click = "google";

  // Linear: unique touches (dedupe same-click first=last), split 1/N.
  const gTouches = new Set<number>();
  if (fg != null) gTouches.add(fg);
  if (lg != null) gTouches.add(lg);
  const mTouches = new Set<number>();
  if (fm != null) mTouches.add(fm);
  if (lm != null) mTouches.add(lm);
  const total = gTouches.size + mTouches.size;
  const linear_split =
    total === 0
      ? { google: 0, meta: 0, direct: 1 }
      : { google: gTouches.size / total, meta: mTouches.size / total, direct: 0 };
  let linear: AttributedSource;
  if (linear_split.direct === 1) linear = "direct";
  else if (linear_split.google >= linear_split.meta) linear = "google";
  else linear = "meta";

  return { first_click, last_click, linear, linear_split };
}

function matchesFilters(log: ConversionLog, filters: AnalyticsFilters): boolean {
  return (
    (!filters.channel || channelOf(log) === filters.channel) &&
    (!filters.store || (log.store_name || NO_STORE) === filters.store)
  );
}

/**
 * For each conversion, award 1.0 of credit across platforms per attribution model.
 * First/last-click = winner takes all; linear splits across unique touchpoints.
 * No touchpoints → full credit to "direct". Shares are expressed as a fraction
 * of total orders (0..1).
 */
export function summarizeAttribution(
  items: Array<{ log: ConversionLog; clicks?: AttributionClicks }>,
  filters: AnalyticsFilters = {}
): AttributionSummary {
  const rows = items.filter((it) => matchesFilters(it.log, filters));

  const first_click = emptyShare();
  const last_click = emptyShare();
  const linear = emptyShare();

  for (const { clicks } of rows) {
    const a = attributeOrder(clicks);
    first_click[a.first_click]++;
    last_click[a.last_click]++;
    linear.google += a.linear_split.google;
    linear.meta += a.linear_split.meta;
    linear.direct += a.linear_split.direct;
  }

  const cell = (count: number): AttributionCell => ({
    share: rate(count, rows.length),
    count: round2(count),
  });
  const normalize = (s: { google: number; meta: number; direct: number }): AttributionModelResult => ({
    google: cell(s.google),
    meta: cell(s.meta),
    direct: cell(s.direct),
  });

  return {
    first_click: normalize(first_click),
    last_click: normalize(last_click),
    linear: normalize(linear),
    total_orders: rows.length,
  };
}

export interface VisitorAttributionSummary {
  first_click: AttributionModelResult;
  last_click: AttributionModelResult;
  linear: AttributionModelResult;
  total_visitors: number;
}

/**
 * Attribution across visitors (not orders). Each visitor is awarded 1.0 of
 * credit per model; linear splits across unique touchpoints. Unlike the
 * order version this does NOT apply a click-window filter — a visitor may
 * never have bought, so there is no sale time to anchor eligibility to.
 */
export function summarizeVisitorAttribution(
  visitors: Array<{ clicks?: AttributionClicks }>
): VisitorAttributionSummary {
  const first_click = emptyShare();
  const last_click = emptyShare();
  const linear = emptyShare();

  for (const { clicks } of visitors) {
    const a = attributeOrder(clicks);
    first_click[a.first_click]++;
    last_click[a.last_click]++;
    linear.google += a.linear_split.google;
    linear.meta += a.linear_split.meta;
    linear.direct += a.linear_split.direct;
  }

  const n = visitors.length;
  const cell = (count: number): AttributionCell => ({
    share: rate(count, n),
    count: round2(count),
  });
  const normalize = (s: { google: number; meta: number; direct: number }): AttributionModelResult => ({
    google: cell(s.google),
    meta: cell(s.meta),
    direct: cell(s.direct),
  });

  return {
    first_click: normalize(first_click),
    last_click: normalize(last_click),
    linear: normalize(linear),
    total_visitors: n,
  };
}

export interface FunnelStage {
  count: number;
  /** Fraction of the previous stage that reached this one (0..1). 1 for stage 1. */
  rate_from_prev: number;
  /** Fraction of stage 1 that reached this one (0..1). */
  rate_from_top: number;
}

/** One buyer who completed the full Visitor → Store Visit → Buyer journey. */
export interface FunnelBuyer {
  visitor_key: string;
  first_seen_ms: number;
  store_visit_ms: number;
  purchase_ms: number;
  store: string;
  amount: number;
  currency: string;
  items: ConversionItem[];
  days_visitor_to_store: number;
  days_store_to_buy: number;
}

export interface FunnelSummary {
  visitors: FunnelStage;
  store_visits: FunnelStage;
  buyers: FunnelStage;
  /** Avg days between stages, for buyers who completed the journey. */
  avg_days_visitor_to_store: number;
  avg_days_store_to_buy: number;
  /** Full buyer journeys for the detail table. */
  buyers_detail: FunnelBuyer[];
}

interface FunnelVisitor {
  key: string;
  first_seen_ms: number;
}

interface FunnelConversion {
  log: ConversionLog;
  event_ms: number;
  visitor_key: string;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Strict 3-stage funnel — a person counts at each stage only if they went
 * through the previous one. "Then" means time order: first_seen → store visit
 * → purchase, where each later event happens AFTER the earlier one for that
 * same visitor.
 */
export function summarizeFunnel(
  visitors: FunnelVisitor[],
  conversions: FunnelConversion[]
): FunnelSummary {
  // Group the conversions we care about by visitor_key.
  const byKey = new Map<string, { visits: number[]; purchases: FunnelConversion[] }>();
  for (const c of conversions) {
    if (!c.visitor_key) continue;
    let g = byKey.get(c.visitor_key);
    if (!g) {
      g = { visits: [], purchases: [] };
      byKey.set(c.visitor_key, g);
    }
    if (c.log.event_type === "store_visit") g.visits.push(c.event_ms);
    else if ((c.log.event_type ?? "purchase") === "purchase") g.purchases.push(c);
  }

  const visitorCount = visitors.length;
  let storeVisitCount = 0;
  let buyerCount = 0;
  const buyers: FunnelBuyer[] = [];
  let sumDaysVS = 0;
  let sumDaysSB = 0;

  for (const v of visitors) {
    const g = byKey.get(v.key);
    if (!g) continue;
    // Earliest store visit AFTER first_seen.
    const svAfter = g.visits.filter((ms) => ms >= v.first_seen_ms).sort((a, b) => a - b)[0];
    if (svAfter == null) continue;
    storeVisitCount++;
    // Earliest purchase AFTER that store visit.
    const buy = g.purchases.filter((p) => p.event_ms >= svAfter).sort((a, b) => a.event_ms - b.event_ms)[0];
    if (!buy) continue;
    buyerCount++;
    const dVS = (svAfter - v.first_seen_ms) / DAY_MS;
    const dSB = (buy.event_ms - svAfter) / DAY_MS;
    sumDaysVS += dVS;
    sumDaysSB += dSB;
    buyers.push({
      visitor_key: v.key,
      first_seen_ms: v.first_seen_ms,
      store_visit_ms: svAfter,
      purchase_ms: buy.event_ms,
      store: buy.log.store_name || "",
      amount: Number(buy.log.order_amount) || 0,
      currency: buy.log.currency,
      items: buy.log.items ?? [],
      days_visitor_to_store: round2(dVS),
      days_store_to_buy: round2(dSB),
    });
  }

  const stage = (count: number, prev: number): FunnelStage => ({
    count,
    rate_from_prev: rate(count, prev),
    rate_from_top: rate(count, visitorCount),
  });

  // Newest buyers first — most useful for admin scanning.
  buyers.sort((a, b) => b.purchase_ms - a.purchase_ms);

  return {
    visitors: stage(visitorCount, visitorCount),
    store_visits: stage(storeVisitCount, visitorCount),
    buyers: stage(buyerCount, storeVisitCount),
    avg_days_visitor_to_store: buyerCount ? round2(sumDaysVS / buyerCount) : 0,
    avg_days_store_to_buy: buyerCount ? round2(sumDaysSB / buyerCount) : 0,
    buyers_detail: buyers,
  };
}

/** Per-order attribution for the detail table under the attribution summary. */
export function attributeOrders(
  items: Array<{ log: ConversionLog; clicks?: AttributionClicks }>,
  filters: AnalyticsFilters = {}
): AttributedOrder[] {
  return items
    .filter((it) => matchesFilters(it.log, filters))
    .map(({ log, clicks }) => {
      const a = attributeOrder(clicks);
      return {
        order_id: log.order_id,
        event_time_ms: log.event_time.toMillis(),
        store: log.store_name || NO_STORE,
        amount: Number(log.order_amount) || 0,
        currency: log.currency,
        first_click: a.first_click,
        last_click: a.last_click,
        linear: a.linear,
        linear_split: {
          google: round2(a.linear_split.google),
          meta: round2(a.linear_split.meta),
          direct: round2(a.linear_split.direct),
        },
      };
    })
    .sort((a, b) => b.event_time_ms - a.event_time_ms);
}
