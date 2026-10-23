import { Timestamp } from "@google-cloud/firestore";
import {
  db,
  syncRunsCol,
  syncStateCol,
  type ConversionSource,
  type SyncRun,
  type SyncState,
  type SyncTrigger,
} from "./firestore.js";
import { ingestSale, type SaleInput } from "./matcher.js";
import { dispatchConversion, mapLimit } from "../senders/dispatcher.js";
import { fetchOrnaverseSales, ornaverseConfigured } from "../importers/ornaverse.js";

const DISPATCH_CONCURRENCY = 10;
const MAX_STORED_FAILURES = 50;
// Re-read this much before the last cursor: late-entered POS sales still get
// picked up, and already-sent ones are skipped as duplicates.
const OVERLAP_MS = 60 * 60 * 1000;
// First ever run (no cursor yet) looks back this far.
const DEFAULT_INITIAL_LOOKBACK_DAYS = 7;
// A crashed run's lock expires after this.
const LOCK_MS = 15 * 60 * 1000;

export type ImportSummary = Pick<
  SyncRun,
  "fetched" | "processed" | "matched" | "matched_with_click" | "skipped_duplicate" | "failed" | "failures"
>;

/** Ingest + dispatch a batch of sales and fill in the counts. */
async function importSales(
  sales: SaleInput[],
  source: ConversionSource,
  runId: string
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
  const written: string[] = [];
  const fail = (sale_id: string, error: string) => {
    s.failed++;
    if (s.failures.length < MAX_STORED_FAILURES) s.failures.push({ sale_id, error });
  };

  for (const sale of sales) {
    try {
      const out = await ingestSale(sale, source, runId);
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
  initialLookbackDays = Number(process.env.ORNAVERSE_INITIAL_LOOKBACK_DAYS) || DEFAULT_INITIAL_LOOKBACK_DAYS
): { from: Date; to: Date } {
  const last = state?.last_window_to?.toMillis();
  const from = last != null ? last - OVERLAP_MS : nowMs - initialLookbackDays * 24 * 3600 * 1000;
  return { from: new Date(from), to: new Date(nowMs) };
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
      sales = await fetchOrnaverseSales(window.from, window.to);
    } catch (err) {
      await ref.update({ status: "failed", error: (err as Error).message, finished_at: Timestamp.now() });
      return { ...((await ref.get()).data() as SyncRun), id: ref.id };
    }

    const summary = await importSales(sales, source, ref.id);
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
