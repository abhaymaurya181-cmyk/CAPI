import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { buildConversion, combineCandidates, pickEligibleClick, type SaleInput } from "../src/lib/matcher.js";
import { nextWindow } from "../src/lib/sync.js";
import type { GoogleClick, MetaClick, Visitor, VisitorMatch } from "../src/lib/firestore.js";

const DAY = 24 * 3600 * 1000;
const SALE = 1_760_000_000_000;
const WINDOW = 90 * DAY;
const at = (ms: number) => Timestamp.fromMillis(ms);

const sale: SaleInput = {
  sale_id: "S-1",
  amount: 45999,
  currency: "INR",
  event_time: new Date(SALE),
  phone: "9876543210",
  first_name: "Asha",
  last_name: "Rao",
  zip: "400 001",
  country: "in",
  store_name: "Bandra",
};

function visitor(over: Partial<Visitor> = {}): VisitorMatch {
  return {
    key: "vkey",
    matched_by: "phone",
    visitor: {
      first_seen_at: at(SALE - 60 * DAY),
      last_seen_at: at(SALE - DAY),
      fbp: "fb.1.1.2",
      external_id: "ext",
      client_ip_address: "1.2.3.4",
      consent: { marketing: true, timestamp: at(0), version: "1", ad_user_data: "granted" },
      click_ids: {
        meta: {
          first: { fbclid: "F1", fbc: "fb.1.x.F1", captured_at: at(SALE - 40 * DAY) },
          last: { fbclid: "F2", fbc: "fb.1.x.F2", captured_at: at(SALE - 2 * DAY) },
        },
        google: {
          first: { gclid: "G1", captured_at: at(SALE - 30 * DAY) },
          last: { gbraid: "B2", captured_at: at(SALE - DAY) },
        },
      },
      ...over,
    },
  };
}

test("pickEligibleClick: mode click if before sale and in window", () => {
  const pair = visitor().visitor.click_ids!.meta!;
  assert.equal(pickEligibleClick(pair, "last", SALE, WINDOW)?.click.fbclid, "F2");
  assert.equal(pickEligibleClick(pair, "first", SALE, WINDOW)?.click.fbclid, "F1");
});

test("pickEligibleClick: falls back when the mode click is after the sale or too old", () => {
  const after = {
    first: { fbclid: "F1", captured_at: at(SALE - 10 * DAY) },
    last: { fbclid: "F2", captured_at: at(SALE + DAY) },
  } as { first: MetaClick; last: MetaClick };
  assert.deepEqual(
    pickEligibleClick(after, "last", SALE, WINDOW)?.which,
    "first",
    "a click after the sale cannot have caused it"
  );
  const old = {
    first: { gclid: "G1", captured_at: at(SALE - 100 * DAY) },
    last: { gclid: "G2", captured_at: at(SALE - 5 * DAY) },
  } as { first: GoogleClick; last: GoogleClick };
  assert.equal(pickEligibleClick(old, "first", SALE, WINDOW)?.click.gclid, "G2");
  assert.equal(pickEligibleClick({ first: old.first }, "first", SALE, WINDOW), null);
  assert.equal(pickEligibleClick(undefined, "last", SALE, WINDOW), null);
});

test("buildConversion: matched visitor → clicks, match info, visitor fields", () => {
  const c = buildConversion(sale, "csv_upload", visitor(), { mode: "last", windowMs: WINDOW, nowMs: SALE });
  assert.equal(c.order_id, "S-1");
  assert.equal(c.action_source, "physical_store");
  assert.equal(c.store_name, "Bandra");
  assert.equal(c.fbc, "fb.1.x.F2");
  assert.equal(c.gbraid, "B2");
  assert.equal(c.gclid, undefined);
  assert.equal(c.fbp, "fb.1.1.2");
  assert.equal(c.external_id, "ext");
  assert.equal(c.client_ip_address, "1.2.3.4");
  assert.equal(c.postal_code, "400001");
  assert.equal(c.region_code, "IN");
  assert.deepEqual(c.consent, { ad_user_data: "granted", ad_personalization: undefined });
  assert.equal(c.match?.matched_by, "phone");
  assert.equal(c.match?.visitor_key, "vkey");
  assert.equal(c.match?.meta_click, "last");
  assert.equal(c.match?.google_click, "last");
  assert.ok(c.phone_meta && c.phone_google && c.phone_meta !== c.phone_google);
  assert.equal(c.meta_capi?.status, "pending");
  assert.ok(c.meta_capi?.next_retry_at, "pending sale is picked up by the sweep if inline send dies");
});

