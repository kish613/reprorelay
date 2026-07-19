import cors from "@fastify/cors";
import { runWorkerOnce } from "@reprorelay/worker";
import { waitUntil } from "@vercel/functions";
import {
  AssetContentTypeSchema,
  AssetKindSchema,
  ProjectKeySchema,
  ProjectReportStatusSchema,
  ProjectReportStatusesRequestSchema,
  ProjectReportStatusesResponseSchema,
  PublicReportStatusSchema,
  ReportNoteSchema,
  ReportPayloadSchema,
  ReportRecordSchema,
  ReportStatusesRequestSchema,
  ReportStatusesResponseSchema,
  SessionResponseSchema,
  UploadIntentSchema,
  UserContextSchema,
  type PublicReportStatus,
  type ReportRecord,
} from "@reprorelay/shared";
import Fastify, { type FastifyRequest } from "fastify";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { createAdminAuth, getAdminIdentity, hashPassword, requireAdmin, verifyPasswordHash } from "./admin-auth.js";
import type { ApiConfig } from "./config.js";
import { buildReportReplyEmail, emailEnabled, sendReplyEmail } from "./email.js";
import {
  createStoreGitHubResolver,
  defaultGitHubConnectService,
  isValidRepoFullName,
  registerGitHubConnectRoutes,
  type GitHubConnectService,
} from "./github-connect.js";
import { deleteExpiredVideos } from "./retention.js";
import { buildAssetUrl, buildObjectKey, createObjectStorage, type LocalObjectStorage, type ObjectStorage } from "./storage.js";
import { createStore, type ReportStore, type StoredSession, type StoredUser } from "./store.js";
import { verifyGitHubSignature } from "./webhooks.js";

interface AppDependencies {
  config: ApiConfig;
  store?: ReportStore;
  storage?: ObjectStorage;
  storeInitRetryDelaysMs?: readonly number[];
  githubConnect?: GitHubConnectService;
}

const DEFAULT_STORE_INIT_RETRY_DELAYS_MS = [100, 500] as const;

