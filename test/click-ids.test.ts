import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clickMode,
  googleClickFromCookies,
  mergeGoogleClick,
  mergeMetaClick,
  metaClickFromCookies,
  parseFbCookie,
  parseGaClientId,
  parseGclCookie,
  selectClicks,
} from "../src/lib/click-ids.js";
import type { Visitor } from "../src/lib/firestore.js";

const device = { ip_address: "1.2.3.4", user_agent: "UA" };
const NOW = 1_760_000_000_000;

test("cookie parsers", () => {
  assert.deepEqual(parseFbCookie("fb.1.1759999999000.AbC"), { at: 1759999999000, value: "AbC" });
  assert.equal(parseFbCookie("fb.1.1759999999.AbC").at, 1759999999000, "seconds → ms");
  assert.deepEqual(parseFbCookie("junk"), {});
  assert.deepEqual(parseGclCookie("GCL.1759999999.Cj0K"), { at: 1759999999000, value: "Cj0K" });
  assert.equal(parseGaClientId("GA1.1.123456789.1759999999"), "123456789.1759999999");
  assert.equal(parseGaClientId("junk"), undefined);
});

test("meta click: time from _fbc; fbc built from fbclid alone", () => {
  const m = metaClickFromCookies({ _fbc: "fb.1.1759000000000.F1" }, undefined, device, NOW)!;
  assert.equal(m.fbclid, "F1");
  assert.equal(m.captured_at.toMillis(), 1759000000000);

  const built = metaClickFromCookies({ fbclid: "F2" }, undefined, device, NOW)!;
  assert.equal(built.fbc, `fb.1.${NOW}.F2`);

  assert.equal(metaClickFromCookies({}, undefined, device, NOW), null);
});

test("google click: own cookie, _gcl_aw fallback, same-landing ids grouped", () => {
  const aw = googleClickFromCookies({ _gcl_aw: "GCL.1759000000.AW1" }, undefined, device, NOW)!;
  assert.equal(aw.gclid, "AW1");
  assert.equal(aw.captured_at.toMillis(), 1759000000000);

  const both = googleClickFromCookies(
    { gclid: "G1", gclid_at: 1759500000000, gbraid: "B1", gbraid_at: 1759500010000 },
    undefined, device, NOW
  )!;
  assert.equal(both.gclid, "G1");
  assert.equal(both.gbraid, "B1");

  const separate = googleClickFromCookies(
    { gclid: "OLD", gclid_at: 1750000000000, wbraid: "W1", wbraid_at: 1759500000000 },
    undefined, device, NOW
  )!;
  assert.equal(separate.wbraid, "W1");
  assert.equal(separate.gclid, undefined, "an older, separate click is not mixed in");
});

test("first is kept, last moves, repeat click is a no-op", () => {
  const a = metaClickFromCookies({ fbclid: "A" }, undefined, device, NOW);
  const pair = mergeMetaClick(null, a)!;
  assert.equal(pair.first?.fbclid, "A");
  assert.equal(pair.last?.fbclid, "A");

  let v = { click_ids: { meta: pair } } as Visitor;
  assert.equal(mergeMetaClick(v, a), null);

  const b = metaClickFromCookies({ fbclid: "B" }, undefined, device, NOW + 1000);
  const next = mergeMetaClick(v, b)!;
  assert.equal(next.first?.fbclid, "A");
  assert.equal(next.last?.fbclid, "B");

  v = { click_ids: { meta: next } } as Visitor;
  assert.equal(selectClicks(v, "last").meta?.fbclid, "B");
  assert.equal(selectClicks(v, "first").meta?.fbclid, "A");
});

test("google merge keys on gclid/gbraid/wbraid", () => {
  const g = googleClickFromCookies({ gbraid: "B1" }, undefined, device, NOW);
  const pair = mergeGoogleClick(null, g)!;
  const v = { click_ids: { google: pair } } as Visitor;
  assert.equal(mergeGoogleClick(v, g), null);
});

test("CLICK_MODE defaults to last", () => {
  const saved = process.env.CLICK_MODE;
  delete process.env.CLICK_MODE;
  assert.equal(clickMode(), "last");
  process.env.CLICK_MODE = "first";
  assert.equal(clickMode(), "first");
  process.env.CLICK_MODE = "nonsense";
  assert.equal(clickMode(), "last");
  if (saved === undefined) delete process.env.CLICK_MODE;
  else process.env.CLICK_MODE = saved;
  assert.deepEqual(selectClicks(null), { meta: undefined, google: undefined });
});
