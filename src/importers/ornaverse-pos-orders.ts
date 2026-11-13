import type { SaleInput } from "../lib/matcher.js";
import {
  getOrnaverseToken,
  joinPhone,
  ornaverseConfigured,
  parseOrnaverseDate,
  splitPartyName,
} from "./ornaverse.js";

/**
 * OrnaVerse POS Order importer — the new primary feed for store sales.
 *
 * Previously we pulled POS/Invoice/List, which reports sale time = invoice
 * date. For advance orders (customer places a bespoke order on day 1,
 * invoice is generated weeks later on delivery), that credits the wrong
 * date to the ad platform. Pulling Order instead reports the moment the
 * customer committed, which is what Smart Bidding wants.
 *
 * Statuses observed (needs Lucira to confirm anything beyond these):
 *   1 — Placed (order exists, invoice not yet created)
 *   2 — Fulfilled (invoice has been issued against this order)
 *
 * Dedup against the existing Invoice feed:
 *   - Backfill (first run, no cursor): status=1 only. status=2 orders
 *     already have invoice-sourced records in conversions_log with
 *     invoice date; pulling them would be a second conversion for the
 *     same sale.
 *   - Ongoing (cursor exists): status={1,2}. Catches RTS walk-in sales
 *     where the order is created and invoiced the same day (status jumps
 *     straight to 2). When a status=1 order later moves to 2, our
 *     `keepNewSales` dedup by sale_id means we never re-send.
 *
 * sale_id is prefixed `po-` so POS Order ids can never collide with raw
 * invoice ids or marketplace / visit ids in the shared conversions_log.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** The subset of POS.OrderRow we actually read. All optional on the wire. */
export interface OrderRow {
  transaction_id?: number;
  document_no?: string;
  document_date?: string;
  document_status?: number;
  modification_date?: string;
  creation_date?: string;
  delivery_date?: string;
  net_amount?: number;
  currency_id?: number;
  phone_code?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  party_name?: string;
  mailing_name?: string;
  shipping_city?: string;
  shipping_state?: string;
  shipping_pin_code?: string;
  billing_city?: string;
  billing_state?: string;
  billing_pin_code?: string;
  company_code?: string;
  company_name?: string;
  receipt_amount?: number;
  balance_amount?: number;
  external_customer_id?: number;
}

interface ListResponse {
  Entities?: OrderRow[];
  TotalCount?: number;
  Skip?: number;
  Take?: number;
  Error?: { Code?: string; Message?: string };
}

export async function fetchPosOrderPage(
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ListResponse> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/Services/POS/Order/List`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ornaverse_order_list_failed:${res.status}`);
  const json = (await res.json()) as ListResponse;
  if (json.Error?.Code) {
    throw new Error(`ornaverse_order_list_error:${json.Error.Code}:${json.Error.Message ?? ""}`);
  }
  return json;
}

/** Map a POS/Order row to our neutral SaleInput. */
export function mapOrderRow(row: OrderRow): SaleInput | null {
  if (!row.transaction_id) return null;
  const eventMs = parseOrnaverseDate(row.document_date);
  if (eventMs == null) return null;
  const amount = Number(row.net_amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const { first, last } = splitPartyName(row.party_name);
  return {
    sale_id: `po-${row.transaction_id}`,
    amount,
    currency: "INR",
    event_time: new Date(eventMs),
    phone: joinPhone(row.phone_code, row.mobile || row.phone),
    email: row.email || undefined,
    first_name: first,
    last_name: last,
    zip: row.shipping_pin_code || row.billing_pin_code || undefined,
    city: row.shipping_city || row.billing_city || undefined,
    state: row.shipping_state || row.billing_state || undefined,
    country: "IN",
    store_name: row.mailing_name || row.company_name || undefined,
  };
}

/** Status 1 = Placed; Status 2 = Fulfilled. Env override reserved for future. */
export function allowedOrderStatuses(backfill: boolean): Set<number> {
  const raw = process.env.ORNAVERSE_ORDER_STATUSES;
  if (raw) {
    const nums = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    if (nums.length) return new Set(nums);
  }
  // Default: backfill skips status=2 to avoid double-count with existing
  // invoice-sourced records; ongoing pulls both so RTS same-day sales land.
  return backfill ? new Set([1]) : new Set([1, 2]);
}

export async function fetchOrnaversePosOrders(
  from: Date,
  to: Date,
  opts: { backfill?: boolean } = {},
  fetchImpl: typeof fetch = fetch
): Promise<SaleInput[]> {
  return (await fetchOrnaversePosOrdersDetailed(from, to, opts, fetchImpl)).sales;
}

export async function fetchOrnaversePosOrdersDetailed(
  from: Date,
  to: Date,
  opts: { backfill?: boolean } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ sales: SaleInput[]; capped: boolean }> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const allowed = allowedOrderStatuses(Boolean(opts.backfill));
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: SaleInput[] = [];

  const statusList = [...allowed];
  const statusFilter = statusList.length === 1 ? statusList[0] : statusList;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      Skip: page * PAGE_SIZE,
      Take: PAGE_SIZE,
      EqualityFilter: { document_status: statusFilter },
    };
    const resp = await fetchPosOrderPage(token, body, fetchImpl);
    const rows = resp.Entities ?? [];
    if (rows.length === 0) return { sales: out, capped: false };

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      if (row.document_status == null || !allowed.has(row.document_status)) continue;
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapOrderRow(row);
      if (sale) out.push(sale);
    }
    if (oldestOnPageMs <= fromMs) return { sales: out, capped: false };
    if (rows.length < PAGE_SIZE) return { sales: out, capped: false };
  }
  return { sales: out, capped: true };
}
