import { Timestamp } from "@google-cloud/firestore";
import {
  conversionsCol,
  db,
  deletePendingInvoicePlaceholders,
  syncRunsCol,
  syncStateCol,
  type ConversionSource,
  type SyncRun,
  type SyncState,
  type SyncTrigger,
} from "./firestore.js";
import { ingestSale, type SaleInput } from "./matcher.js";
import { dispatchConversion, mapLimit } from "../senders/dispatcher.js";
import {
  fetchOrnaverseSales,
  fetchOrnaverseSalesDetailed,
  ornaverseConfigured,
} from "../importers/ornaverse.js";
import {
  fetchOrnaverseMarketplaceSales,
  fetchOrnaverseMarketplaceSalesDetailed,
} from "../importers/ornaverse-marketplace.js";
import {
  fetchMarketPlaceOrders,
  fetchMarketPlaceOrdersDetailed,
} from "../importers/ornaverse-marketplace-orders.js";
import {
  fetchOrnaverseVisits,
  fetchOrnaverseVisitsDetailed,
} from "../importers/ornaverse-visits.js";
import {
  fetchOrnaversePosOrders,
  fetchOrnaversePosOrdersDetailed,
} from "../importers/ornaverse-pos-orders.js";
import { fetchOrnaversePosInvoiceSmart } from "../importers/ornaverse-pos-smart.js";
import type { EventType } from "./firestore.js";

const DISPATCH_CONCURRENCY = 10;
const MAX_STORED_FAILURES = 50;
// Re-read this much before the last cursor: late-entered POS sales still get
// picked up, and already-sent ones are skipped as duplicates.
const OVERLAP_MS = 60 * 60 * 1000;
// Every hourly pull also re-reads bills dated this many days back: Lucira
// staff occasionally backdate a bill (max 2–3 days) or post a draft later.
const DEFAULT_HOURLY_LOOKBACK_DAYS = 3;
// First ever run (no cursor yet) looks back this far.
const DEFAULT_INITIAL_LOOKBACK_DAYS = 7;
// A crashed run's lock expires after this.
const LOCK_MS = 15 * 60 * 1000;
// Daily re-scan looks back this many days by default. Must stay below Meta's
// 62-day limit for physical_store events, so it is capped at 60.
const DEFAULT_RESCAN_DAYS = 30;
const MAX_RESCAN_DAYS = 60;
// Firestore getAll batch size when checking which sales we already have.
const EXISTS_BATCH = 100;

export type ImportSummary = Pick<
  SyncRun,
  "fetched" | "processed" | "matched" | "matched_with_click" | "skipped_duplicate" | "failed" | "failures"
>;

/** Sale ids that already have a conversions_log record. */
async function existingSaleIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += EXISTS_BATCH) {
    const refs = unique.slice(i, i + EXISTS_BATCH).map((id) => conversionsCol.doc(id));
    if (refs.length === 0) continue;
    for (const snap of await db.getAll(...refs)) if (snap.exists) found.add(snap.id);
  }
  return found;
}

/**
 * Keep only sales we have never recorded, and drop repeats of the same id
 * within the batch. Pure, for tests.
 */
export function keepNewSales(sales: SaleInput[], existing: Set<string>): SaleInput[] {
  const seen = new Set<string>();
  return sales.filter((s) => {
    if (existing.has(s.sale_id) || seen.has(s.sale_id)) return false;
    seen.add(s.sale_id);
    return true;
  });
}

