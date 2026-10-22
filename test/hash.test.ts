import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanEmail,
  hashEmail,
  hashEmailForGoogle,
  hashIdentity,
  hashPhoneForGoogle,
  hashPhoneForMeta,
  isPlaceholderEmail,
  normalizeDob,
  normalizeEmail,
  normalizeEmailForGoogle,
  normalizeGender,
  normalizeLocality,
  normalizeName,
  normalizePhoneE164,
  normalizeZipIndia,
  sha256,
} from "../src/lib/hash.js";

// Reference digests computed independently with `openssl dgst -sha256`.
const SHA_919876543210 = "92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0";
const SHA_PLUS_919876543210 = "f3a47ce5ce3d4ca8ad15225a245b2759022f79489f5c62719b8c9490f7aab90e";
const SHA_JOHN_DOE = "836f82db99121b3481011f16b49dfa5fbc714a0d1b1b9f784a1ebbbf5b39577f";

test("sha256 matches openssl", () => {
  assert.equal(sha256("919876543210"), SHA_919876543210);
  assert.equal(sha256("john.doe@example.com"), SHA_JOHN_DOE);
});

test("phone: Indian formats all normalize to +91XXXXXXXXXX", () => {
  const want = "+919876543210";
  for (const input of [
    "9876543210",
    "+91 98765 43210",
    "+91-98765-43210",
    "(+91) 98765 43210",
    "919876543210",
    "0919876543210",
    "00919876543210",
    "09876543210",
    "+91 0 98765 43210",
    " 98765 43210 ",
  ]) {
    assert.equal(normalizePhoneE164(input), want, input);
  }
});

test("phone: invalid input returns null", () => {
  for (const input of [
    "",
    null,
    undefined,
    "abc",
    "12345",
    "5876543210", // Indian mobile must start 6-9
    "915876543210", // same, with +91
    "98765 4321", // 9 digits
    "1234567890123456", // 16 digits
  ]) {
    assert.equal(normalizePhoneE164(input as string), null, String(input));
  }
});

test("phone: other country codes pass through", () => {
  assert.equal(normalizePhoneE164("+1 (650) 555-1212"), "+16505551212");
  assert.equal(normalizePhoneE164("+44 20 7946 0958"), "+442079460958");
});

test("phone hash: Meta = digits only, Google = E.164 with +", () => {
  assert.equal(hashPhoneForMeta("+91 98765 43210"), SHA_919876543210);
  assert.equal(hashPhoneForGoogle("+91 98765 43210"), SHA_PLUS_919876543210);
  assert.equal(hashPhoneForMeta("bad"), null);
});

