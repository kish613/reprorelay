import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GitHubClient } from "@reprorelay/github";
import {
  createGitHubClientForRepo,
  exchangeManifestCode,
  listAccessibleRepos,
  type ConvertedGitHubApp,
} from "@reprorelay/github";
import type { ReportRecord } from "@reprorelay/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "./config.js";
import type { ReportStore } from "./store.js";

/** Injectable GitHub calls so tests can run without touching github.com. */
export interface GitHubConnectService {
  exchangeManifestCode(code: string): Promise<ConvertedGitHubApp>;
  /** Returns only private repositories; public targets cannot safely receive report metadata. */
  listRepos(credentials: { appId: number; privateKey: string }): Promise<string[]>;
}

export const defaultGitHubConnectService: GitHubConnectService = {
  exchangeManifestCode,
  listRepos: (credentials) => listAccessibleRepos(credentials),
};

interface RegisterOptions {
  config: ApiConfig;
  store: ReportStore;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  service: GitHubConnectService;
}

const STATE_TTL_SECONDS = 600;

export function registerGitHubConnectRoutes(app: FastifyInstance, { config, store, requireAdmin, service }: RegisterOptions): void {
  app.get("/v1/admin/github", { preHandler: requireAdmin }, async () => {
    const ghApp = await store.getGitHubApp();
    if (!ghApp) return { connected: false };
    return {
      connected: true,
      slug: ghApp.slug,
      name: ghApp.name,
      htmlUrl: ghApp.htmlUrl,
      manageUrl: `https://github.com/apps/${ghApp.slug}/installations/new`,
      createdAt: ghApp.createdAt,
    };
  });

  // Renders a tiny page whose form posts the app manifest to GitHub. One click
  // there creates a pre-configured GitHub App and bounces back to the callback.
  app.get("/v1/admin/github/connect", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!config.admin.sessionSecret) return reply.code(503).send({ error: "Admin authentication is not configured" });
    const state = signState(config.admin.sessionSecret);
    const manifest = buildManifest(config);
    const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return reply.type("text/html").send(connectPage(action, JSON.stringify(manifest)));
  });

  // GitHub redirects here after the app is created. The state token is the
  // auth (SameSite=Strict cookies don't survive the cross-site redirect).
  app.get("/v1/admin/github/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!config.admin.sessionSecret || !state || !verifyState(state, config.admin.sessionSecret)) {
      return reply.code(400).send({ error: "Invalid or expired connect state" });
    }
    if (!code) return reply.code(400).send({ error: "Missing manifest code" });

    const converted = await service.exchangeManifestCode(code);
    await store.saveGitHubApp({
      appId: converted.appId,
      slug: converted.slug,
      name: converted.name,
      clientId: converted.clientId,
      clientSecret: converted.clientSecret,
      webhookSecret: converted.webhookSecret,
      pem: converted.pem,
      htmlUrl: converted.htmlUrl,
      createdAt: new Date().toISOString(),
    });
    // Straight on to GitHub's install screen so the user picks repositories.
    return reply.redirect(`https://github.com/apps/${converted.slug}/installations/new`, 302);
  });

  // GitHub's post-install redirect. Nothing to store (installations are
  // resolved on demand) — just land the user back on the dashboard.
  app.get("/v1/admin/github/setup", async (_request, reply) => reply.redirect(config.publicUrl, 302));

  app.get("/v1/admin/github/repos", { preHandler: requireAdmin }, async (_request, reply) => {
    const ghApp = await store.getGitHubApp();
    if (!ghApp) return reply.code(404).send({ error: "GitHub is not connected" });
    return service.listRepos({ appId: ghApp.appId, privateKey: ghApp.pem });
  });

  app.delete("/v1/admin/github", { preHandler: requireAdmin }, async () => {
    await store.deleteGitHubApp();
    return { ok: true };
  });
}

/**
 * Per-report GitHub client for the worker: dashboard-connected app credentials
 * plus the report's project→repo link. Returns undefined (and logs) rather
 * than failing the whole worker run when GitHub is unreachable.
 */
export function createStoreGitHubResolver(store: ReportStore, log: { warn(obj: unknown, msg?: string): void }) {
  return async (report: ReportRecord): Promise<GitHubClient | undefined> => {
    try {
      const ghApp = await store.getGitHubApp();
      if (!ghApp) return undefined;
      const project = await store.getProject(report.projectKey);
      if (!project?.githubRepo) return undefined;
      const [owner, repo] = project.githubRepo.split("/", 2);
      if (!owner || !repo) return undefined;
      return await createGitHubClientForRepo({ appId: ghApp.appId, privateKey: ghApp.pem }, owner, repo);
    } catch (error) {
      log.warn({ error, projectKey: report.projectKey }, "Could not build a GitHub client for this report's project");
      return undefined;
    }
  };
}

export function isValidRepoFullName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function buildManifest(config: ApiConfig): Record<string, unknown> {
  const base = config.publicUrl.replace(/\/$/, "");
  return {
    name: `reprorelay-${randomBytes(3).toString("hex")}`,
    url: base,
    hook_attributes: { url: `${base}/v1/webhooks/github` },
    redirect_url: `${base}/v1/admin/github/callback`,
    setup_url: `${base}/v1/admin/github/setup`,
    public: false,
    default_permissions: { issues: "write", metadata: "read" },
    default_events: ["issues", "issue_comment"],
  };
}

function connectPage(action: string, manifestJson: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Connect GitHub — ReproRelay</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #16180f; color: #edefe6; }
  main { max-width: 420px; padding: 32px; text-align: center; }
  h1 { font-size: 22px; }
  p { color: #969b8c; line-height: 1.6; }
  button { margin-top: 12px; padding: 12px 22px; border: 0; border-radius: 10px; background: #f2581f; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
</style></head>
<body><main>
  <h1>Connect GitHub</h1>
  <p>GitHub will create a private <b>ReproRelay issues app</b> on your account with the right permissions already set, then let you choose which repositories it can file issues in.</p>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
    <button type="submit">Continue to GitHub</button>
  </form>
</main></body></html>`;
}

function signState(secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  return `${expiresAt}.${stateSignature(String(expiresAt), secret)}`;
}

function verifyState(state: string, secret: string): boolean {
  const separator = state.indexOf(".");
  if (separator < 1) return false;
  const payload = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expected = stateSignature(payload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stateSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`github-manifest:${payload}`).digest("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
