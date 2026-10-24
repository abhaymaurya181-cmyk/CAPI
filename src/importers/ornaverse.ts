import type { SaleInput } from "../lib/matcher.js";

/**
 * OrnaVerse POS importer (pull path).
 *
 * How it fits: `src/lib/sync.ts` calls `fetchOrnaverseSales(from, to)` once
 * per sync cycle with the window to pull. We own token acquisition,
 * pagination, mapping and status filtering. The matcher takes it from there.
 *
 * Auth: OAuth2 client_credentials against `${ORNAVERSE_API_BASE}/connect/token`.
 * Pagination: Skip/Take, no Sort — any `Sort` clause 500s on Lucira's tenant.
 * The server's default order is transaction_id DESC (= document_date DESC in
 * practice), so Skip paging gives us newest-first naturally. We stop as soon
 * as a page's oldest document_date predates `from`.
 * Status filter: pushed server-side via EqualityFilter when configured, with
 * a client-side belt-and-suspenders check in case the server ignores it.
 * Deduplication: handled upstream by `conversions_log/<sale_id>`; we just
 * surface every row inside the window.
 */

/** Token cache, module-scoped — one process = one refresh cadence. */
let cachedToken: { value: string; expires_at_ms: number } | null = null;

/** Reset the cache (tests). */
export function _resetTokenCache(): void {
  cachedToken = null;
}

export function ornaverseConfigured(): boolean {
  return Boolean(
    process.env.ORNAVERSE_API_BASE &&
      process.env.ORNAVERSE_CLIENT_ID &&
      process.env.ORNAVERSE_CLIENT_SECRET
  );
}

/** Fetch (or reuse) a bearer token. Refreshes 60s before expiry. */
export async function getOrnaverseToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at_ms - 60_000 > now) {
    return cachedToken.value;
  }
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const clientId = process.env.ORNAVERSE_CLIENT_ID!;
  const clientSecret = process.env.ORNAVERSE_CLIENT_SECRET!;
  // OrnaVerse (OpenIddict) rejects token requests without a scope. Lucira's
  // tenant accepts "openid"; other tenants may use a different value, so make
  // it env-overridable without a redeploy.
  const scope = process.env.ORNAVERSE_SCOPE || "openid";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });
  const res = await fetchImpl(`${base}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`ornaverse_token_failed:${res.status}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  if (!json.access_token) throw new Error("ornaverse_token_missing_in_response");
  cachedToken = {
    value: json.access_token,
    expires_at_ms: now + (json.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

/** The subset of POS.InvoiceRow we actually read. All optional on the wire. */
export interface InvoiceRow {
  transaction_id?: number;
  document_no?: string;
  document_date?: string;
  document_status?: number;
  modification_date?: string;
  net_amount?: number;
  currency_id?: number;
  phone_code?: string;
  mobile?: string;
  email?: string;
  party_name?: string;
  shipping_city?: string;
  shipping_state?: string;
  shipping_pin_code?: string;
  mailing_name?: string;
  company_name?: string;
}

interface ListResponse {
  Entities?: InvoiceRow[];
  TotalCount?: number;
  Skip?: number;
  Take?: number;
  Error?: { Code?: string; Message?: string };
}

/** Fetch one page of invoices. Caller controls Skip/Take/filter. */
export async function fetchInvoicePage(
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ListResponse> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/Services/POS/Invoice/List`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ornaverse_list_failed:${res.status}`);
  }
  const json = (await res.json()) as ListResponse;
  if (json.Error?.Code) {
    throw new Error(`ornaverse_list_error:${json.Error.Code}:${json.Error.Message ?? ""}`);
  }
  return json;
}

/** Parse "YYYY-MM-DDTHH:mm:ss" (OrnaVerse serves naive IST) → ms epoch. */
export function parseOrnaverseDate(s: string | undefined): number | null {
  if (!s) return null;
  // Already has timezone offset? Trust it.
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  // Treat as IST (+05:30).
  const t = Date.parse(s + "+05:30");
  return Number.isFinite(t) ? t : null;
}

/** Split "First Middle Last" into {first, last}. "Abhay" → first only. */
export function splitPartyName(raw: string | undefined): { first?: string; last?: string } {
  const parts = (raw || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

/** phone_code + mobile → E.164-ish (hash normalizer runs again downstream). */
export function joinPhone(code: string | undefined, mobile: string | undefined): string | undefined {
  const m = (mobile || "").replace(/\D/g, "");
  if (!m) return undefined;
  const c = (code || "").replace(/\D/g, "");
  if (!c) return m;
  return "+" + c + m;
}

/** Map an InvoiceRow to our neutral SaleInput. */
export function mapInvoiceRow(row: InvoiceRow): SaleInput | null {
  if (!row.transaction_id) return null;
  const eventMs = parseOrnaverseDate(row.document_date);
  if (eventMs == null) return null;
  const { first, last } = splitPartyName(row.party_name);
  return {
    sale_id: String(row.transaction_id),
    amount: Number(row.net_amount ?? 0),
    currency: "INR",
    event_time: new Date(eventMs),
    phone: joinPhone(row.phone_code, row.mobile),
    email: row.email || undefined,
    first_name: first,
    last_name: last,
    zip: row.shipping_pin_code || undefined,
    city: row.shipping_city || undefined,
    state: row.shipping_state || undefined,
    country: "IN",
    store_name: row.mailing_name || row.company_name || undefined,
  };
}

/** POSTED document_status codes to keep. Env override lets us tune without a redeploy. */
function postedStatuses(): Set<number> | null {
  const raw = process.env.ORNAVERSE_POSTED_STATUSES;
  if (!raw) return null;
  const nums = raw.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  return nums.length ? new Set(nums) : null;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // Safety: 5,000 rows per sync.

/**
 * Pull every POSTED invoice whose document_date falls in [from, to).
 * Walks Skip/Take pages in the server's default newest-first order and
 * stops when the oldest row on a page is older than `from`.
 */
export async function fetchOrnaverseSales(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch
): Promise<SaleInput[]> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const token = await getOrnaverseToken(fetchImpl);
  const allowedStatuses = postedStatuses();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: SaleInput[] = [];

  // Server-side status filter when configured. EqualityFilter accepts a
  // scalar (=) or an array (IN) per docs; we send scalar when only one
  // code is allowed, array when multiple.
  const statusFilter = (() => {
    if (!allowedStatuses || allowedStatuses.size === 0) return undefined;
    const arr = [...allowedStatuses];
    return arr.length === 1 ? arr[0] : arr;
  })();

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      Skip: page * PAGE_SIZE,
      Take: PAGE_SIZE,
    };
    if (statusFilter !== undefined) {
      body.EqualityFilter = { document_status: statusFilter };
    }
    const resp = await fetchInvoicePage(token, body, fetchImpl);
    const rows = resp.Entities ?? [];
    if (rows.length === 0) break;

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      // Belt-and-suspenders in case the server ignored the EqualityFilter.
      if (allowedStatuses && row.document_status != null && !allowedStatuses.has(row.document_status)) {
        continue;
      }
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapInvoiceRow(row);
      if (sale) out.push(sale);
    }
    // Everything after this page is older than `from` — nothing more to see.
    if (oldestOnPageMs <= fromMs) break;
    // Short page = end of data.
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}
