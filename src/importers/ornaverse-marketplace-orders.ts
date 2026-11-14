import type { SaleInput } from "../lib/matcher.js";
import {
  getOrnaverseToken,
  joinPhone,
  ornaverseConfigured,
  parseOrnaverseDate,
  splitPartyName,
} from "./ornaverse.js";

/**
 * MarketPlace Order importer — placeholder feed so the admin dashboard shows
 * online orders the moment Shopify creates them, not weeks later when the
 * Invoice posts.
 *
 * Row semantics:
 *   - sale_id prefix `mp-ord-` so Order ids can't collide with the Invoice
 *     importer's `mp-<transaction_id>` rows.
 *   - pending_invoice: true on every row written by this importer. The
 *     dispatcher and matcher both see this flag and skip the Google / Meta
 *     send. Dashboards show the row with a "Pending invoice" chip.
 *   - When the Invoice later posts, the Invoice importer will find a
 *     matching row by shopify_order_id (= MarketPlace.Order.marketplace_order_id)
 *     and delete this placeholder; the Invoice row then takes over and sends
 *     to the ad platforms normally.
 *
 * Status filter: document_status=1 (Posted) AND is_confirmed=true — the latter
 * is OrnaVerse's "customer committed, we're fulfilling" flag. Together they
 * keep draft / cancelled orders out.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface MarketPlaceOrderRow {
  transaction_id?: number;
  document_no?: string;
  document_date?: string;
  document_status?: number;
  creation_date?: string;
  net_amount?: number;
  currency_id?: number;
  phone_code?: string;
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
  /** Shopify order id. Dedup key with the Invoice feed. */
  marketplace_order_id?: number;
  marketplace_order_no?: string;
  external_customer_id?: number;
  is_confirmed?: boolean;
}

interface ListResponse {
  Entities?: MarketPlaceOrderRow[];
  TotalCount?: number;
  Error?: { Code?: string; Message?: string };
}

export async function fetchMarketPlaceOrderPage(
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ListResponse> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/Services/MarketPlace/Order/List`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ornaverse_mp_order_list_failed:${res.status}`);
  const json = (await res.json()) as ListResponse;
  if (json.Error?.Code) {
    throw new Error(`ornaverse_mp_order_list_error:${json.Error.Code}:${json.Error.Message ?? ""}`);
  }
  return json;
}

export function mapMarketPlaceOrderRow(row: MarketPlaceOrderRow): SaleInput | null {
  if (!row.transaction_id) return null;
  const eventMs = parseOrnaverseDate(row.document_date);
  if (eventMs == null) return null;
  const amount = Number(row.net_amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const { first, last } = splitPartyName(row.party_name);
  return {
    sale_id: `mp-ord-${row.transaction_id}`,
    amount,
    currency: "INR",
    event_time: new Date(eventMs),
    phone: joinPhone(row.phone_code, row.mobile),
    email: row.email || undefined,
    first_name: first,
    last_name: last,
    zip: row.shipping_pin_code || row.billing_pin_code || undefined,
    city: row.shipping_city || row.billing_city || undefined,
    state: row.shipping_state || row.billing_state || undefined,
    country: "IN",
    store_name: row.company_code ? `Online (${row.company_code})` : "Online",
    shopify_order_id: row.marketplace_order_id,
    pending_invoice: true,
  };
}

export async function fetchMarketPlaceOrders(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<SaleInput[]> {
  return (await fetchMarketPlaceOrdersDetailed(from, to, fetchImpl)).sales;
}

export async function fetchMarketPlaceOrdersDetailed(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<{ sales: SaleInput[]; capped: boolean }> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: SaleInput[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await fetchMarketPlaceOrderPage(
      token,
      {
        Skip: page * PAGE_SIZE,
        Take: PAGE_SIZE,
        EqualityFilter: { document_status: 1, is_confirmed: true },
      },
      fetchImpl
    );
    const rows = resp.Entities ?? [];
    if (rows.length === 0) return { sales: out, capped: false };

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      if (row.document_status !== 1 || row.is_confirmed !== true) continue;
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapMarketPlaceOrderRow(row);
      if (sale) out.push(sale);
    }
    if (oldestOnPageMs <= fromMs) return { sales: out, capped: false };
    if (rows.length < PAGE_SIZE) return { sales: out, capped: false };
  }
  return { sales: out, capped: true };
}
