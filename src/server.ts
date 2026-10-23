import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import staticPlugin from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import identifyRoute from "./routes/identify.js";
import ornaverseWebhookRoute from "./routes/webhook-ornaverse.js";
import uploadCsvRoute from "./routes/upload-csv.js";
import retrySweepRoute from "./routes/retry-sweep.js";
import syncRoute from "./routes/sync.js";
import adminApiRoute from "./routes/admin-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  trustProxy: true,
});

// Capture raw body for webhook signature verification (OrnaVerse).
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    try {
      done(null, buf.length > 0 ? JSON.parse(buf.toString("utf8")) : {});
    } catch (err) {
      done(err as Error);
    }
  }
);

await app.register(cors, {
  origin: [
    "https://www.lucirajewelry.com",
    "https://lucirajewelry.com",
    /^https:\/\/.*\.vercel\.app$/,
    /^http:\/\/localhost:\d+$/,
  ],
  credentials: true,
});

await app.register(formbody);
await app.register(cookie);

app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

const trackerPath = join(__dirname, "..", "public", "t.js");
let trackerCache: Buffer | null = null;
const LCID_MAX_AGE_SECONDS = 63_072_000; // 2 years

// Derive the apex domain (.example.com) from Host so the cookie is shared by
// www. / checkout. / etc. Localhost or bare-IP hosts get no Domain attribute.
function cookieDomainFromHost(host?: string): string | undefined {
  if (!host) return undefined;
  const bare = host.split(":")[0];
  if (bare === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) return undefined;
  const parts = bare.split(".");
  if (parts.length < 2) return undefined;
  return "." + parts.slice(-2).join(".");
}

// Lucira's site loads /t.js on every page, so this endpoint is the natural
// place to refresh the lcid cookie. If a visitor already has one, re-stamp
// the Max-Age so the expiry window slides forward on every return visit.
// First-time visitors still get their lcid minted by POST /identify — the
// SDK does that on identify calls — this just extends the existing one.
app.get("/t.js", async (req, reply) => {
  if (!trackerCache) trackerCache = await readFile(trackerPath);
  const existingLcid = req.cookies?.lcid;
  if (existingLcid) {
    reply.setCookie("lcid", existingLcid, {
      path: "/",
      httpOnly: true,
      secure: req.protocol === "https",
      sameSite: "lax",
      maxAge: LCID_MAX_AGE_SECONDS,
      domain: cookieDomainFromHost(req.headers.host),
    });
  }
  reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Cache-Control", "public, max-age=300")
    .send(trackerCache);
});

await app.register(identifyRoute);
await app.register(ornaverseWebhookRoute);
await app.register(adminApiRoute);
await app.register(uploadCsvRoute);
await app.register(retrySweepRoute);
await app.register(syncRoute);

// Admin UI (static HTML/JS). Must register AFTER /admin/api/* so the API
// routes take precedence over the static handler.
await app.register(staticPlugin, {
  root: join(__dirname, "..", "public", "admin"),
  prefix: "/admin/",
  decorateReply: false,
  index: ["index.html"],
});

app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