test("email: trim + lowercase; invalid is null", () => {
  assert.equal(normalizeEmail("  John.Doe@Example.COM "), "john.doe@example.com");
  assert.equal(hashEmail(" John.Doe@Example.com"), SHA_JOHN_DOE);
  for (const bad of ["", "john", "john@", "@example.com", "a b@x.com", "john@example"]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test("email for Google: gmail dots and +suffix removed, other domains untouched", () => {
  assert.equal(
    normalizeEmailForGoogle("Cloudy.SanFrancisco+shopping@gmail.com"),
    "cloudysanfrancisco@gmail.com"
  );
  assert.equal(normalizeEmailForGoogle("j.o.h.n@googlemail.com"), "john@googlemail.com");
  assert.equal(normalizeEmailForGoogle("user.name+NYC@Example.com"), "user.name+nyc@example.com");
  // Meta keeps the dots, so the two hashes differ for gmail.
  assert.notEqual(hashEmail("j.ohn@gmail.com"), hashEmailForGoogle("j.ohn@gmail.com"));
  assert.equal(hashEmailForGoogle("john@example.com"), hashEmail("john@example.com"));
});

test("placeholder emails", () => {
  // Always a placeholder on Lucira's own domain.
  assert.equal(isPlaceholderEmail("9876543210@lucirajewelry.com"), true);
  assert.equal(isPlaceholderEmail("+919876543210@lucirajewelry.com", null), true);
  // gmail: only when the digits are this person's own phone.
  assert.equal(isPlaceholderEmail("9876543210@gmail.com", "+91 98765 43210"), true);
  assert.equal(isPlaceholderEmail("919876543210@gmail.com", "9876543210"), true);
  assert.equal(isPlaceholderEmail("9876543210@gmail.com", "9123456789"), false);
  assert.equal(isPlaceholderEmail("9876543210@gmail.com"), false);
  // Real addresses are never placeholders.
  assert.equal(isPlaceholderEmail("priya@lucirajewelry.com"), false);
  assert.equal(isPlaceholderEmail("priya98@gmail.com", "9876543210"), false);

  assert.equal(cleanEmail("9876543210@lucirajewelry.com", "9876543210"), null);
  assert.equal(cleanEmail("Priya@Gmail.com", "9876543210"), "priya@gmail.com");
});

test("hashIdentity drops placeholder email and fills both email hashes", () => {
  const dummy = hashIdentity({ phone: "9876543210", email: "9876543210@gmail.com" });
  assert.equal(dummy.email, null);
  assert.equal(dummy.email_google, null);
  assert.equal(dummy.phone_meta, SHA_919876543210);

  const real = hashIdentity({ phone: "9876543210", email: "j.ohn@gmail.com" });
  assert.equal(real.email, sha256("j.ohn@gmail.com"));
  assert.equal(real.email_google, sha256("john@gmail.com"));
});

test("name: lowercase, no punctuation, honorifics removed, non-English kept", () => {
  assert.equal(normalizeName("  Priya  "), "priya");
  assert.equal(normalizeName("Mrs. Priya"), "priya");
  assert.equal(normalizeName("Smt Lakshmi"), "lakshmi");
  assert.equal(normalizeName("Dr. A.P.J."), "apj");
  assert.equal(normalizeName("Sharma Jr."), "sharma");
  assert.equal(normalizeName("O'Brien"), "obrien");
  assert.equal(normalizeName("Mary  Jane"), "mary jane");
  assert.equal(normalizeName("Valéry"), "valéry");
  assert.equal(normalizeName("प्रिया"), "प्रिया");
  // A lone honorific is kept rather than producing an empty name.
  assert.equal(normalizeName("Mr"), "mr");
  assert.equal(normalizeName("..."), null);
});

test("city/state: no spaces or punctuation, UTF-8 kept", () => {
  assert.equal(normalizeLocality("New Delhi"), "newdelhi");
  assert.equal(normalizeLocality("Tamil Nadu"), "tamilnadu");
  assert.equal(normalizeLocality("मुंबई"), "मुंबई");
  assert.equal(normalizeLocality(" - "), null);
});

test("zip: 6-digit Indian pincode", () => {
  assert.equal(normalizeZipIndia("400 001"), "400001");
  assert.equal(normalizeZipIndia("40001"), null);
});

test("country: lowercase 2-letter code, defaults to IN", () => {
  assert.equal(hashIdentity({}).country, sha256("in"));
  assert.equal(hashIdentity({ country: "US" }).country, sha256("us"));
  assert.equal(hashIdentity({ country: "India" }).country, null);
});

test("date of birth → YYYYMMDD", () => {
  assert.equal(normalizeDob("1997-02-16"), "19970216");
  assert.equal(normalizeDob("19970216"), "19970216");
  assert.equal(normalizeDob("16/02/1997"), "19970216");
  assert.equal(normalizeDob("5-3-1990"), "19900305");
  assert.equal(normalizeDob("1899-01-01"), null);
  assert.equal(normalizeDob("1997-13-01"), null);
  assert.equal(normalizeDob("not a date"), null);
});

test("gender → m / f", () => {
  assert.equal(normalizeGender("Male"), "m");
  assert.equal(normalizeGender(" F "), "f");
  assert.equal(normalizeGender("other"), null);
});