test("buildConversion: no visitor → hashes only, no clicks", () => {
  const c = buildConversion(sale, "ornaverse_offline", null, { mode: "last", windowMs: WINDOW });
  assert.equal(c.source, "ornaverse_offline");
  assert.equal(c.match?.matched_by, null);
  assert.equal(c.fbc, undefined);
  assert.equal(c.gclid, undefined);
  assert.equal(c.external_id, undefined);
  assert.ok(c.phone_meta);
});

test("buildConversion: event_type=store_visit → Google-only, no Meta sender", () => {
  const c = buildConversion(sale, "ornaverse_visits", visitor(), {
    mode: "last",
    windowMs: WINDOW,
    nowMs: SALE,
    event_type: "store_visit",
  });
  assert.equal(c.event_type, "store_visit");
  assert.equal(c.action_source, "physical_store");
  assert.equal(c.meta_capi, undefined, "store visits have no Meta equivalent");
  assert.equal(c.google_ads?.status, "pending");
});

test("buildConversion: action_source=website → Google only, no Meta (Shopify pixel fires Meta)", () => {
  const c = buildConversion(sale, "ornaverse_marketplace", visitor(), {
    mode: "last",
    windowMs: WINDOW,
    nowMs: SALE,
    action_source: "website",
  });
  assert.equal(c.action_source, "website");
  assert.equal(c.meta_capi, undefined, "Meta is still skipped — Shopify pixel already reports to Meta");
  assert.equal(c.google_ads?.status, "pending", "Google IS sent (dedupes with gtag by transactionId)");
  assert.equal(c.match?.matched_by, "phone");
});

test("nextWindow: initial lookback, then overlap before the cursor", () => {
  const now = SALE;
  const first = nextWindow(undefined, now, 7);
  assert.equal(first.from.getTime(), now - 7 * DAY);
  assert.equal(first.to.getTime(), now);
  const next = nextWindow({ last_window_to: at(now - 3600_000) }, now, 7, 0);
  assert.equal(next.from.getTime(), now - 2 * 3600_000, "1h overlap before last cursor");
});

// ---------- one person, several visitor docs ----------

function doc(
  key: string,
  matched_by: "phone" | "email",
  clicks: Visitor["click_ids"],
  lastSeenDaysAgo = 1
): VisitorMatch {
  return {
    key,
    matched_by,
    visitor: {
      first_seen_at: at(SALE - 60 * DAY),
      last_seen_at: at(SALE - lastSeenDaysAgo * DAY),
      fbp: `fbp-${key}`,
      click_ids: clicks,
    },
  };
}
const gClick = (id: string, daysAgo: number): GoogleClick => ({ gclid: id, captured_at: at(SALE - daysAgo * DAY) });
const mClick = (id: string, daysAgo: number): MetaClick => ({ fbclid: id, fbc: `fb.1.x.${id}`, captured_at: at(SALE - daysAgo * DAY) });

test("combineCandidates: none → null, one → unchanged", () => {
  assert.equal(combineCandidates([], "last", SALE, WINDOW), null);
  const one = doc("p", "phone", {});
  assert.equal(combineCandidates([one], "last", SALE, WINDOW), one);
});