export async function buildApp({
  config,
  store = createStore(config.databaseUrl),
  storage = createObjectStorage(config),
  storeInitRetryDelaysMs = DEFAULT_STORE_INIT_RETRY_DELAYS_MS,
  githubConnect = defaultGitHubConnectService,
}: AppDependencies) {
  const app = Fastify({ logger: true });
  const adminAuth = createAdminAuth(config.admin);
  const authenticateAdmin = requireAdmin(adminAuth, async (userId) => Boolean(await store.getUserById(userId)));

  // Origins granted CORS access = env CORS_ORIGINS plus every project's
  // registered origins, so connecting a new app never needs a redeploy.
  let projectOriginsCache: { origins: Set<string>; expiresAt: number } | undefined;
  async function isAllowedOrigin(origin: string): Promise<boolean> {
    if (config.corsOrigins.includes(origin)) return true;
    if (!projectOriginsCache || projectOriginsCache.expiresAt < Date.now()) {
      const projects = await store.listProjects();
      projectOriginsCache = {
        origins: new Set(projects.flatMap((project) => project.origins)),
        expiresAt: Date.now() + 30_000,
      };
    }
    return projectOriginsCache.origins.has(origin);
  }
  const invalidateProjectOrigins = () => { projectOriginsCache = undefined; };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }

    const statusCode = getErrorStatusCode(error);
    if (statusCode >= 500) request.log.error(error instanceof Error ? error : { error });
    const message = error instanceof Error ? error.message : "Request failed";
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal server error" : message });
  });

  app.addContentTypeParser(["application/octet-stream", "image/png", "image/jpeg", "video/webm", "video/mp4"], { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      isAllowedOrigin(origin).then((allowed) => {
        if (allowed) callback(null, true);
        else callback(Object.assign(new Error(`Origin ${origin} is not allowed`), { statusCode: 403 }), false);
      }, (error) => callback(error instanceof Error ? error : new Error("Origin check failed"), false));
    },
    credentials: true,
  });

  await initializeStore(store, storeInitRetryDelaysMs, app.log);
  await seedProjectsFromEnv(store, config.projectKeys);

  // A project key is valid when the env allowlist or the store knows it. An
  // unconfigured deployment (no allowlist, no projects) accepts any key so
  // local development keeps working out of the box.
  async function isKnownProject(projectKey: string): Promise<boolean> {
    if (config.projectKeys.includes(projectKey)) return true;
    if (await store.getProject(projectKey)) return true;
    return config.projectKeys.length === 0 && (await store.listProjects()).length === 0;
  }

  async function operatorName(request: FastifyRequest): Promise<string> {
    const identity = getAdminIdentity(request);
    const user = identity?.userId ? await store.getUserById(identity.userId) : undefined;
    return user?.name ?? "Operator";
  }

  app.get("/health", async () => ({ ok: true, service: "reprorelay-api" }));

  app.post("/v1/admin/login", async (request, reply) => {
    if (!adminAuth.isConfigured()) return reply.code(503).send({ error: "Admin authentication is not configured" });
    const body = request.body as { email?: unknown; password?: unknown } | undefined;
    const password = body?.password;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
    if (typeof password !== "string") return reply.code(401).send({ error: "Invalid credentials" });

    if (email) {
      const user = await store.getUserByEmail(email);
      if (!user || !verifyPasswordHash(password, user.passwordHash)) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }
      return reply
        .header("set-cookie", adminAuth.createSessionCookie(user.id))
        .send({ ok: true, user: publicUser(user) });
    }

    if (!adminAuth.verifyPassword(password)) {
      return reply.code(401).send({ error: "Invalid password" });
    }
    return reply.header("set-cookie", adminAuth.createSessionCookie()).send({ ok: true });
  });

  app.get("/v1/admin/session", { preHandler: authenticateAdmin }, async (request) => {
    const identity = getAdminIdentity(request);
    const user = identity?.userId ? await store.getUserById(identity.userId) : undefined;
    return { ok: true, ...(user ? { user: publicUser(user) } : {}) };
  });

  app.get("/v1/admin/users", { preHandler: authenticateAdmin }, async () =>
    (await store.listUsers()).map(publicUser),
  );

  app.post("/v1/admin/users", { preHandler: authenticateAdmin }, async (request, reply) => {
    const body = request.body as { email?: unknown; name?: unknown; password?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "A valid email address is required" });
    if (!name) return reply.code(400).send({ error: "A name is required" });
    if (password.length < 8) return reply.code(400).send({ error: "Passwords need at least 8 characters" });
    if (await store.getUserByEmail(email)) return reply.code(409).send({ error: "A user with this email already exists" });

    const user: StoredUser = {
      id: randomUUID(),
      email,
      name: name.slice(0, 120),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    try {
      await store.createUser(user);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "A user with this email already exists" });
      throw error;
    }
    return reply.code(201).send(publicUser(user));
  });

  app.delete("/v1/admin/users/:id", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (getAdminIdentity(request)?.userId === id) {
      return reply.code(400).send({ error: "You cannot remove your own account" });
    }
    const deleted = await store.deleteUser(id);
    return deleted ? { ok: true } : reply.code(404).send({ error: "User not found" });
  });

  app.get("/v1/projects", { preHandler: authenticateAdmin }, async () => store.listProjects());

  app.post("/v1/projects", { preHandler: authenticateAdmin }, async (request, reply) => {
    const body = request.body as { name?: unknown; origin?: unknown } | undefined;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "A project name is required" });

    const origins: string[] = [];
    if (body?.origin !== undefined && body?.origin !== "") {
      const origin = normalizeOrigin(body?.origin);
      if (!origin) return reply.code(400).send({ error: "The site origin must be a valid URL such as https://app.example.com" });
      origins.push(origin);
    }

    const project = {
      projectKey: generateProjectKey(name),
      name: name.slice(0, 120),
      origins,
      createdAt: new Date().toISOString(),
    };
    await store.createProject(project);
    invalidateProjectOrigins();
    return reply.code(201).send(project);
  });

  app.patch("/v1/projects/:projectKey", { preHandler: authenticateAdmin }, async (request, reply) => {
    const projectKey = (request.params as { projectKey: string }).projectKey;
    const body = request.body as { githubRepo?: unknown; name?: unknown } | undefined;
    const patch: { githubRepo?: string; name?: string } = {};

    if (body?.githubRepo !== undefined) {
      if (body.githubRepo === null || body.githubRepo === "") {
        patch.githubRepo = undefined;
      } else if (typeof body.githubRepo === "string" && isValidRepoFullName(body.githubRepo)) {
        const ghApp = await store.getGitHubApp();
        if (!ghApp) return reply.code(409).send({ error: "Connect GitHub before linking a repository" });
        const privateRepos = await githubConnect.listRepos({ appId: ghApp.appId, privateKey: ghApp.pem });
        if (!privateRepos.includes(body.githubRepo)) {
          return reply.code(400).send({ error: "Choose a private repository accessible to the ReproRelay GitHub App" });
        }
        patch.githubRepo = body.githubRepo;
      } else {
        return reply.code(400).send({ error: "githubRepo must look like owner/repository" });
      }
    }
    if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);

    const updated = "githubRepo" in patch || patch.name !== undefined
      ? await store.updateProject(projectKey, patch)
      : await store.getProject(projectKey);
    return updated ?? reply.code(404).send({ error: "Project not found" });
  });

  app.delete("/v1/projects/:projectKey", { preHandler: authenticateAdmin }, async (request, reply) => {
    const projectKey = (request.params as { projectKey: string }).projectKey;
    const deleted = await store.deleteProject(projectKey);
    invalidateProjectOrigins();
    return deleted ? { ok: true } : reply.code(404).send({ error: "Project not found" });
  });

  app.post("/v1/admin/logout", async (_request, reply) =>
    reply.header("set-cookie", adminAuth.clearSessionCookie()).send({ ok: true }),
  );

  app.get("/v1/admin/email", { preHandler: authenticateAdmin }, async () => ({
    configured: emailEnabled(config.email),
    from: config.email.replyFrom,
    replyTo: config.email.replyReplyTo,
  }));

  app.post("/v1/internal/worker", { preHandler: authenticateAdmin }, async (request) =>
    runWorkerOnce(process.env, { githubForReport: createStoreGitHubResolver(store, request.log) }),
  );

  app.get("/v1/internal/retention", async (request, reply) => {
    const authorization = headerValue(request.headers.authorization);
    const receivedSecret = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!config.retention.cronSecret || !secureTokenMatches(config.retention.cronSecret, receivedSecret)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const result = await deleteExpiredVideos(store, storage, { retentionDays: config.retention.videoDays });
    if (result.failures > 0) request.log.error({ failures: result.failures }, "Some expired videos could not be deleted");
    return result;
  });

  registerGitHubConnectRoutes(app, { config, store, requireAdmin: authenticateAdmin, service: githubConnect });

  app.post("/v1/sessions", async (request, reply) => {
    const body = request.body as { projectKey?: string };
    const projectKey = ProjectKeySchema.parse(body.projectKey);
    if (!(await isKnownProject(projectKey))) {
      return reply.code(404).send({ error: "Unknown project" });
    }

    const session = {
      sessionId: randomUUID(),
      projectKey,
      uploadToken: randomBytes(24).toString("base64url"),
      expiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await store.createSession(session);
    return SessionResponseSchema.parse({
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      uploadBaseUrl: config.publicUrl,
      uploadToken: session.uploadToken,
    });
  });

  app.post("/v1/uploads", async (request, reply) => {
    const uploadToken = request.headers["x-reprorelay-upload-token"];
    const intent = UploadIntentSchema.parse(request.body);
    const session = await store.getSession(intent.sessionId);

    if (!session || session.projectKey !== intent.projectKey || session.uploadToken !== uploadToken) {
      return reply.code(401).send({ error: "Invalid upload token" });
    }

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      return reply.code(410).send({ error: "Upload session expired" });
    }

    try {
      if (intent.contentLength > config.maxUploadBytes) {
        return reply.code(413).send({ error: `Upload exceeds REPRORELAY_MAX_UPLOAD_BYTES (${config.maxUploadBytes})` });
      }
      return await storage.createUploadIntent(intent, { uploadToken: session.uploadToken });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create upload intent";
      return reply.code(400).send({ error: message });
    }
  });

  app.put("/v1/local-uploads/*", { bodyLimit: config.maxUploadBytes }, async (request, reply) => {
    const objectKey = decodeObjectKey((request.params as { "*": string })["*"]);
    if (!storage.writeLocalObject) return reply.code(404).send({ error: "Local uploads are disabled" });
    const sessionId = objectKey.split("/")[1];
    const session = sessionId ? await store.getSession(sessionId) : undefined;
    const uploadToken = headerValue(request.headers["x-reprorelay-upload-token"]);

    if (!session || session.uploadToken !== uploadToken) {
      return reply.code(401).send({ error: "Invalid upload token" });
    }
    if (isExpired(session)) return reply.code(410).send({ error: "Upload session expired" });

    const contentType = headerValue(request.headers["content-type"])?.split(";", 1)[0];
    const parsedContentType = AssetContentTypeSchema.safeParse(contentType);
    const isExpectedObjectKey = parsedContentType.success && AssetKindSchema.options.some((kind) =>
      buildObjectKey({ projectKey: session.projectKey, sessionId: session.sessionId, kind, contentType: parsedContentType.data }) === objectKey,
    );
    if (!isExpectedObjectKey) return reply.code(415).send({ error: "Upload content type does not match the object key" });

    const body = Buffer.isBuffer(request.body)
      ? request.body
      : typeof request.body === "string"
        ? Buffer.from(request.body)
        : Buffer.from(JSON.stringify(request.body ?? ""));
    if (body.byteLength > config.maxUploadBytes) {
      return reply.code(413).send({ error: `Upload exceeds REPRORELAY_MAX_UPLOAD_BYTES (${config.maxUploadBytes})` });
    }
    await storage.writeLocalObject(objectKey, body);
    return reply.code(204).send();
  });

  // Wildcard route: object keys contain slashes, and Vercel's rewrite layer
  // decodes %2F before the request reaches Fastify, so a single-segment
  // ":objectKey" param never matches in production.
  app.get("/v1/assets/*", { preHandler: authenticateAdmin }, async (request, reply) => {
    const objectKey = decodeObjectKey((request.params as { "*": string })["*"]);
    try {
      // Prefer a short-lived direct download URL: the browser then streams the
      // evidence (notably video) straight from object storage with native Range
      // support, instead of proxying the whole body through this function.
      let downloadUrl: string | undefined;
      try {
        downloadUrl = await storage.createDownloadUrl?.(objectKey);
      } catch (error) {
        // Presigning is an optimization — fall back to proxying rather than 404.
        request.log.warn({ error, objectKey }, "Presigning the asset download failed; proxying instead");
      }
      if (downloadUrl) {
        return reply.header("cache-control", "private, no-store").redirect(downloadUrl, 302);
      }

      const asset = await storage.readObject(objectKey);
      reply.header("accept-ranges", "bytes");
      const range = parseRangeHeader(headerValue(request.headers.range), asset.body.byteLength);
      if (range === "unsatisfiable") {
        return reply.code(416).header("content-range", `bytes */${asset.body.byteLength}`).send();
      }
      const contentType = asset.contentType ?? "application/octet-stream";
      if (range) {
        return reply
          .code(206)
          .header("content-range", `bytes ${range.start}-${range.end}/${asset.body.byteLength}`)
          .type(contentType)
          .send(asset.body.subarray(range.start, range.end + 1));
      }
      return reply.type(contentType).send(asset.body);
    } catch {
      return reply.code(404).send({ error: "Asset not found" });
    }
  });

  app.post("/v1/reports", async (request, reply) => {
    const payload = ReportPayloadSchema.parse(request.body);
    const uploadToken = headerValue(request.headers["x-reprorelay-upload-token"]);
    const session = await store.getSession(payload.sessionId);
    if (!session || session.projectKey !== payload.projectKey || session.uploadToken !== uploadToken) {
      return reply.code(401).send({ error: "Invalid report session" });
    }
    if (isExpired(session)) return reply.code(410).send({ error: "Report session expired" });

    const hasInvalidAsset = payload.assets.some((asset) =>
      asset.objectKey !== buildObjectKey({
        projectKey: payload.projectKey,
        sessionId: payload.sessionId,
        kind: asset.kind,
        contentType: asset.contentType,
      }) || (asset.size !== undefined && asset.size > config.maxUploadBytes),
    );
    if (hasInvalidAsset) return reply.code(400).send({ error: "Report contains an invalid or foreign asset" });

    const safePayload = {
      ...payload,
      assets: payload.assets.map((asset) => ({ ...asset, url: buildAssetUrl(config.publicUrl, asset.objectKey) })),
    };
    const record: ReportRecord = ReportRecordSchema.parse({
      ...safePayload,
      id: randomUUID(),
      status: "new",
      updatedAt: safePayload.createdAt,
      agentStatus: "pending",
    });

    await store.createReport(record);
    triggerWorker(config, request.log);
    return reply.code(201).send(record);
  });

  app.post("/v1/report-statuses", async (request) => {
    const input = ReportStatusesRequestSchema.parse(request.body);
    const statuses: PublicReportStatus[] = [];

    // A receipt is a capability issued only to the browser that submitted the
    // report. Invalid or foreign receipts are omitted so this endpoint cannot
    // be used to discover another project's reports.
    for (const receipt of input.receipts) {
      const report = await store.getReport(receipt.id);
      if (!report || report.projectKey !== input.projectKey) continue;
      const session = await store.getSession(report.sessionId);
      if (
        !session
        || session.projectKey !== input.projectKey
        || !secureTokenMatches(session.uploadToken, receipt.trackingToken)
      ) continue;

      statuses.push(PublicReportStatusSchema.parse({
        id: report.id,
        status: report.status,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt ?? report.createdAt,
        seenAt: report.seenAt,
        hadVideo: report.assets.some((asset) => asset.kind === "video"),
        hadScreenshot: report.assets.some((asset) => asset.kind === "screenshot"),
        messages: reporterMessages(report),
      }));
    }

    return ReportStatusesResponseSchema.parse({ reports: statuses });
  });

  app.post("/v1/project-report-statuses", async (request, reply) => {
    const input = ProjectReportStatusesRequestSchema.parse(request.body);
    const expectedKey = config.statusApiKeys[input.projectKey];
    const authorization = request.headers.authorization;
    const receivedKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!expectedKey || !receivedKey || !secureTokenMatches(expectedKey, receivedKey)) {
      return reply.code(401).send({ error: "Invalid project status credentials" });
    }

    const reports = (await store.listReports(input.projectKey)).slice(0, 20).map((report) =>
      ProjectReportStatusSchema.parse({
        id: report.id,
        title: report.title,
        severity: report.severity,
        status: report.status,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt ?? report.createdAt,
        seenAt: report.seenAt,
        hadVideo: report.assets.some((asset) => asset.kind === "video"),
        hadScreenshot: report.assets.some((asset) => asset.kind === "screenshot"),
        messages: reporterMessages(report),
      }));

    return ProjectReportStatusesResponseSchema.parse({ reports });
  });

  app.get("/v1/reports", { preHandler: authenticateAdmin }, async (request) => {
    const query = request.query as { projectKey?: string; includeArchived?: string };
    const reports = await store.listReports(query.projectKey);
    return query.includeArchived === "true" ? reports : reports.filter((report) => !report.archivedAt);
  });

  app.get("/v1/reports/:id", { preHandler: authenticateAdmin }, async (request, reply) => {
    const report = await store.getReport((request.params as { id: string }).id);
    return report ?? reply.code(404).send({ error: "Report not found" });
  });

  app.patch("/v1/reports/:id", { preHandler: authenticateAdmin }, async (request, reply) => {
    const patch = request.body as Partial<ReportRecord>;
    const allowedPatch: Partial<ReportRecord> = {};
    assignIfDefined(allowedPatch, "status", patch.status);
    assignIfDefined(allowedPatch, "githubIssueUrl", patch.githubIssueUrl);
    assignIfDefined(allowedPatch, "githubIssueNumber", patch.githubIssueNumber);
    assignIfDefined(allowedPatch, "agentStatus", patch.agentStatus);
    assignIfDefined(allowedPatch, "aiTriage", patch.aiTriage);
    assignIfDefined(allowedPatch, "humanReview", patch.humanReview);
    assignIfDefined(allowedPatch, "seenAt", patch.seenAt);
    const updated = await store.updateReport((request.params as { id: string }).id, allowedPatch);
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/archive", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    if (existing.archivedAt) return existing;
    const updated = await store.updateReport(id, {
      archivedAt: new Date().toISOString(),
      archivedBy: await operatorName(request),
    });
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.delete("/v1/reports/:id/archive", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    const updated = await store.updateReport(id, { archivedAt: undefined, archivedBy: undefined });
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/notes", { preHandler: authenticateAdmin }, async (request, reply) => {
    const rawBody = (request.body as { body?: unknown } | undefined)?.body;
    if (typeof rawBody !== "string" || !rawBody.trim()) return reply.code(400).send({ error: "A note body is required" });
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    const note = ReportNoteSchema.parse({
      id: randomUUID(),
      author: await operatorName(request),
      body: rawBody.trim().slice(0, 8000),
      channel: "note",
      createdAt: new Date().toISOString(),
    });
    const updated = await store.updateReport(id, { notes: [...(existing.notes ?? []), note] });
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/reply", { preHandler: authenticateAdmin }, async (request, reply) => {
    const rawBody = (request.body as { body?: unknown } | undefined)?.body;
    if (typeof rawBody !== "string" || !rawBody.trim()) return reply.code(400).send({ error: "A reply body is required" });
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    const to = existing.user?.email;

    const message = rawBody.trim().slice(0, 8000);
    let providerId: string | undefined;
    let emailDelivery: "sent" | "failed" | undefined;

    // The widget is the durable reply channel. Email is a best-effort copy and
    // must never prevent the reporter-visible message from being persisted.
    if (to && emailEnabled(config.email)) {
      try {
        const delivery = await sendReplyEmail(config.email, {
          to,
          ...buildReportReplyEmail({
            reportId: existing.id,
            reportTitle: existing.title,
            reportComment: existing.comment,
            message,
            reporterName: existing.user?.name,
          }),
        });
        providerId = delivery.id;
        emailDelivery = "sent";
      } catch (error) {
        emailDelivery = "failed";
        request.log.warn({ err: error, reportId: id }, "Reporter reply saved to widget but email copy failed");
      }
    }

    const note = ReportNoteSchema.parse({
      id: randomUUID(),
      author: await operatorName(request),
      body: message,
      channel: "reply",
      emailDelivery,
      providerId,
      createdAt: new Date().toISOString(),
    });
    const updated = await store.updateReport(id, { notes: [...(existing.notes ?? []), note] });
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/github-issue", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    if (existing.githubIssueUrl) return existing;
    const updated = await store.updateReport(id, { githubIssueRequestedAt: new Date().toISOString() });
    triggerWorker(config, request.log);
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/engineering-handoff", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    if (existing.agentStatus === "sent") return existing;

    const updated = await store.updateReport(id, {
      humanReview: {
        status: "approved",
        agentHandoffApproved: true,
        reviewedBy: await operatorName(request),
        reviewedAt: new Date().toISOString(),
        notes: existing.humanReview?.notes,
      },
      agentStatus: "queued",
      githubIssueRequestedAt: existing.githubIssueRequestedAt ?? new Date().toISOString(),
    });
    triggerWorker(config, request.log);
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/reports/:id/reporter", { preHandler: authenticateAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await store.getReport(id);
    if (!existing) return reply.code(404).send({ error: "Report not found" });
    const { email } = UserContextSchema.pick({ email: true }).parse(request.body);
    if (!email) return reply.code(400).send({ error: "A reporter email address is required" });

    const note = ReportNoteSchema.parse({
      id: randomUUID(),
      author: await operatorName(request),
      body: existing.user?.email ? "Reporter email updated for reply delivery." : "Reporter email added for reply delivery.",
      channel: "note",
      createdAt: new Date().toISOString(),
    });
    const updated = await store.updateReport(id, {
      user: { ...existing.user, email },
      notes: [...(existing.notes ?? []), note],
    });
    return updated ?? reply.code(404).send({ error: "Report not found" });
  });

  app.post("/v1/webhooks/github", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}));
    // Prefer the dashboard-connected app's webhook secret; env is the fallback.
    const webhookSecret = (await store.getGitHubApp())?.webhookSecret ?? config.webhookSecret;
    const isValid = verifyGitHubSignature(rawBody, request.headers["x-hub-signature-256"] as string | undefined, webhookSecret);
    if (!isValid) return reply.code(401).send({ error: "Invalid GitHub signature" });
    return { ok: true };
  });

  return app;
}

