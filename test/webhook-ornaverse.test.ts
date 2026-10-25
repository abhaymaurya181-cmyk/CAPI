import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import Fastify from "fastify";
import ornaverseWebhookRoute from "../src/routes/webhook-ornaverse.js";

async function appWithCapturedLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const app = Fastify({ logger: { level: "info", stream } });
  await app.register(ornaverseWebhookRoute);
  return { app, lines };
}

test("webhook stub: accepts the delivery but never logs customer data", async () => {
  const { app, lines } = await appWithCapturedLogs();
  const res = await app.inject({
    method: "POST",
    url: "/webhook/ornaverse",
    payload: {
      transaction_id: 555,
      party_name: "Priya Sharma",
      mobile: "9876543210",
      email: "priya@example.com",
    },
  });
  assert.equal(res.statusCode, 202);

  const log = lines.join("\n");
  assert.match(log, /ornaverse webhook received/);
  // Field names are fine (shape), values are not.
  assert.match(log, /"fields":\["transaction_id","party_name","mobile","email"\]/);
  for (const pii of ["Priya", "9876543210", "priya@example.com"]) {
    assert.ok(!log.includes(pii), `log must not contain ${pii}`);
  }
  await app.close();
});

test("webhook stub: array or empty bodies don't crash and log no values", async () => {
  const { app, lines } = await appWithCapturedLogs();
  const arr = await app.inject({
    method: "POST",
    url: "/webhook/ornaverse",
    payload: [{ mobile: "9876543210" }],
  });
  assert.equal(arr.statusCode, 202);
  const empty = await app.inject({ method: "POST", url: "/webhook/ornaverse" });
  assert.equal(empty.statusCode, 202);
  assert.ok(!lines.join("\n").includes("9876543210"));
  await app.close();
});
