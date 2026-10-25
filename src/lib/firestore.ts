import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";

export const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  ignoreUndefinedProperties: true,
});

export { FieldValue, Timestamp };

/** Where an ad click landed (from the tracker's landing cookie). */
export interface LandingInfo {
  url?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

/** Shared by both platforms: when the click happened and what we saw with it. */
interface ClickBase {
  // Actual click time from the cookie when known, otherwise when we first saw it.
  captured_at: Timestamp;
  landing?: LandingInfo;
  // Device context from the /identify call that first recorded this click.
  ip_address?: string;
  user_agent?: string;
}

export interface MetaClick extends ClickBase {
  fbclid?: string;
  fbc?: string;
}

export interface GoogleClick extends ClickBase {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
}

/** First and latest click per platform. CLICK_MODE picks which one is sent. */
export interface ClickPair<T> {
  first?: T;
  last?: T;
}

export type ConsentState = "granted" | "denied";

export interface VisitorConsent {
  marketing: boolean;
  timestamp: Timestamp;
  version: string;
  // Google Consent Mode v2 signals, passed to the Data Manager API.
  ad_user_data?: ConsentState;
  ad_personalization?: ConsentState;
}

export interface Visitor {
  user_id?: string;
  shopify_customer_id?: string;
  // Raw (normalized) PII — admin-UI display only. Hashes below are the ones
  // sent to Meta CAPI / Google Ads. See admin-api.ts for the UI exposure.
  raw_phone?: string;
  raw_email?: string;
  raw_first_name?: string;
  raw_last_name?: string;
  raw_zip?: string;
  raw_city?: string;
  raw_state?: string;
  raw_country?: string;
  phone_meta?: string | null;
  phone_google?: string | null;
  email_hash?: string | null;
  // Google-format email hash (gmail dots / +suffix removed).
  email_google_hash?: string | null;
  first_name_hash?: string | null;
  last_name_hash?: string | null;
  zip_hash?: string | null;
  city_hash?: string | null;
  state_hash?: string | null;
  country_hash?: string | null;
  raw_dob?: string;
  raw_gender?: string;
  dob_hash?: string | null;
  gender_hash?: string | null;
  // Meta external_id: sha256 of shopify_customer_id, else user_id, else lcid.
  external_id?: string;
  external_id_source?: "shopify_customer_id" | "user_id" | "lcid";
  lcid?: string;
  cookie_ids?: string[];
  click_ids?: {
    meta?: ClickPair<MetaClick>;
    google?: ClickPair<GoogleClick>;
  };
  // Meta browser id (not a click); latest value.
  fbp?: string;
  fbp_captured_at?: Timestamp;
  // Google tag's own visitor ids, latest values.
  gcl_au?: string;
  ga_client_id?: string;
  // Device context from the last /identify POST, sent as-is to Meta.
  client_ip_address?: string;
  client_user_agent?: string;
  // IP-derived geolocation from Cloud Run's X-Appengine-* headers. Admin UI
  // display only — never sent to Meta/Google (their systems do their own IP
  // geo and sending our guess can hurt match quality). City-level accuracy
  // on fixed broadband, state-level on mobile — treat as approximate.
  geo?: {
    country?: string;
    region?: string;
    city?: string;
    lat_long?: string;
  };
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  touchpoints?: string[];
  consent?: VisitorConsent;
}

export type ConversionSource = "ornaverse_offline" | "csv_upload";
// pending: not tried yet. retrying: failed, another attempt is scheduled.
// failed: no more automatic attempts (permanent error or retries used up).
// validated: Google validateOnly passed, nothing sent.
export type SendStatus = "pending" | "success" | "failed" | "retrying" | "validated";

export interface SenderResult {
  status: SendStatus;
  response_code?: number;
  response_body?: string;
  retries: number;
  sent_at?: Timestamp;
  error?: string;
  // Set only while an automatic attempt is due; the retry sweep queries on it.
  next_retry_at?: Timestamp;
}

/** How a sale was tied to a website visitor (see lib/matcher.ts). */
export interface MatchInfo {
  matched_by: "phone" | "email" | null;
  visitor_key?: string;
  click_mode: "first" | "last";
  // Which stored click was sent per platform, and when it happened.
  meta_click?: "first" | "last";
  meta_click_at?: Timestamp;
  google_click?: "first" | "last";
  google_click_at?: Timestamp;
}

export interface ConversionLog {
  source: ConversionSource;
  order_id: string;
  order_amount: number;
  currency: string;
  event_time: Timestamp;
  store_name?: string;
  // Sync run that imported this sale.
  sync_run_id?: string;
  match?: MatchInfo;
  phone_meta?: string | null;
  phone_google?: string | null;
  email_hash?: string | null;
  email_google_hash?: string | null;
  first_name_hash?: string | null;
  last_name_hash?: string | null;
  zip_hash?: string | null;
  city_hash?: string | null;
  state_hash?: string | null;
  country_hash?: string | null;
  // From the matched visitor (Meta only).
  dob_hash?: string | null;
  gender_hash?: string | null;
  external_id?: string;
  // Google address match: sent unhashed (6-digit pincode, ISO-2 country).
  postal_code?: string;
  region_code?: string;
  // Consent Mode signals from the matched visitor, sent to Google.
  consent?: Pick<VisitorConsent, "ad_user_data" | "ad_personalization">;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbc?: string;
  fbp?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  action_source: "website" | "physical_store";
  meta_capi?: SenderResult;
  google_ads?: SenderResult;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// "rescan" = daily safety re-scan of recent days (catches backdated / missed bills).
export type SyncTrigger = "schedule" | "manual" | "csv" | "rescan";
export type SyncStatus = "running" | "ok" | "partial" | "failed" | "skipped";

/** One import of offline sales (scheduled OrnaVerse pull or CSV upload). */
export interface SyncRun {
  source: ConversionSource;
  trigger: SyncTrigger;
  status: SyncStatus;
  started_at: Timestamp;
  finished_at?: Timestamp;
  // Sale-time window requested from the source (scheduled pulls only).
  window_from?: Timestamp;
  window_to?: Timestamp;
  fetched: number;
  processed: number;
  matched: number;
  matched_with_click: number;
  skipped_duplicate: number;
  failed: number;
  // First few row failures, for the admin UI.
  failures: Array<{ sale_id: string; error: string }>;
  error?: string;
}

/** Per-source sync cursor + lock. */
export interface SyncState {
  // Sales up to this time have been imported.
  last_window_to?: Timestamp;
  last_run_id?: string;
  // A run holds the lock until this time; stale locks expire on their own.
  locked_until?: Timestamp;
}

const VISITORS = "visitors";
const CONVERSIONS = "conversions_log";

export const visitorsCol = db.collection(VISITORS);
export const conversionsCol = db.collection(CONVERSIONS);
export const syncRunsCol = db.collection("sync_runs");
export const syncStateCol = db.collection("sync_state");

/**
 * Primary visitor key. Prefer phone_meta (Indian jewellery buyers almost
 * always have a phone), fall back to email_hash, finally user_id. One of
 * these must be set or the record cannot be looked up later.
 */
export function visitorKey(input: {
  phone_meta?: string | null;
  email_hash?: string | null;
  user_id?: string | null;
}): string | null {
  return input.phone_meta || input.email_hash || input.user_id || null;
}

export async function upsertVisitor(
  key: string,
  data: Partial<Visitor>
): Promise<void> {
  const ref = visitorsCol.doc(key);
  const now = Timestamp.now();
  await ref.set(
    {
      ...data,
      first_seen_at: data.first_seen_at ?? now,
      last_seen_at: now,
    },
    { merge: true }
  );
}

export async function getVisitor(key: string): Promise<Visitor | null> {
  const snap = await visitorsCol.doc(key).get();
  return snap.exists ? (snap.data() as Visitor) : null;
}

export interface VisitorMatch {
  visitor: Visitor;
  key: string;
  matched_by: "phone" | "email";
}

/**
 * Look up a visitor by whichever identifier arrives on an order. Phone first
 * (it is the usual document key), then email. Each tries the document key,
 * then a field query for visitors keyed by something else.
 */
export async function findVisitorByIdentifiers(input: {
  phone_meta?: string | null;
  email_hash?: string | null;
}): Promise<VisitorMatch | null> {
  const tries: Array<["phone" | "email", "phone_meta" | "email_hash", string | null | undefined]> = [
    ["phone", "phone_meta", input.phone_meta],
    ["email", "email_hash", input.email_hash],
  ];
  for (const [matched_by, field, value] of tries) {
    if (!value) continue;
    const direct = await visitorsCol.doc(value).get();
    if (direct.exists) return { visitor: direct.data() as Visitor, key: direct.id, matched_by };
    const q = await visitorsCol.where(field, "==", value).limit(1).get();
    if (!q.empty) return { visitor: q.docs[0].data() as Visitor, key: q.docs[0].id, matched_by };
  }
  return null;
}

export async function writeConversion(
  orderId: string,
  data: Omit<ConversionLog, "created_at" | "updated_at">,
  createdAt?: Timestamp
): Promise<void> {
  const now = Timestamp.now();
  await conversionsCol.doc(orderId).set({
    ...data,
    created_at: createdAt ?? now,
    updated_at: now,
  });
}

export async function updateConversionSender(
  orderId: string,
  sender: "meta_capi" | "google_ads",
  result: SenderResult
): Promise<void> {
  await conversionsCol.doc(orderId).update({
    [sender]: result,
    updated_at: Timestamp.now(),
  });
}

export async function getConversion(orderId: string): Promise<ConversionLog | null> {
  const snap = await conversionsCol.doc(orderId).get();
  return snap.exists ? (snap.data() as ConversionLog) : null;
}