/** Ingest + dispatch a batch of sales and fill in the counts. */
async function importSales(
  sales: SaleInput[],
  source: ConversionSource,
  runId: string,
  opts: {
    onlyNew?: boolean;
    actionSource?: "website" | "physical_store";
    eventType?: EventType;
  } = {}
): Promise<ImportSummary> {
  const s: ImportSummary = {
    fetched: sales.length,
    processed: 0,
    matched: 0,
    matched_with_click: 0,
    skipped_duplicate: 0,
    failed: 0,
    failures: [],
  };
  // Re-scan: a sale we already recorded is left alone entirely. Its senders
  // are owned by dispatch + the retry sweep (incl. "gave up" states); touching
  // it here would re-send or reset retries every day.
  if (opts.onlyNew) {
    const fresh = keepNewSales(sales, await existingSaleIds(sales.map((x) => x.sale_id)));
    s.skipped_duplicate = sales.length - fresh.length;
    sales = fresh;
  }
  const written: string[] = [];
  const fail = (sale_id: string, error: string) => {
    s.failed++;
    if (s.failures.length < MAX_STORED_FAILURES) s.failures.push({ sale_id, error });
  };

  for (const sale of sales) {
    try {
      const out = await ingestSale(sale, source, runId, opts.actionSource, opts.eventType);
      if (out.kind === "duplicate") s.skipped_duplicate++;
      else if (out.kind === "invalid") fail(sale.sale_id, out.error);
      else {
        s.processed++;
        if (out.matched) s.matched++;
        if (out.withClick) s.matched_with_click++;
        written.push(sale.sale_id);
      }
    } catch (err) {
      fail(sale.sale_id, (err as Error).message);
    }
  }

  // Failures here are recorded per sender and picked up by the retry sweep.
  await mapLimit(written, DISPATCH_CONCURRENCY, (id) => dispatchConversion(id));
  return s;
}

function finalStatus(s: ImportSummary): SyncRun["status"] {
  if (s.failed === 0) return "ok";
  return s.processed + s.skipped_duplicate > 0 ? "partial" : "failed";
}

async function startRun(
  source: ConversionSource,
  trigger: SyncTrigger,
  window?: { from: Date; to: Date }
): Promise<FirebaseFirestore.DocumentReference> {
  const run: SyncRun = {
    source,
    trigger,
    status: "running",
    started_at: Timestamp.now(),
    window_from: window ? Timestamp.fromDate(window.from) : undefined,
    window_to: window ? Timestamp.fromDate(window.to) : undefined,
    fetched: 0,
    processed: 0,
    matched: 0,
    matched_with_click: 0,
    skipped_duplicate: 0,
    failed: 0,
    failures: [],
  };
  const ref = syncRunsCol.doc();
  await ref.set(run);
  return ref;
}

/** CSV upload: one sync run for the whole file. */
export async function runCsvImport(sales: SaleInput[]): Promise<SyncRun & { id: string }> {
  const ref = await startRun("csv_upload", "csv");
  const summary = await importSales(sales, "csv_upload", ref.id);
  const done = { status: finalStatus(summary), finished_at: Timestamp.now(), ...summary };
  await ref.update(done);
  return { ...((await ref.get()).data() as SyncRun), id: ref.id };
}

/** Take the per-source lock; false if another run holds it. */
async function acquireLock(source: string): Promise<boolean> {
  const ref = syncStateCol.doc(source);
  return db.runTransaction(async (tx) => {
    const state = (await tx.get(ref)).data() as SyncState | undefined;
    if (state?.locked_until && state.locked_until.toMillis() > Date.now()) return false;
    tx.set(ref, { locked_until: Timestamp.fromMillis(Date.now() + LOCK_MS) }, { merge: true });
    return true;
  });
}

/** Sale-time window for the next pull, from the stored cursor. */
export function nextWindow(
  state: SyncState | undefined,
  nowMs: number,
  initialLookbackDays = Number(process.env.ORNAVERSE_INITIAL_LOOKBACK_DAYS) || DEFAULT_INITIAL_LOOKBACK_DAYS,
  hourlyLookbackDays = hourlyLookback()
): { from: Date; to: Date } {
  const last = state?.last_window_to?.toMillis();
  const from =
    last != null
      ? Math.min(last - OVERLAP_MS, nowMs - hourlyLookbackDays * 24 * 3600 * 1000)
      : nowMs - initialLookbackDays * 24 * 3600 * 1000;
  return { from: new Date(from), to: new Date(nowMs) };
}

/** ORNAVERSE_HOURLY_LOOKBACK_DAYS → whole days in [0, 7]; unset or invalid → 3. */
export function hourlyLookback(raw = process.env.ORNAVERSE_HOURLY_LOOKBACK_DAYS): number {
  const s = (raw ?? "").trim();
  if (!/^\d+$/.test(s)) return DEFAULT_HOURLY_LOOKBACK_DAYS;
  return Math.min(Number(s), 7);
}

/**
 * Scheduled / manual OrnaVerse pull. Every call leaves a sync_runs record,
 * including "skipped" when the importer is not configured or a run is
 * already going. The cursor only moves forward after a successful fetch.
 */
