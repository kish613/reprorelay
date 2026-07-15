import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";

const ADMIN_COOKIE = "reprorelay_admin";

/** Who a request is authenticated as. `userId` is set for team-member sessions. */
export interface AdminIdentity {
  via: "internal-token" | "shared-password" | "user";
  userId?: string;
}

export interface AdminAuth {
  authenticate(request: FastifyRequest): AdminIdentity | undefined;
  createSessionCookie(userId?: string): string;
  clearSessionCookie(): string;
  isConfigured(): boolean;
  verifyPassword(password: string): boolean;
}

export function createAdminAuth(config: ApiConfig["admin"]): AdminAuth {
  function isConfigured(): boolean {
    return Boolean(config.password && config.sessionSecret && config.internalToken);
  }

  function verifyPassword(password: string): boolean {
    return Boolean(config.password) && safeEqual(password, config.password ?? "");
  }

  function authenticate(request: FastifyRequest): AdminIdentity | undefined {
    if (!isConfigured()) return undefined;

    const authorization = headerValue(request.headers.authorization);
    if (authorization?.startsWith("Bearer ") && safeEqual(authorization.slice(7), config.internalToken ?? "")) {
      return { via: "internal-token" };
    }

    const token = parseCookies(headerValue(request.headers.cookie))[ADMIN_COOKIE];
    if (!token) return undefined;
    return verifySessionToken(token, config.sessionSecret ?? "");
  }

  function createSessionCookie(userId?: string): string {
    if (!config.sessionSecret) throw new Error("REPRORELAY_ADMIN_SESSION_SECRET is not configured");
    const expiresAt = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
    const payload = userId ? `${expiresAt}:${userId}` : String(expiresAt);
    const signature = sign(payload, config.sessionSecret);
    return serializeCookie(`${payload}.${signature}`, config.sessionTtlSeconds, config.secureCookies);
  }

  function clearSessionCookie(): string {
    return serializeCookie("", 0, config.secureCookies);
  }

  return { authenticate, createSessionCookie, clearSessionCookie, isConfigured, verifyPassword };
}

export function requireAdmin(auth: AdminAuth, userExists?: (userId: string) => Promise<boolean>) {
  return async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!auth.isConfigured()) {
      await reply.code(503).send({ error: "Admin authentication is not configured" });
      return;
    }
    const identity = auth.authenticate(request);
    if (!identity) {
      await reply.code(401).send({ error: "Authentication required" });
      return;
    }
    // Team-member sessions die as soon as the account is removed.
    if (identity.userId && userExists && !(await userExists(identity.userId))) {
      await reply.code(401).send({ error: "Authentication required" });
      return;
    }
    setAdminIdentity(request, identity);
  };
}

export function setAdminIdentity(request: FastifyRequest, identity: AdminIdentity): void {
  (request as FastifyRequest & { adminIdentity?: AdminIdentity }).adminIdentity = identity;
}

export function getAdminIdentity(request: FastifyRequest): AdminIdentity | undefined {
  return (request as FastifyRequest & { adminIdentity?: AdminIdentity }).adminIdentity;
}

/** scrypt hash for team-member passwords; format `scrypt:<salt>:<hash>` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const [scheme, rawSalt, rawHash] = stored.split(":");
  if (scheme !== "scrypt" || !rawSalt || !rawHash) return false;
  const expected = Buffer.from(rawHash, "base64url");
  const actual = scryptSync(password, Buffer.from(rawSalt, "base64url"), expected.byteLength);
  return expected.byteLength > 0 && timingSafeEqual(actual, expected);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verifySessionToken(token: string, secret: string): AdminIdentity | undefined {
  const separator = token.indexOf(".");
  if (separator < 1) return undefined;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, secret))) return undefined;

  const [rawExpiresAt, userId] = payload.split(":");
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
  return userId ? { via: "user", userId } : { via: "shared-password" };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = new TextEncoder().encode(left);
  const rightBuffer = new TextEncoder().encode(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      return [[key, decodeURIComponent(rawValue)]];
    } catch {
      return [];
    }
  }));
}

function serializeCookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : undefined,
  ].filter(Boolean).join("; ");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
