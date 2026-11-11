import type { ConversionLog, SendStatus } from "./firestore.js";

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