export type { LocalObjectStorage };

/** Public conversation projection: never includes internal notes or operator identity. */
function reporterMessages(report: ReportRecord): Array<{ id: string; body: string; createdAt: string }> {
  return (report.notes ?? [])
    .filter((note) => note.channel === "reply" || note.channel === "email")
    .slice(-20)
    .map(({ id, body, createdAt }) => ({ id, body, createdAt }));
}

function assignIfDefined<K extends keyof ReportRecord>(target: Partial<ReportRecord>, key: K, value: ReportRecord[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureTokenMatches(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}

/** Accepts both the %2F-encoded form (direct hits) and the already-decoded
 * form (after Vercel's rewrite layer decodes the path). */
function decodeObjectKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function publicUser(user: StoredUser): { id: string; email: string; name: string; createdAt: string } {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function generateProjectKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(3).toString("hex");
  return `proj_${slug ? `${slug}_` : ""}${suffix}`;
}

async function seedProjectsFromEnv(store: ReportStore, projectKeys: string[]): Promise<void> {
  for (const projectKey of projectKeys) {
    if (await store.getProject(projectKey)) continue;
    await store.createProject({
      projectKey,
      name: defaultProjectName(projectKey),
      origins: [],
      createdAt: new Date().toISOString(),
    });
  }
}

function defaultProjectName(projectKey: string): string {
  const pretty = projectKey
    .replace(/^proj_/, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return pretty || projectKey;
}

function parseRangeHeader(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0) return undefined;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  // Suffix range: "bytes=-N" means the final N bytes.
  const start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd));
  const end = rawStart && rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function isExpired(session: StoredSession): boolean {
  return new Date(session.expiresAt).getTime() < Date.now();
}

function getErrorStatusCode(error: unknown): number {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return 500;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : 500;
}

function triggerWorker(config: ApiConfig, log: { error(value: unknown): void }): void {
  if (!config.admin.internalToken) return;
  const workerUrl = config.workerUrl
    ? new URL("/internal/worker", config.workerUrl)
    : new URL("/v1/internal/worker", config.publicUrl);
  const request = fetch(workerUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.admin.internalToken}`,
      "content-type": "application/json",
    },
    // Fastify rejects an empty request body when application/json is set.
    // The Vercel self-trigger does not need parameters, but it still needs a
    // syntactically valid JSON body to reach the worker route.
    body: JSON.stringify({}),
  }).then((response) => {
    if (!response.ok) throw new Error(`Worker trigger failed: ${response.status} ${response.statusText}`);
  }).catch((error) => log.error(error));

  if (process.env.VERCEL) waitUntil(request);
  else void request;
}

async function initializeStore(
  store: ReportStore,
  retryDelaysMs: readonly number[],
  log: { warn(value: unknown, message?: string): void },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await store.init();
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isTransientStoreError(error)) throw error;
      log.warn(
        { error, attempt: attempt + 1, retryDelayMs },
        "Transient report-store initialization failure; retrying",
      );
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
}

function isTransientStoreError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  return "cause" in error && isTransientStoreError((error as { cause?: unknown }).cause);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