export async function runOrnaverseSync(trigger: SyncTrigger): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_offline";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  let ref: FirebaseFirestore.DocumentReference | undefined;
  try {
    const state = (await stateRef.get()).data() as SyncState | undefined;
    const window = nextWindow(state, Date.now());
    ref = await startRun(source, trigger, window);

    let sales: SaleInput[];
    try {
      // Smart importer: Invoice is primary, Order date overrides when linked.
      sales = (await fetchOrnaversePosInvoiceSmart(window.from, window.to)).sales;
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    // Only bills never recorded: the look-back re-reads days of bills every
    // hour, and re-ingesting one would reset its retries and send it again.
    const summary = await importSales(sales, source, ref.id, { onlyNew: true });
    await ref.update({ status: finalStatus(summary), finished_at: Timestamp.now(), ...summary });
    // Rows that failed to ingest are listed on the run; the cursor still
    // moves so one bad row cannot block the feed.
    await stateRef.set(
      { last_window_to: Timestamp.fromDate(window.to), last_run_id: ref.id },
      { merge: true }
    );
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/**
 * Scheduled / manual OrnaVerse MarketPlace pull (online orders).
 * Mirrors `runOrnaverseSync` but hits a different endpoint and tags every
 * conversion with `action_source: "website"`, which makes the dispatcher
 * skip Meta and Google (Shopify's pixel already reports these sales).
 */
export async function runOrnaverseMarketplaceSync(trigger: SyncTrigger): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_marketplace";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  try {
    const state = (await stateRef.get()).data() as SyncState | undefined;
    const window = nextWindow(state, Date.now());
    const ref = await startRun(source, trigger, window);

    let sales: SaleInput[];
    try {
      sales = await fetchOrnaverseMarketplaceSales(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(sales, source, ref.id, { onlyNew: true, actionSource: "website" });
    // Every real Invoice supersedes the MarketPlace Order placeholder — remove
    // them so the admin stops showing the row twice.
    const shopifyIds = sales.map((s) => s.shopify_order_id).filter((x): x is number => typeof x === "number");
    await deletePendingInvoicePlaceholders(shopifyIds);
    await ref.update({ status: finalStatus(summary), finished_at: Timestamp.now(), ...summary });
    await stateRef.set(
      { last_window_to: Timestamp.fromDate(window.to), last_run_id: ref.id },
      { merge: true }
    );
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** Daily safety re-scan for marketplace orders — same semantics as the POS rescan. */
export async function runOrnaverseMarketplaceRescan(): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_marketplace";
  const trigger: SyncTrigger = "rescan";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  try {
    const now = Date.now();
    const window = { from: new Date(now - rescanDays() * 24 * 3600 * 1000), to: new Date(now) };
    const ref = await startRun(source, trigger, window);

    let fetched: { sales: SaleInput[]; capped: boolean };
    try {
      fetched = await fetchOrnaverseMarketplaceSalesDetailed(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(fetched.sales, source, ref.id, { onlyNew: true, actionSource: "website" });
    const shopifyIds = fetched.sales.map((s) => s.shopify_order_id).filter((x): x is number => typeof x === "number");
    await deletePendingInvoicePlaceholders(shopifyIds);
    const status = fetched.capped && finalStatus(summary) === "ok" ? "partial" : finalStatus(summary);
    await ref.update({
      status,
      finished_at: Timestamp.now(),
      ...summary,
      ...(fetched.capped ? { error: "page_limit_reached" } : {}),
    });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/**
 * Scheduled / manual OrnaVerse MarketPlace Order pull — placeholders only.
 * Every row is written with pending_invoice:true so it shows on the dashboard
 * the moment the Shopify order lands in OrnaVerse. Google / Meta sends are
 * deferred until the Invoice posts, at which point the Invoice sync deletes
 * this placeholder and writes the real row.
 */
export async function runOrnaverseMarketplaceOrdersSync(trigger: SyncTrigger): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_marketplace";
  const scheduledKey = "ornaverse_marketplace_orders";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(scheduledKey))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(scheduledKey);
  try {
    const state = (await stateRef.get()).data() as SyncState | undefined;
    const window = nextWindow(state, Date.now());
    const ref = await startRun(source, trigger, window);

    let sales: SaleInput[];
    try {
      sales = await fetchMarketPlaceOrders(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(sales, source, ref.id, { onlyNew: true, actionSource: "website" });
    await ref.update({ status: finalStatus(summary), finished_at: Timestamp.now(), ...summary });
    await stateRef.set(
      { last_window_to: Timestamp.fromDate(window.to), last_run_id: ref.id },
      { merge: true }
    );
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** Daily rescan for marketplace Orders. */
export async function runOrnaverseMarketplaceOrdersRescan(): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_marketplace";
  const scheduledKey = "ornaverse_marketplace_orders";
  const trigger: SyncTrigger = "rescan";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(scheduledKey))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(scheduledKey);
  try {
    const now = Date.now();
    const window = { from: new Date(now - rescanDays() * 24 * 3600 * 1000), to: new Date(now) };
    const ref = await startRun(source, trigger, window);

    let fetched: { sales: SaleInput[]; capped: boolean };
    try {
      fetched = await fetchMarketPlaceOrdersDetailed(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(fetched.sales, source, ref.id, { onlyNew: true, actionSource: "website" });
    const status = fetched.capped && finalStatus(summary) === "ok" ? "partial" : finalStatus(summary);
    await ref.update({
      status,
      finished_at: Timestamp.now(),
      ...summary,
      ...(fetched.capped ? { error: "page_limit_reached" } : {}),
    });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/**
 * Scheduled / manual OrnaVerse CRM visits pull (store walk-ins → Google Ads
 * Store Visit event). Mirrors runOrnaverseSync but reads a different endpoint
 * and tags every row event_type: "store_visit".
 */
export async function runOrnaverseVisitsSync(trigger: SyncTrigger): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_visits";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  try {
    const state = (await stateRef.get()).data() as SyncState | undefined;
    const window = nextWindow(state, Date.now());
    const ref = await startRun(source, trigger, window);

    let visits: SaleInput[];
    try {
      visits = await fetchOrnaverseVisits(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(visits, source, ref.id, {
      onlyNew: true,
      actionSource: "physical_store",
      eventType: "store_visit",
    });
    await ref.update({ status: finalStatus(summary), finished_at: Timestamp.now(), ...summary });
    await stateRef.set(
      { last_window_to: Timestamp.fromDate(window.to), last_run_id: ref.id },
      { merge: true }
    );
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** Daily safety re-scan for CRM visits — same semantics as the POS rescan. */
export async function runOrnaverseVisitsRescan(): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_visits";
  const trigger: SyncTrigger = "rescan";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  try {
    const now = Date.now();
    const window = { from: new Date(now - rescanDays() * 24 * 3600 * 1000), to: new Date(now) };
    const ref = await startRun(source, trigger, window);

    let fetched: { visits: SaleInput[]; capped: boolean };
    try {
      fetched = await fetchOrnaverseVisitsDetailed(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(fetched.visits, source, ref.id, {
      onlyNew: true,
      actionSource: "physical_store",
      eventType: "store_visit",
    });
    const status = fetched.capped && finalStatus(summary) === "ok" ? "partial" : finalStatus(summary);
    await ref.update({
      status,
      finished_at: Timestamp.now(),
      ...summary,
      ...(fetched.capped ? { error: "page_limit_reached" } : {}),
    });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** POS Orders feed: 60-day initial lookback (advance orders can be weeks old). */
const POS_ORDERS_INITIAL_LOOKBACK_DAYS = 60;

/**
 * Scheduled / manual OrnaVerse POS Order pull. Reports event_time as the
 * order creation date, so advance orders (placed weeks before invoice)
 * credit the ad platform on the correct day.
 *
 * The first run (no cursor) is a one-off backfill: 60-day lookback and
 * status=1 only, so status=2 orders that the old Invoice importer already
 * logged don't fire a second conversion. Every run after that is a normal
 * hourly pull: 7-day window (via nextWindow) and status={1,2} so RTS
 * walk-in sales (status jumps straight to 2) land correctly.
 */
export async function runOrnaversePosOrdersSync(trigger: SyncTrigger): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_offline"; // same source as invoices, just a different endpoint
  const scheduledKey = "ornaverse_pos_orders"; // own cursor/lock, separate from invoice cursor

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(scheduledKey))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(scheduledKey);
  try {
    const state = (await stateRef.get()).data() as SyncState | undefined;
    const isBackfill = !state?.last_window_to;
    const window = nextWindow(state, Date.now(), POS_ORDERS_INITIAL_LOOKBACK_DAYS);
    const ref = await startRun(source, trigger, window);

    let sales: SaleInput[];
    try {
      sales = await fetchOrnaversePosOrders(window.from, window.to, { backfill: isBackfill });
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(sales, source, ref.id, { onlyNew: true });
    await ref.update({ status: finalStatus(summary), finished_at: Timestamp.now(), ...summary });
    await stateRef.set(
      { last_window_to: Timestamp.fromDate(window.to), last_run_id: ref.id },
      { merge: true }
    );
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** Daily safety re-scan for POS orders. Mirrors the invoice rescan semantics. */
export async function runOrnaversePosOrdersRescan(): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_offline";
  const scheduledKey = "ornaverse_pos_orders";
  const trigger: SyncTrigger = "rescan";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(scheduledKey))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(scheduledKey);
  try {
    const now = Date.now();
    const window = { from: new Date(now - rescanDays() * 24 * 3600 * 1000), to: new Date(now) };
    const ref = await startRun(source, trigger, window);

    let fetched: { sales: SaleInput[]; capped: boolean };
    try {
      // Rescan is always "ongoing" mode (cursor already set), so status={1,2}.
      fetched = await fetchOrnaversePosOrdersDetailed(window.from, window.to, { backfill: false });
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(fetched.sales, source, ref.id, { onlyNew: true });
    const status = fetched.capped && finalStatus(summary) === "ok" ? "partial" : finalStatus(summary);
    await ref.update({
      status,
      finished_at: Timestamp.now(),
      ...summary,
      ...(fetched.capped ? { error: "page_limit_reached" } : {}),
    });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}

/** ORNAVERSE_RESCAN_DAYS → whole days in [1, 60]; unset or invalid → 30. */
export function rescanDays(raw = process.env.ORNAVERSE_RESCAN_DAYS): number {
  const s = (raw ?? "").trim();
  if (!/^\d+$/.test(s)) return DEFAULT_RESCAN_DAYS;
  const n = Number(s);
  if (n < 1) return DEFAULT_RESCAN_DAYS;
  return Math.min(n, MAX_RESCAN_DAYS);
}

/**
 * Daily safety re-scan. Re-reads posted bills dated in the last N days and
 * imports only the ones we have never recorded: backdated bills, hours the
 * hourly pull missed (outage, OrnaVerse error), drafts posted later.
 *
 * - Shares the hourly pull's lock, so the two never import the same new bill
 *   at the same moment (that could send it twice). If the lock is held, the
 *   run is recorded as skipped.
 * - Never moves the hourly cursor.
 * - If the page limit stops reading early, the run is "partial" with
 *   error "page_limit_reached" so it shows in the admin sync log.
 */
export async function runOrnaverseRescan(): Promise<SyncRun & { id: string }> {
  const source = "ornaverse_offline";
  const trigger: SyncTrigger = "rescan";

  const skipped = async (error: string) => {
    const ref = await startRun(source, trigger);
    await ref.update({ status: "skipped", error, finished_at: Timestamp.now() });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  };

  if (!ornaverseConfigured()) return skipped("ornaverse_not_configured");
  if (!(await acquireLock(source))) return skipped("another_sync_running");

  const stateRef = syncStateCol.doc(source);
  try {
    const now = Date.now();
    const window = { from: new Date(now - rescanDays() * 24 * 3600 * 1000), to: new Date(now) };
    const ref = await startRun(source, trigger, window);

    let fetched: { sales: SaleInput[]; capped: boolean };
    try {
      // Smart importer: Invoice is primary, Order date overrides when linked.
      const out = await fetchOrnaversePosInvoiceSmart(window.from, window.to);
      fetched = { sales: out.sales, capped: out.capped };
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(fetched.sales, source, ref.id, { onlyNew: true });
    const status = fetched.capped && finalStatus(summary) === "ok" ? "partial" : finalStatus(summary);
    await ref.update({
      status,
      finished_at: Timestamp.now(),
      ...summary,
      ...(fetched.capped ? { error: "page_limit_reached" } : {}),
    });
    return { ...((await ref.get()).data() as SyncRun), id: ref.id };
  } finally {
    // Release only the lock; last_window_to (the hourly cursor) is untouched.
    await stateRef.set({ locked_until: null }, { merge: true });
  }
}
