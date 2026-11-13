import type { SaleInput } from "../lib/matcher.js";
import {
  getOrnaverseToken,
  joinPhone,
  ornaverseConfigured,
  parseOrnaverseDate,
  splitPartyName,
} from "./ornaverse.js";

/**
 * OrnaVerse CRM customer-visit importer (store foot-fall).
 *
 * Reads `/Services/CRM/CustomerVisits/List`, keeps only visit_type = 1
 * (confirmed "Store Walkin" in the retrieve response — the only type whose
 * `source` field we've seen set to "Store Walkin"). Maps to a SaleInput with
 * amount 0; the downstream buildConversion / dispatcher tags them
 * `event_type: "store_visit"` and routes to a separate Google Ads Conversion
 * Action. Meta is skipped (store visits have no Meta equivalent).
 *
 * sale_id is prefixed `visit-` so visit ids can never collide with POS or
 * marketplace transaction_ids in the shared conversions_log collection.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
// CustomerVisits default order is id ASC, so we reverse-page from the end.
// Capped tight: 15 pages × 100 = 1,500 newest walk-ins ≈ 4-5 months at current
// rate, more than enough to cover the 30-day rescan window. Larger values made
// the Cloud Run request hang beyond its 5-min budget on first run.
const MAX_PAGES = 15;

/** Only confirmed showroom walk-ins — "Store Walkin" per CRM `source` field. */
const WALKIN_VISIT_TYPE = 1;

/** The subset of CRM.CustomerVisitsRow we read. All optional on the wire. */
export interface CustomerVisitRow {
  id?: number;
  date?: string;
  visit_type?: number;
  customer_type?: number;
  customer_id?: number;
  mobile?: string;
  email?: string;
  customer_name?: string;
  mailing_name?: string;
  company_code?: string;
  company_name?: string;
}

interface ListResponse {
  Entities?: CustomerVisitRow[];
  TotalCount?: number;
  Skip?: number;
  Take?: number;
  Error?: { Code?: string; Message?: string };
}

export async function fetchCustomerVisitsPage(
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ListResponse> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/Services/CRM/CustomerVisits/List`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ornaverse_visits_list_failed:${res.status}`);
  const json = (await res.json()) as ListResponse;
  if (json.Error?.Code) {
    throw new Error(`ornaverse_visits_list_error:${json.Error.Code}:${json.Error.Message ?? ""}`);
  }
  return json;
}

/** Map a CustomerVisits row to our SaleInput (amount 0 — this is not a sale). */
export function mapVisitRow(row: CustomerVisitRow): SaleInput | null {
  if (!row.id) return null;
  const eventMs = parseOrnaverseDate(row.date);
  if (eventMs == null) return null;
  // Need at least one match key (phone or email) — a visit we can't tie to a
  // visitor can't be attributed to an ad campaign.
  const phone = joinPhone(undefined, row.mobile);
  if (!phone && !row.email) return null;
  const { first, last } = splitPartyName(row.customer_name || row.mailing_name);
  return {
    sale_id: `visit-${row.id}`,
    amount: 0,
    currency: "INR",
    event_time: new Date(eventMs),
    phone,
    email: row.email || undefined,
    first_name: first,
    last_name: last,
    country: "IN",
    store_name: row.company_code ? `Walk-in (${row.company_code})` : "Walk-in",
  };
}

/**
 * Pull walk-in visits whose `date` falls in [from, to). The default List
 * order is ascending by id; we page from the end (newest first) by using
 * TotalCount so we can stop as soon as a page falls before `from`.
 */
export async function fetchOrnaverseVisits(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<SaleInput[]> {
  return (await fetchOrnaverseVisitsDetailed(from, to, fetchImpl)).visits;
}

export async function fetchOrnaverseVisitsDetailed(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<{ visits: SaleInput[]; capped: boolean }> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: SaleInput[] = [];

  // Discover TotalCount so we can page backwards from the newest row.
  const head = await fetchCustomerVisitsPage(token, { Skip: 0, Take: 1, EqualityFilter: { visit_type: WALKIN_VISIT_TYPE } }, fetchImpl);
  const total = head.TotalCount ?? 0;
  if (total === 0) return { visits: [], capped: false };

  // Walk newest-first by Skip-based reverse paging. On tenants where default
  // order is ascending by id, pages near the end hold the newest records.
  for (let page = 0; page < MAX_PAGES; page++) {
    const skipFromEnd = page * PAGE_SIZE + PAGE_SIZE;
    const skip = Math.max(0, total - skipFromEnd);
    const take = Math.min(PAGE_SIZE, total - skip);
    if (take <= 0) return { visits: out, capped: false };
    const body: Record<string, unknown> = {
      Skip: skip,
      Take: take,
      EqualityFilter: { visit_type: WALKIN_VISIT_TYPE },
    };
    const resp = await fetchCustomerVisitsPage(token, body, fetchImpl);
    const rows = (resp.Entities ?? []).slice().reverse();
    if (rows.length === 0) return { visits: out, capped: false };

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      // Belt-and-suspenders: if the server ignored the EqualityFilter, drop
      // anything that isn't a walk-in.
      if (row.visit_type !== WALKIN_VISIT_TYPE) continue;
      const docMs = parseOrnaverseDate(row.date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapVisitRow(row);
      if (sale) out.push(sale);
    }
    if (oldestOnPageMs <= fromMs) return { visits: out, capped: false };
    if (skip === 0) return { visits: out, capped: false };
  }
  return { visits: out, capped: true };
}