test("combineCandidates: phone doc without clicks + email doc with Google click → the click is used", () => {
  const phone = doc("phoneKey", "phone", {});
  const email = doc("emailKey", "email", { google: { first: gClick("G-email", 5), last: gClick("G-email", 5) } });
  const m = combineCandidates([phone, email], "last", SALE, WINDOW)!;
  assert.equal(m.visitor.click_ids?.google?.last?.gclid, "G-email");
  // The doc that supplies the click is the primary; nothing merged from elsewhere.
  assert.equal(m.key, "emailKey");
  assert.equal(m.merged_keys, undefined);
});

test("combineCandidates: Meta click on one doc, Google click on another → both kept, phone doc primary", () => {
  const phone = doc("phoneKey", "phone", { meta: { first: mClick("F-p", 10), last: mClick("F-p", 10) } });
  const email = doc("emailKey", "email", { google: { first: gClick("G-e", 3), last: gClick("G-e", 3) } });
  const m = combineCandidates([email, phone], "last", SALE, WINDOW)!;
  assert.equal(m.key, "phoneKey");
  assert.equal(m.matched_by, "phone");
  assert.equal(m.visitor.fbp, "fbp-phoneKey");
  assert.equal(m.visitor.click_ids?.meta?.last?.fbclid, "F-p");
  assert.equal(m.visitor.click_ids?.google?.last?.gclid, "G-e");
  assert.deepEqual(m.merged_keys, ["emailKey"]);
});

test("combineCandidates: CLICK_MODE last → latest click across docs; first → earliest", () => {
  const a = doc("a", "phone", { google: { first: gClick("G-old", 40), last: gClick("G-old", 40) } });
  const b = doc("b", "email", { google: { first: gClick("G-new", 2), last: gClick("G-new", 2) } });
  assert.equal(combineCandidates([a, b], "last", SALE, WINDOW)!.visitor.click_ids?.google?.last?.gclid, "G-new");
  assert.equal(combineCandidates([a, b], "first", SALE, WINDOW)!.visitor.click_ids?.google?.first?.gclid, "G-old");
});

test("combineCandidates: clicks after the sale or outside the window never win", () => {
  const after = doc("after", "phone", { google: { first: gClick("G-after", -2), last: gClick("G-after", -2) } });
  const tooOld = doc("old", "email", { google: { first: gClick("G-old", 120), last: gClick("G-old", 120) } });
  const ok = doc("ok", "email", { google: { first: gClick("G-ok", 20), last: gClick("G-ok", 20) } });
  const m = combineCandidates([after, tooOld, ok], "last", SALE, WINDOW)!;
  assert.equal(m.visitor.click_ids?.google?.last?.gclid, "G-ok");
  // Only invalid clicks anywhere → no platform click chosen from them.
  const none = combineCandidates([after, tooOld], "last", SALE, WINDOW)!;
  assert.equal(buildConversion(sale, "ornaverse_offline", none, { mode: "last", windowMs: WINDOW }).gclid, undefined);
});

test("combineCandidates: no clicks anywhere → phone match over email, then most recently seen", () => {
  const emailRecent = doc("emailRecent", "email", {}, 1);
  const phoneOld = doc("phoneOld", "phone", {}, 30);
  const phoneNew = doc("phoneNew", "phone", {}, 2);
  assert.equal(combineCandidates([emailRecent, phoneOld, phoneNew], "last", SALE, WINDOW)!.key, "phoneNew");
});

test("buildConversion with a merged match: sends the merged click and records where it came from", () => {
  const phone = doc("phoneKey", "phone", { meta: { first: mClick("F-p", 10), last: mClick("F-p", 10) } });
  const email = doc("emailKey", "email", { google: { first: gClick("G-e", 3), last: gClick("G-e", 3) } });
  const m = combineCandidates([phone, email], "last", SALE, WINDOW);
  const row = buildConversion(sale, "ornaverse_offline", m, { mode: "last", windowMs: WINDOW });
  assert.equal(row.gclid, "G-e");
  assert.equal(row.fbc, "fb.1.x.F-p");
  assert.equal(row.match?.visitor_key, "phoneKey");
  assert.deepEqual(row.match?.merged_visitor_keys, ["emailKey"]);
});
