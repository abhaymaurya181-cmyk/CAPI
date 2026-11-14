import type { SaleInput } from "../lib/matcher.js";
import {
  getOrnaverseToken,
  joinPhone,
  ornaverseConfigured,
  parseOrnaverseDate,
  postedStatuses,
  splitPartyName,
} from "./ornaverse.js";

/**
 * OrnaVerse MarketPlace importer (online orders).
 *
 * Same shape as the POS importer in `./ornaverse.ts`, but reads
 * `/Services/MarketPlace/Invoice/List` — the posted invoices that OrnaVerse
 * creates from online channels (Shopify etc.). We tag these with
 * `action_source: "website"` so the dispatcher skips Meta + Google (Shopify's
 * own pixel already reports them); they're dashboard-only.
 *
 * sale_id is prefixed `mp-` so marketplace transaction_ids can never collide
 * with POS transaction_ids in the same `conversions_log` collection.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** The subset of MarketPlace.InvoiceRow we actually read. All optional on the wire. */
export interface MarketPlaceInvoiceRow {
  transaction_id?: number;
  document_no?: string;
  document_date?: string;
  document_status?: number;
  modification_date?: string;
  creation_date?: string;
  net_amount?: number;
  currency_id?: number;
  phone_code?: string;
  mobile?: string;
  party_name?: string;
  mailing_name?: string;
  shipping_city?: string;
  shipping_state?: string;
  shipping_pin_code?: string;
  billing_city?: string;
  billing_state?: string;
  billing_pin_code?: string;
  company_code?: string;
  marketplace_order_no?: string;
  marketplace_order_id?: number;
  external_customer_id?: number;
}

interface ListResponse {
  Entities?: MarketPlaceInvoiceRow[];
  TotalCount?: number;
  Skip?: number;
  Take?: number;
  Error?: { Code?: string; Message?: string };
}

export async function fetchMarketplaceInvoicePage(
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ListResponse> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/Services/MarketPlace/Invoice/List`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ornaverse_marketplace_list_failed:${res.status}`);
  const json = (await res.json()) as ListResponse;
  if (json.Error?.Code) {
    throw new Error(`ornaverse_marketplace_list_error:${json.Error.Code}:${json.Error.Message ?? ""}`);
  }
  return json;
}

/** Map a MarketPlace invoice row to our neutral SaleInput. */
export function mapMarketplaceRow(row: MarketPlaceInvoiceRow): SaleInput | null {
  if (!row.transaction_id) return null;
  const eventMs = parseOrnaverseDate(row.document_date);
  if (eventMs == null) return null;
  const amount = Number(row.net_amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const { first, last } = splitPartyName(row.party_name);
  return {
    // `mp-` namespaces marketplace transaction_ids away from POS ones.
    sale_id: `mp-${row.transaction_id}`,
    amount,
    currency: "INR",
    event_time: new Date(eventMs),
    phone: joinPhone(row.phone_code, row.mobile),
    // No email field in the MarketPlace/Invoice list payload today.
    first_name: first,
    last_name: last,
    zip: row.shipping_pin_code || row.billing_pin_code || undefined,
    city: row.shipping_city || row.billing_city || undefined,
    state: row.shipping_state || row.billing_state || undefined,
    country: "IN",
    // No physical store for marketplace orders; the company_code (e.g. "N18")
    // is the fulfilment location, useful to filter online fulfilment by site.
    store_name: row.company_code ? `Online (${row.company_code})` : "Online",
    // Carried through so the sync layer can delete a matching `mp-ord-*`
    // placeholder once the Invoice posts.
    shopify_order_id: row.marketplace_order_id,
  };
}

export async function fetchOrnaverseMarketplaceSales(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<SaleInput[]> {
  return (await fetchOrnaverseMarketplaceSalesDetailed(from, to, fetchImpl)).sales;
}

/** Same as the other importer: returns `capped` when MAX_PAGES stops paging early. */
export async function fetchOrnaverseMarketplaceSalesDetailed(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<{ sales: SaleInput[]; capped: boolean }> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const allowedStatuses = postedStatuses();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: SaleInput[] = [];
  const statusList = [...allowedStatuses];
  const statusFilter = statusList.length === 1 ? statusList[0] : statusList;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      Skip: page * PAGE_SIZE,
      Take: PAGE_SIZE,
      EqualityFilter: { document_status: statusFilter },
    };
    const resp = await fetchMarketplaceInvoicePage(token, body, fetchImpl);
    const rows = resp.Entities ?? [];
    if (rows.length === 0) return { sales: out, capped: false };

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      if (row.document_status == null || !allowedStatuses.has(row.document_status)) continue;
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapMarketplaceRow(row);
      if (sale) out.push(sale);
    }
    if (oldestOnPageMs <= fromMs) return { sales: out, capped: false };
    if (rows.length < PAGE_SIZE) return { sales: out, capped: false };
  }
  return { sales: out, capped: true };
}
