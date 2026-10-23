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
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  touchpoints?: string[];
  consent?: VisitorConsent;
}

export type ConversionSource = "ornaverse_offline" | "csv_upload";
export type SendStatus = "pending" | "success" | "failed" | "retrying";

export interface SenderResult {
  status: SendStatus;
  response_code?: number;
  response_body?: string;
  retries: number;
  sent_at?: Timestamp;
  error?: string;
}

export interface ConversionLog {
  source: ConversionSource;
  order_id: string;
  order_amount: number;
  currency: string;
  event_time: Timestamp;
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

const VISITORS = "visitors";
const CONVERSIONS = "conversions_log";

export const visitorsCol = db.collection(VISITORS);
export const conversionsCol = db.collection(CONVERSIONS);

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

/**
 * Look up a visitor by whichever identifier arrives on an order. We try
 * phone_meta first (used as the document key), then email_hash via query.
 */
export async function findVisitorByIdentifiers(input: {
  phone_meta?: string | null;
  email_hash?: string | null;
}): Promise<Visitor | null> {
  if (input.phone_meta) {
    const direct = await getVisitor(input.phone_meta);
    if (direct) return direct;
  }
  if (input.email_hash) {
    const direct = await getVisitor(input.email_hash);
    if (direct) return direct;
    const q = await visitorsCol.where("email_hash", "==", input.email_hash).limit(1).get();
    if (!q.empty) return q.docs[0].data() as Visitor;
  }
  return null;
}

export async function writeConversion(
  orderId: string,
  data: Omit<ConversionLog, "created_at" | "updated_at">
): Promise<void> {
  const now = Timestamp.now();
  await conversionsCol.doc(orderId).set({
    ...data,
    created_at: now,
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
