import type { SaleInput, SaleItem } from "../lib/matcher.js";
import {
  fetchInvoicePage,
  getOrnaverseToken,
  joinPhone,
  mapInvoiceRow,
  ornaverseConfigured,
  parseOrnaverseDate,
  postedStatuses,
  splitPartyName,
  type InvoiceRow,
} from "./ornaverse.js";

/**
 * POS Invoice importer with order-date enrichment.
 *
 * Why this exists: an advance order sits in POS/Order for weeks before the
 * Invoice is generated at delivery. The Invoice's document_date is the
 * invoice generation date — the wrong signal for Smart Bidding, which wants
 * the moment the customer committed. We want the Order's document_date
 * whenever a prior Order exists, and the Invoice's document_date for pure
 * RTS walk-in sales (no prior Order).
 *
 * How it works:
 *   1. Page through POS/Invoice/List (same as the baseline importer)
 *   2. For every in-window invoice, POS/Invoice/Retrieve to get line_items
 *   3. Pull line_item.ref_transaction_id — a positive non-placeholder value
 *      is the parent POS Order's transaction_id
 *   4. POS/Order/Retrieve that Order (cached per sync run — multiple line
 *      items can share the same Order) to read its document_date + items
 *   5. Build SaleInput with order date when available, else invoice date
 *
 * sale_id uses the Invoice transaction_id (prefix `inv-`) so one invoice
 * = one Firestore row = one Google Ads conversion. We never send Orders
 * separately — Orders are read-only metadata used to correct the event_time.
 *
 * Cost vs baseline: 1 Invoice/Retrieve per in-window invoice + 1 Order/Retrieve
 * per unique parent Order. Concurrency-limited to protect OrnaVerse.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** OrnaVerse often leaves ref_transaction_id as 1 on line items that are NOT
 *  linked to a real Order (placeholder / default). Real Order ids are much
 *  higher. We treat 1 as "no link" to avoid bogus Retrieve calls. */
const MIN_REAL_ORDER_ID = 2;
/** How many Invoice/Retrieve + Order/Retrieve calls can be in flight at once. */
const RETRIEVE_CONCURRENCY = 8;

/** Local rate-limited concurrent runner. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface InvoiceRetrieveResponse {
  Entity?: {
    transaction_id?: number;
    document_date?: string;
    line_items?: Array<Record<string, unknown>>;
  };
  Error?: { Code?: string; Message?: string };
}

interface OrderRetrieveResponse {
  Entity?: {
    transaction_id?: number;
    document_date?: string;
    line_items?: Array<Record<string, unknown>>;
  };
  Error?: { Code?: string; Message?: string };
}

async function postJson(path: string, body: unknown, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path}:${res.status}`);
  return res.json();
}

/** Line item fields we care about for display (same shape as the Orders importer). */
function extractItems(lineItems: Array<Record<string, unknown>>): SaleItem[] {
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" && v !== "NA" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return lineItems.map((li) => ({
    type_name: str(li.type_name),
    metal_name: str(li.metal_name),
    karat_name: str(li.karat_name),
    item_name: str(li.item_name),
    pieces: num(li.pieces),
    amount: num(li.net_amount),
  }));
}

/**
 * Given an invoice's line_items, return the first non-placeholder
 * ref_transaction_id — that's the parent POS Order id. null when none linked
 * (RTS walk-in sale invoiced directly).
 */
export function pickParentOrderId(lineItems: Array<Record<string, unknown>>): number | null {
  for (const li of lineItems) {
    const v = li.ref_transaction_id;
    if (typeof v === "number" && v >= MIN_REAL_ORDER_ID) return v;
  }
  return null;
}

async function retrieveInvoice(
  token: string,
  id: number,
  fetchImpl: typeof fetch
): Promise<InvoiceRetrieveResponse["Entity"] | null> {
  try {
    const r = (await postJson("/Services/POS/Invoice/Retrieve", { EntityId: id }, token, fetchImpl)) as InvoiceRetrieveResponse;
    return r.Entity ?? null;
  } catch {
    return null;
  }
}

