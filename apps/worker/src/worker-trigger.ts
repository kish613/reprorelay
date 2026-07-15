import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { runWorkerOnce } from "./run-once.js";

type RunWorkerOnce = (env: NodeJS.ProcessEnv) => Promise<unknown>;

export function registerWorkerTrigger(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
  run: RunWorkerOnce = runWorkerOnce,
): void {
  app.post("/internal/worker", async (request, reply) => {
    const expected = env.REPRORELAY_INTERNAL_TOKEN;
    const authorization = request.headers.authorization;
    if (!expected || !authorization?.startsWith("Bearer ") || !safeEqual(authorization.slice(7), expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const configuredApiUrl = normalizeApiUrl(env.REPRORELAY_API_URL ?? "http://localhost:4000");
    if (!configuredApiUrl) {
      return reply.code(500).send({ error: "REPRORELAY_API_URL is invalid" });
    }

    // Older API versions sent their public URL in the trigger body. Keep that
    // request shape compatible only when it resolves to the configured trusted
    // origin; never let a trigger caller select the worker's report authority.
    const requestedApiUrl = (request.body as { apiUrl?: unknown } | undefined)?.apiUrl;
    if (requestedApiUrl !== undefined && (
      typeof requestedApiUrl !== "string" || normalizeApiUrl(requestedApiUrl) !== configuredApiUrl
    )) {
      return reply.code(400).send({ error: "API URL must match REPRORELAY_API_URL" });
    }

    return run({ ...env, REPRORELAY_API_URL: configuredApiUrl });
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = new TextEncoder().encode(left);
  const rightBuffer = new TextEncoder().encode(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeApiUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
    if (!allowedProtocol || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
