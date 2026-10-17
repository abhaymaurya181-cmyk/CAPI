import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  trustProxy: true,
});

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

app.get("/healthz", async () => ({ status: "ok", ts: Date.now() }));

app.post("/identify", async (req, reply) => {
  req.log.info({ body: req.body }, "identify received");
  return reply.code(202).send({ accepted: true });
});

app.post("/webhook/shopify", async (req, reply) => {
  req.log.info("shopify webhook received");
  return reply.code(202).send({ accepted: true });
});

app.post("/webhook/ornaverse", async (req, reply) => {
  req.log.info("ornaverse webhook received");
  return reply.code(202).send({ accepted: true });
});

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
