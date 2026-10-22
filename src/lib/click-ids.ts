import { Timestamp } from "@google-cloud/firestore";
import type {
  ClickPair,
  GoogleClick,
  LandingInfo,
  MetaClick,
  Visitor,
} from "./firestore.js";

/** Cookie values as posted by public/t.js. */
export interface ClickCookies {
  gclid?: string;
  gclid_at?: number;
  wbraid?: string;
  wbraid_at?: number;
  gbraid?: string;
  gbraid_at?: number;
  _gcl_aw?: string;
  _gcl_gb?: string;
  fbclid?: string;
  _fbc?: string;
}

interface DeviceContext {
  ip_address?: string;
  user_agent?: string;
}

// Treat click ids recorded within this gap as the same landing (e.g. Google
// sending gclid + gbraid together on iOS).
const SAME_CLICK_WINDOW_MS = 60_000;

/** Timestamps in cookies are sometimes seconds (10 digits), sometimes ms (13). */
function toMs(raw: string | number | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** `fb.{subdomain}.{creation_time}.{value}` → { at, value } */
export function parseFbCookie(raw?: string): { at?: number; value?: string } {
  if (!raw) return {};
  const parts = raw.split(".");
  if (parts.length < 4 || parts[0] !== "fb") return {};
  return { at: toMs(parts[2]), value: parts.slice(3).join(".") };
}

/** Google's `_gcl_aw` / `_gcl_gb`: `GCL.{unix_seconds}.{click_id}` → { at, value } */
export function parseGclCookie(raw?: string): { at?: number; value?: string } {
  if (!raw) return {};
  const parts = raw.split(".");
  if (parts.length < 3 || parts[0] !== "GCL") return {};
  return { at: toMs(parts[1]), value: parts.slice(2).join(".") };
}

/** `_ga` = `GA1.{level}.{random}.{timestamp}` → GA4 client id `{random}.{timestamp}` */
export function parseGaClientId(raw?: string): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split(".");
  return parts.length >= 4 ? parts.slice(-2).join(".") : undefined;
}

/** Build the Meta click seen on this request, if any. */
export function metaClickFromCookies(
  c: ClickCookies | undefined,
  landing: LandingInfo | undefined,
  device: DeviceContext,
  nowMs: number
): MetaClick | null {
  const fromFbc = parseFbCookie(c?._fbc);
  const fbclid = c?.fbclid || fromFbc.value;
  if (!fbclid) return null;
  const at = fromFbc.value === fbclid && fromFbc.at ? fromFbc.at : nowMs;
  return {
    fbclid,
    fbc: c?._fbc && fromFbc.value === fbclid ? c._fbc : `fb.1.${at}.${fbclid}`,
    captured_at: Timestamp.fromMillis(at),
    landing,
    ...device,
  };
}

/**
 * Build the Google click seen on this request, if any. Our own cookies are
 * preferred; Google's `_gcl_aw` / `_gcl_gb` fill in clicks that happened
 * before our tracker was on the page.
 */
export function googleClickFromCookies(
  c: ClickCookies | undefined,
  landing: LandingInfo | undefined,
  device: DeviceContext,
  nowMs: number
): GoogleClick | null {
  const aw = parseGclCookie(c?._gcl_aw);
  const gb = parseGclCookie(c?._gcl_gb);
  const candidates: Array<{ type: "gclid" | "gbraid" | "wbraid"; value: string; at: number }> = [];

  const gclid = c?.gclid || aw.value;
  if (gclid) candidates.push({ type: "gclid", value: gclid, at: toMs(c?.gclid ? c.gclid_at : aw.at) ?? nowMs });
  const gbraid = c?.gbraid || gb.value;
  if (gbraid) candidates.push({ type: "gbraid", value: gbraid, at: toMs(c?.gbraid ? c.gbraid_at : gb.at) ?? nowMs });
  if (c?.wbraid) candidates.push({ type: "wbraid", value: c.wbraid, at: toMs(c.wbraid_at) ?? nowMs });

  if (candidates.length === 0) return null;

  // Latest click wins; ids recorded at the same landing ride along with it.
  const latest = Math.max(...candidates.map((x) => x.at));
  const click: GoogleClick = { captured_at: Timestamp.fromMillis(latest), landing, ...device };
  for (const x of candidates) {
    if (latest - x.at <= SAME_CLICK_WINDOW_MS) click[x.type] = x.value;
  }
  return click;
}

function metaKey(c?: MetaClick): string | undefined {
  return c?.fbclid;
}

function googleKey(c?: GoogleClick): string | undefined {
  return c?.gclid || c?.gbraid || c?.wbraid;
}

/**
 * Merge an incoming click into the stored first/last pair. Returns null when
 * nothing changes (same click seen again), so callers can skip the write.
 * `first` is set once and never overwritten; `last` moves on every new click.
 */
function mergePair<T>(
  existing: ClickPair<T> | undefined,
  incoming: T | null,
  key: (c?: T) => string | undefined
): ClickPair<T> | null {
  if (!incoming) return null;
  if (key(existing?.last) === key(incoming)) return null;
  return { first: existing?.first ?? incoming, last: incoming };
}

export function mergeMetaClick(existing: Visitor | null, incoming: MetaClick | null) {
  return mergePair(existing?.click_ids?.meta, incoming, metaKey);
}

export function mergeGoogleClick(existing: Visitor | null, incoming: GoogleClick | null) {
  return mergePair(existing?.click_ids?.google, incoming, googleKey);
}

export type ClickMode = "first" | "last";

export function clickMode(): ClickMode {
  return process.env.CLICK_MODE === "first" ? "first" : "last";
}

function pick<T>(pair: ClickPair<T> | undefined, mode: ClickMode): T | undefined {
  if (!pair) return undefined;
  return mode === "first" ? pair.first ?? pair.last : pair.last ?? pair.first;
}

/** The Meta / Google click to send for this visitor, per CLICK_MODE. */
export function selectClicks(v: Visitor | null, mode: ClickMode = clickMode()) {
  return {
    meta: pick(v?.click_ids?.meta, mode),
    google: pick(v?.click_ids?.google, mode),
  };
}
