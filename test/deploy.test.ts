import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain JS module (deploy script), no type declarations
import * as d from "../deploy/deploy.mjs";

const ORNA = ["ORNAVERSE_API_BASE", "ORNAVERSE_CLIENT_ID", "ORNAVERSE_CLIENT_SECRET"];

test("planSecrets: required missing → error, deploy must stop", () => {
  const p = d.planSecrets(new Set(["LUCIRA_CREDS_CAPI"]));
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /INTERNAL_TOKEN/);
});

test("planSecrets: OrnaVerse only → attached, Meta/Google listed missing, no warnings", () => {
  const p = d.planSecrets(new Set(["LUCIRA_CREDS_CAPI", "INTERNAL_TOKEN", ...ORNA]));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.attach, ["LUCIRA_CREDS_CAPI", "INTERNAL_TOKEN", ...ORNA]);
  assert.ok(p.missing.includes("META_PIXEL_ID") && p.missing.includes("GOOGLE_ADS_CUSTOMER_ID"));
});

test("planSecrets: half-configured integration → warning naming what's missing", () => {
  const p = d.planSecrets(new Set(["LUCIRA_CREDS_CAPI", "INTERNAL_TOKEN", "ORNAVERSE_API_BASE", "META_PIXEL_ID"]));
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings.join("\n"), /OrnaVerse is partly configured \(1\/3\)/);
  assert.match(p.warnings.join("\n"), /Meta is partly configured.*META_CAPI_ACCESS_TOKEN/);
});

test("planSecrets: optional manager id is never a warning on its own", () => {
  const all = ["LUCIRA_CREDS_CAPI", "INTERNAL_TOKEN", ...ORNA, "META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_CONVERSION_ACTION_OFFLINE"];
  const p = d.planSecrets(new Set(all));
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.missing, ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]);
});

test("planSettings: production defaults, env overrides, test code warns", () => {
  const def = d.planSettings("proj", {});
  assert.equal(def.settings.GOOGLE_VALIDATE_ONLY, "true");
  assert.equal(def.settings.ORNAVERSE_POSTED_STATUSES, "1");
  assert.equal(def.settings.GOOGLE_CLOUD_PROJECT, "proj");
  assert.equal(def.settings.META_TEST_EVENT_CODE, undefined);
  assert.deepEqual(def.warnings, []);

  const o = d.planSettings("proj", { ORNAVERSE_POSTED_STATUSES: "1,2", META_TEST_EVENT_CODE: "TEST1" });
  assert.equal(o.settings.ORNAVERSE_POSTED_STATUSES, "1,2");
  assert.equal(o.settings.META_TEST_EVENT_CODE, "TEST1");
  assert.equal(o.warnings.length, 1);
});

test("settingsYaml: commas, colons, quotes and | survive exactly", () => {
  const y = d.settingsYaml({ A: "1,2", B: "a: b", C: 'say "hi"', D: "x|y" });
  assert.equal(y, 'A: "1,2"\nB: "a: b"\nC: "say \\"hi\\""\nD: "x|y"\n');
});

test("quoteForCmd (Windows): wraps in quotes, refuses \" and %, fixes trailing backslash", () => {
  assert.equal(d.quoteForCmd("value(state)"), '"value(state)"');
  assert.equal(d.quoteForCmd("a|b&c^d"), '"a|b&c^d"');
  assert.equal(d.quoteForCmd("C:\\dir\\"), '"C:\\dir\\\\"');
  assert.throws(() => d.quoteForCmd('a"b'), /unsafe character/);
  assert.throws(() => d.quoteForCmd("%PATH%"), /unsafe character/);
});

test("cleanSecretInput: PowerShell BOM and line break aren't 'spaces'; real spaces are reported", () => {
  assert.deepEqual(d.cleanSecretInput("﻿abc\r\n"), { value: "abc", trimmedSpaces: false });
  assert.deepEqual(d.cleanSecretInput("abc\n"), { value: "abc", trimmedSpaces: false });
  assert.deepEqual(d.cleanSecretInput(" abc "), { value: "abc", trimmedSpaces: true });
  assert.deepEqual(d.cleanSecretInput("a,b|c^d"), { value: "a,b|c^d", trimmedSpaces: false });
  assert.equal(d.cleanSecretInput("﻿\r\n").value, "");
});

test("checkInternalToken: rejects values that would break the scheduler header", () => {
  assert.equal(d.checkInternalToken("abc-123_XYZ"), "abc-123_XYZ");
  for (const bad of ["", "a,b", 'a"b', "a%b", "a b"]) assert.throws(() => d.checkInternalToken(bad));
});

test("parseArgs: commands, flags, validation", () => {
  const o = d.parseArgs(["service", "--project", "lucira-prod", "--dry-run"]);
  assert.equal(o.command, "service");
  assert.equal(o.project, "lucira-prod");
  assert.equal(o.dryRun, true);
  assert.equal(o.region, "us-central1");
  assert.throws(() => d.parseArgs(["deploy", "--project", "p"]), /command must be/);
  assert.throws(() => d.parseArgs(["service", "--project"]), /needs a value/);
  assert.throws(() => d.parseArgs(["service", "--project", "Bad Name"]), /invalid --project/);
  assert.throws(() => d.parseArgs(["service", "--nope"]), /unknown option/);
});

test("parseArgs: secret only accepts known names, no dry-run; grant validates the service account", () => {
  const s = d.parseArgs(["secret", "ORNAVERSE_CLIENT_SECRET", "--project", "p1"]);
  assert.equal(s.secretName, "ORNAVERSE_CLIENT_SECRET");
  assert.throws(() => d.parseArgs(["secret", "TYPO_NAME", "--project", "p1"]), /known name/);
  assert.throws(() => d.parseArgs(["secret", "--project", "p1"]), /known name/);
  assert.throws(() => d.parseArgs(["secret", "LUCIRA_CREDS_CAPI", "--project", "p1", "--dry-run"]), /no --dry-run/);
  const g = d.parseArgs(["grant", "--project", "p1", "--service-account", "capi@p1.iam.gserviceaccount.com"]);
  assert.equal(g.serviceAccount, "capi@p1.iam.gserviceaccount.com");
  assert.throws(() => d.parseArgs(["grant", "--project", "p1", "--service-account", "x;rm"]), /invalid --service-account/);
});

test("scheduler jobs: re-scan stays off the hour so it never collides with the hourly pull", () => {
  const rescan = d.JOBS.find((j: { suffix: string }) => j.suffix === "sync-offline-rescan");
  assert.ok(rescan);
  assert.notEqual(rescan.schedule.split(" ")[0], "0");
});
