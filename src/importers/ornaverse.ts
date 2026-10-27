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

/** Every OrnaVerse call gives up after this, so a hung server can't stall a sync or webhook. */
const REQUEST_TIMEOUT_MS = 15_000;

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  // net_amount is the full bill: return credit / old gold shows up as a
  // payment mode in receipt_details, not as a deduction. ₹0 bills (100%
  // discount, free coins) are not purchases worth reporting.
  const amount = Number(row.net_amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const { first, last } = splitPartyName(row.party_name);
  return {
    sale_id: String(row.transaction_id),
    amount,
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

/** Lucira's live tenant: 1 = posted. 2 (returns/cancels) must never be sent as a sale. */
const DEFAULT_POSTED_STATUSES = [1];

/**
 * document_status codes to keep. Env override lets us tune without a redeploy.
 * Unset, empty or unparseable → posted only (1), never "everything": importing
 * returns/cancels as purchases would report fake sales to Meta/Google.
 * Only non-negative integers count, so "1," or "1, x" can't sneak in a 0/NaN.
 */
export function postedStatuses(): Set<number> {
  const raw = process.env.ORNAVERSE_POSTED_STATUSES ?? "";
  const nums = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  return new Set(nums.length ? nums : DEFAULT_POSTED_STATUSES);
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
  return (await fetchOrnaverseSalesDetailed(from, to, fetchImpl)).sales;
}

/**
 * Same as fetchOrnaverseSales, plus `capped`: true when the MAX_PAGES safety
 * limit stopped paging before reaching `from`, i.e. older bills in the window
 * were not read this time. Callers surface it instead of silently missing them.
 */
export async function fetchOrnaverseSalesDetailed(
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

  // Server-side status filter. EqualityFilter accepts a scalar (=) or an
  // array (IN) per docs; we send scalar when only one code is allowed.
  const statusList = [...allowedStatuses];
  const statusFilter = statusList.length === 1 ? statusList[0] : statusList;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      Skip: page * PAGE_SIZE,
      Take: PAGE_SIZE,
      EqualityFilter: { document_status: statusFilter },
    };
    const resp = await fetchInvoicePage(token, body, fetchImpl);
    const rows = resp.Entities ?? [];
    if (rows.length === 0) return { sales: out, capped: false };

    let oldestOnPageMs = Infinity;
    for (const row of rows) {
      // Belt-and-suspenders in case the server ignored the EqualityFilter.
      // A row without a status is dropped too: we can't prove it's a sale.
      if (row.document_status == null || !allowedStatuses.has(row.document_status)) {
        continue;
      }
      const docMs = parseOrnaverseDate(row.document_date);
      if (docMs != null) oldestOnPageMs = Math.min(oldestOnPageMs, docMs);
      if (docMs != null && (docMs < fromMs || docMs >= toMs)) continue;
      const sale = mapInvoiceRow(row);
      if (sale) out.push(sale);
    }
    // Everything after this page is older than `from` — nothing more to see.
    if (oldestOnPageMs <= fromMs) return { sales: out, capped: false };
    // Short page = end of data.
    if (rows.length < PAGE_SIZE) return { sales: out, capped: false };
  }
  // Every page was full and still inside the window when the limit hit.
  return { sales: out, capped: true };
}

/**
 * A bill id from an untrusted source (webhook body, admin input) → a positive
 * safe integer, or null. Rejects 0, negatives, decimals, exponents and junk so
 * nothing odd is ever sent to OrnaVerse.
 */
export function parseTransactionId(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9]\d{0,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export type RetrieveOutcome =
  | { kind: "sale"; sale: SaleInput }
  | {
      kind: "skipped";
      reason: "not_found" | "status_not_posted" | "unmappable" | "id_mismatch";
      document_status?: number;
    };

function postRetrieve(token: string, id: number, fetchImpl: typeof fetch): Promise<Response> {
  const base = process.env.ORNAVERSE_API_BASE!.replace(/\/+$/, "");
  // Serenity RetrieveRequest: { EntityId }. Read-only.
  return fetchImpl(`${base}/Services/POS/Invoice/Retrieve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ EntityId: id }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Fetch one bill by transaction_id (POS/Invoice/Retrieve) and turn it into a
 * sale, applying the same rules as the hourly pull: posted status only, must
 * map cleanly. Used by the webhook "doorbell": OrnaVerse says "bill X changed",
 * we read the current bill ourselves instead of trusting the webhook body.
 *
 * Throws on transport/auth/server errors so the caller can report a failure
 * (OrnaVerse then retries, and the hourly pull is the backstop). Returns
 * `skipped` for bills that exist but must not be sent.
 */
export async function retrieveOrnaverseSale(
  rawId: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<RetrieveOutcome> {
  if (!ornaverseConfigured()) throw new Error("ornaverse_not_configured");
  const id = parseTransactionId(rawId);
  if (id == null) throw new Error("ornaverse_bad_transaction_id");

  let res = await postRetrieve(await getOrnaverseToken(fetchImpl), id, fetchImpl);
  // Token revoked or expired early on their side: get a fresh one, try once more.
  if (res.status === 401) {
    _resetTokenCache();
    res = await postRetrieve(await getOrnaverseToken(fetchImpl), id, fetchImpl);
  }
  if (res.status === 404) return { kind: "skipped", reason: "not_found" };
  if (!res.ok) throw new Error(`ornaverse_retrieve_failed:${res.status}`);

  const json = (await res.json()) as { Entity?: InvoiceRow; Error?: { Code?: string; Message?: string } };
  if (json.Error?.Code) {
    if (/not.?found/i.test(`${json.Error.Code} ${json.Error.Message ?? ""}`)) {
      return { kind: "skipped", reason: "not_found" };
    }
    throw new Error(`ornaverse_retrieve_error:${json.Error.Code}`);
  }
  const row = json.Entity;
  if (!row) return { kind: "skipped", reason: "not_found" };
  // Never attach one customer's bill to another sale id.
  if (Number(row.transaction_id) !== id) return { kind: "skipped", reason: "id_mismatch" };
  if (row.document_status == null || !postedStatuses().has(row.document_status)) {
    return { kind: "skipped", reason: "status_not_posted", document_status: row.document_status };
  }
  const sale = mapInvoiceRow(row);
  if (!sale) return { kind: "skipped", reason: "unmappable" };
  return { kind: "sale", sale };
}