async function retrieveOrder(
  token: string,
  id: number,
  fetchImpl: typeof fetch
): Promise<OrderRetrieveResponse["Entity"] | null> {
  try {
    const r = (await postJson("/Services/POS/Order/Retrieve", { EntityId: id }, token, fetchImpl)) as OrderRetrieveResponse;
    return r.Entity ?? null;
  } catch {
    return null;
  }
}

/** Returns the parent Order's document_date + items, or null if no parent. */
export async function resolveParentOrder(
  token: string,
  invoiceId: number,
  orderCache: Map<number, { dateMs: number | null; items: SaleItem[] }>,
  fetchImpl: typeof fetch = fetch
): Promise<{ dateMs: number | null; items: SaleItem[]; orderId: number } | null> {
  const inv = await retrieveInvoice(token, invoiceId, fetchImpl);
  const lineItems = inv?.line_items ?? [];
  const parentId = pickParentOrderId(lineItems);
  if (parentId == null) return null;
  let cached = orderCache.get(parentId);
  if (!cached) {
    const order = await retrieveOrder(token, parentId, fetchImpl);
    const dateMs = parseOrnaverseDate(order?.document_date);
    const items = order ? extractItems(order.line_items ?? []) : [];
    cached = { dateMs, items };
    orderCache.set(parentId, cached);
  }
  return { ...cached, orderId: parentId };
}

export interface SmartImporterResult {
  sales: SaleInput[];
  capped: boolean;
  /** For observability / debugging: how many invoices had their date overridden by a parent Order. */
  overridden: number;
  /** Invoices where a parent Order was referenced but the lookup failed (silent fallback to invoice date). */
  lookup_failed: number;
  /** Unique invoice ids whose Order date overrode the invoice date (for spot-checking). */
  sample_overrides: number[];
}

export async function fetchOrnaversePosInvoiceSmart(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<SmartImporterResult> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const allowedStatuses = postedStatuses();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const statusList = [...allowedStatuses];
  const statusFilter = statusList.length === 1 ? statusList[0] : statusList;

  // Phase 1: collect in-window invoice rows via paginated List (reuses baseline helper).
  const windowInvoices: InvoiceRow[] = [];
  let capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await fetchInvoicePage(
      token,
      { Skip: page * PAGE_SIZE, Take: PAGE_SIZE, EqualityFilter: { document_status: statusFilter } },
      fetchImpl
    );
    const rows = resp.Entities ?? [];
    if (rows.length === 0) { capped = false; break; }
    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      if (row.document_status == null || !allowedStatuses.has(row.document_status)) continue;
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      windowInvoices.push(row);
    }
    if (oldestOnPageMs <= fromMs) { capped = false; break; }
    if (rows.length < PAGE_SIZE) { capped = false; break; }
    if (page === MAX_PAGES - 1) capped = true;
  }

  // Phase 2: resolve parent-order date for each in-window invoice, concurrency-limited.
  const orderCache = new Map<number, { dateMs: number | null; items: SaleItem[] }>();
  let overridden = 0;
  let lookupFailed = 0;
  const sampleOverrides: number[] = [];

  const enriched = await mapLimit(windowInvoices, RETRIEVE_CONCURRENCY, async (row) => {
    const sale = mapInvoiceRow(row);
    if (!sale) return null;
    if (!row.transaction_id) return sale;
    // Try to find parent Order.
    try {
      const parent = await resolveParentOrder(token, row.transaction_id, orderCache, fetchImpl);
      if (parent?.dateMs != null) {
        sale.event_time = new Date(parent.dateMs);
        overridden++;
        if (sampleOverrides.length < 5) sampleOverrides.push(row.transaction_id);
      } else if (parent && parent.dateMs == null) {
        // Parent found but no usable date — fall back to invoice date, log.
        lookupFailed++;
      }
      if (parent && parent.items.length) sale.items = parent.items;
    } catch {
      lookupFailed++;
    }
    // sale_id stays as mapInvoiceRow set it (String(transaction_id), no prefix).
    // Matches historical records from the baseline importer, so Firestore sees
    // the same doc id and keepNewSales dedup works correctly.
    return sale;
  });

  const sales = enriched.filter((s): s is SaleInput => s != null);
  return { sales, capped, overridden, lookup_failed: lookupFailed, sample_overrides: sampleOverrides };
}
