import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Guard: require a bearer token matching the given env var.
 * Returns true if request should proceed; sends 401 and returns false otherwise.
 */
export function requireBearer(
  req: FastifyRequest,
  reply: FastifyReply,
  envName: "ADMIN_TOKEN" | "INTERNAL_TOKEN"
): boolean {
  const expected = process.env[envName];
  if (!expected) {
    reply.code(500).send({ error: "server_misconfigured" });
    return false;
  }
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== expected) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}
