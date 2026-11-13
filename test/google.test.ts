import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import {
  buildGoogleAdIdentifiers,
  buildGooglePayload,
  buildGoogleUserIdentifiers,
  googlePreflightError,
  type GoogleConfig,
} from "../src/senders/google.js";
import type { ConversionLog } from "../src/lib/firestore.js";

const NOW = 1_760_000_000_000;
const cfg: GoogleConfig = { customerId: "1234567890", conversionActionId: "987", validateOnly: true };

function log(over: Partial<ConversionLog> = {}): ConversionLog {
  return {
    source: "csv_upload",
    order_id: "S-1001",
    order_amount: 45999,
    currency: "inr",
    event_time: Timestamp.fromMillis(NOW),
    phone_meta: "ph_meta",
    phone_google: "ph_google",
    email_hash: "em_meta",
    email_google_hash: "em_google",
    first_name_hash: "fn",
    last_name_hash: "ln",
    postal_code: "400001",
    region_code: "IN",
    action_source: "physical_store",
    created_at: Timestamp.fromMillis(NOW),
    updated_at: Timestamp.fromMillis(NOW),
    ...over,
  };
}

test("payload: destination, HEX encoding, validateOnly, no loginAccount by default", () => {
  const p = buildGooglePayload(log(), cfg);
  assert.deepEqual(p.destinations, [
    { operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" }, productDestinationId: "987" },
  ]);
  assert.equal(p.encoding, "HEX");
  assert.equal(p.validateOnly, true);
  const withLogin = buildGooglePayload(log(), { ...cfg, loginCustomerId: "1112223334" });
  assert.deepEqual(withLogin.destinations[0].loginAccount, { accountType: "GOOGLE_ADS", accountId: "1112223334" });
});

test("payload: in-store event with transactionId, RFC 3339 time, value + currency", () => {
  const e = buildGooglePayload(log(), cfg).events[0];
  assert.equal(e.transactionId, "S-1001");
  assert.equal(e.eventTimestamp, new Date(NOW).toISOString());
  assert.equal(e.eventSource, "IN_STORE");
  assert.equal(e.conversionValue, 45999);
  assert.equal(e.currency, "INR");
  assert.equal(buildGooglePayload(log({ action_source: "website" }), cfg).events[0].eventSource, "WEB");
  // Store Visit events always send conversionValue 0 regardless of order_amount.
  assert.equal(
    buildGooglePayload(log({ event_type: "store_visit", order_amount: 42 }), cfg).events[0].conversionValue,
    0
  );
});

test("user identifiers: Google-format hashes, address only when complete", () => {
  assert.deepEqual(buildGoogleUserIdentifiers(log()), [
    { emailAddress: "em_google" },
    { phoneNumber: "ph_google" },
    { address: { givenName: "fn", familyName: "ln", regionCode: "IN", postalCode: "400001" } },
  ]);
  const noZip = buildGoogleUserIdentifiers(log({ postal_code: undefined }));
  assert.equal(noZip.some((x) => "address" in x), false);
});

test("ad identifiers: one click id, gclid > gbraid > wbraid", () => {
  assert.equal(buildGoogleAdIdentifiers(log()), undefined);
  assert.deepEqual(buildGoogleAdIdentifiers(log({ gclid: "G", gbraid: "B", wbraid: "W" })), { gclid: "G" });
  assert.deepEqual(buildGoogleAdIdentifiers(log({ gbraid: "B", wbraid: "W" })), { gbraid: "B" });
  assert.deepEqual(buildGoogleAdIdentifiers(log({ wbraid: "W" })), { wbraid: "W" });
  assert.deepEqual(buildGooglePayload(log({ gclid: "G" }), cfg).events[0].adIdentifiers, { gclid: "G" });
});

test("consent: mapped when known, omitted when not", () => {
  assert.equal("consent" in buildGooglePayload(log(), cfg).events[0], false);
  const e = buildGooglePayload(log({ consent: { ad_user_data: "granted", ad_personalization: "denied" } }), cfg).events[0];
  assert.deepEqual(e.consent, { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" });
});

test("preflight: needs a click id or a user identifier", () => {
  assert.equal(googlePreflightError(log()), null);
  const bare = log({ phone_google: null, email_google_hash: null, postal_code: undefined });
  assert.equal(googlePreflightError(bare), "no_match_keys");
  assert.equal(googlePreflightError({ ...bare, gclid: "G" }), null);
});
