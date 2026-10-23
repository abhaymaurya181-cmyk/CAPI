import type { SaleInput } from "../lib/matcher.js";

/**
 * OrnaVerse POS importer. Step 5 fills this in once Lucira shares the API
 * docs + key: call ORNAVERSE_API_BASE with ORNAVERSE_API_KEY, page through
 * sales whose time is in [from, to), and map each one to SaleInput.
 * The scheduled sync (lib/sync.ts) already handles the cursor, matching,
 * sending, retries and the sync log around it.
 */
export function ornaverseConfigured(): boolean {
  return Boolean(process.env.ORNAVERSE_API_BASE && process.env.ORNAVERSE_API_KEY);
}

export async function fetchOrnaverseSales(_from: Date, _to: Date): Promise<SaleInput[]> {
  throw new Error("ornaverse_importer_not_implemented");
}
