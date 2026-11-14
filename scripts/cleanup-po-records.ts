// One-off cleanup: remove conversions_log rows written by the short-lived
// POS Orders importer. Those rows have sale_id starting with "po-" and
// represent sales that will now be covered by the Smart Invoice importer
// via their corresponding inv-<id> record.
//
// The Google Ads conversions for the "po-" ids have already been sent and
// cannot be recalled — we're just preventing further retries and future
// dashboard double-counting for these sale ids.
//
// DRY RUN by default. Pass `--apply` to actually delete.
//
// Run: cd lucira-capi && npx tsx scripts/cleanup-po-records.ts [--apply]
import "dotenv/config";
import { db } from "../src/lib/firestore.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (will delete)" : "DRY RUN (no changes)"}`);

  const col = db.collection("conversions_log");
  // Prefix search via doc-id range. Any id starting with "po-" is strictly
  // between "po-" and "po-" (highest BMP code point).
  const snap = await col.orderBy("__name__").startAt("po-").endAt("po-").get();

  console.log(`Found ${snap.size} documents with sale_id starting "po-"`);
  if (snap.size === 0) { console.log("Nothing to do."); return; }

  // Sample first 5 for sanity check.
  console.log("Sample ids:");
  for (const d of snap.docs.slice(0, 5)) console.log(`  ${d.id}`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to delete.");
    return;
  }

  let deleted = 0;
  for (let i = 0; i < snap.size; i += BATCH) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + BATCH)) batch.delete(d.ref);
    await batch.commit();
    deleted += Math.min(BATCH, snap.size - i);
    process.stdout.write(`\r  deleted ${deleted}/${snap.size}`);
  }
  console.log(`\nDeleted ${deleted} documents.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
