import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { LocalObjectStorage, type ObjectStorage } from "../src/storage.js";
import { MemoryReportStore } from "../src/store.js";

describe("api", () => {
  it("creates a session and accepts a report", async () => {
    const app = await buildApp({
      config: loadConfig({ PORT: "0", REPRORELAY_API_URL: "http://localhost:4000" }),
      store: new MemoryReportStore(),
    });

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { projectKey: "proj_test" },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json();

    const reportResponse = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { "x-reprorelay-upload-token": session.uploadToken },
      payload: {
        sessionId: session.sessionId,
        projectKey: "proj_test",
        title: "Button does not submit",
        comment: "I clicked save and nothing happened.",
        severity: "high",
        environment: "staging",
        browser: {
          url: "https://example.com",
          title: "Example",
          userAgent: "Vitest",
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        },
        breadcrumbs: [],
        console: [],
        network: [],
        replayEvents: [],
        assets: [],
        createdAt: new Date().toISOString(),
      },
    });

    expect(reportResponse.statusCode).toBe(201);
    expect(reportResponse.json()).toMatchObject({ projectKey: "proj_test", status: "new" });
    await app.close();
  });

  it("self-triggers the Vercel worker with a valid JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });

    try {
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      });

      expect(created.statusCode).toBe(201);
      expect(fetchMock).toHaveBeenCalledWith(new URL("http://localhost:4000/v1/internal/worker"), expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }));
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("uploads and serves evidence assets through the API", async () => {
    const root = await mkdtemp(join(tmpdir(), "reprorelay-api-"));
    const storage = new LocalObjectStorage("http://localhost:4000", root);
    const app = await buildApp({
      config: authenticatedConfig(),
      store: new MemoryReportStore(),
      storage,
    });

    try {
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { projectKey: "proj_test" },
      });
      const session = sessionResponse.json();

      const uploadResponse = await app.inject({
        method: "POST",
        url: "/v1/uploads",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: {
          sessionId: session.sessionId,
          projectKey: "proj_test",
          kind: "screenshot",
          contentType: "image/png",
          contentLength: 4,
        },
      });
      const upload = uploadResponse.json();

      expect(upload.objectKey).toMatch(/^proj_test\//);

      const unauthorizedPutResponse = await app.inject({
        method: "PUT",
        url: new URL(upload.uploadUrl).pathname,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("test"),
      });
      expect(unauthorizedPutResponse.statusCode).toBe(401);

      const putResponse = await app.inject({
        method: "PUT",
        url: new URL(upload.uploadUrl).pathname,
        headers: { ...upload.headers, "content-type": "image/png" },
        payload: Buffer.from("test"),
      });
      expect(putResponse.statusCode).toBe(204);

      const unauthorizedAssetResponse = await app.inject({ method: "GET", url: new URL(upload.publicUrl).pathname });
      expect(unauthorizedAssetResponse.statusCode).toBe(401);

      const cookie = await login(app);
      const assetResponse = await app.inject({
        method: "GET",
        url: new URL(upload.publicUrl).pathname,
        headers: { cookie },
      });

      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers["content-type"]).toContain("image/png");
      expect(assetResponse.body).toBe("test");

      await storage.deleteObject(upload.objectKey);
      const deletedAssetResponse = await app.inject({
        method: "GET",
        url: new URL(upload.publicUrl).pathname,
        headers: { cookie },
      });
      expect(deletedAssetResponse.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves local assets with HTTP range support so video can stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "reprorelay-api-"));
    const app = await buildApp({
      config: authenticatedConfig(),
      store: new MemoryReportStore(),
      storage: new LocalObjectStorage("http://localhost:4000", root),
    });

    try {
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const upload = (await app.inject({
        method: "POST",
        url: "/v1/uploads",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: { sessionId: session.sessionId, projectKey: "proj_test", kind: "video", contentType: "video/webm", contentLength: 8 },
      })).json();
      await app.inject({
        method: "PUT",
        url: new URL(upload.uploadUrl).pathname,
        headers: { ...upload.headers, "content-type": "video/webm" },
        payload: Buffer.from("videodata"),
      });

      const cookie = await login(app);
      const assetPath = new URL(upload.publicUrl).pathname;

      const full = await app.inject({ method: "GET", url: assetPath, headers: { cookie } });
      expect(full.statusCode).toBe(200);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      expect(full.headers["content-length"]).toBe("9");

      const partial = await app.inject({ method: "GET", url: assetPath, headers: { cookie, range: "bytes=0-3" } });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers["content-range"]).toBe("bytes 0-3/9");
      expect(partial.headers["accept-ranges"]).toBe("bytes");
      expect(partial.body).toBe("vide");

      const tail = await app.inject({ method: "GET", url: assetPath, headers: { cookie, range: "bytes=5-" } });
      expect(tail.statusCode).toBe(206);
      expect(tail.headers["content-range"]).toBe("bytes 5-8/9");
      expect(tail.body).toBe("data");

      const suffix = await app.inject({ method: "GET", url: assetPath, headers: { cookie, range: "bytes=-4" } });
      expect(suffix.statusCode).toBe(206);
      expect(suffix.headers["content-range"]).toBe("bytes 5-8/9");
      expect(suffix.body).toBe("data");

      const unsatisfiable = await app.inject({ method: "GET", url: assetPath, headers: { cookie, range: "bytes=99-" } });
      expect(unsatisfiable.statusCode).toBe(416);
      expect(unsatisfiable.headers["content-range"]).toBe("bytes */9");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves assets whose object key arrives with literal slashes (Vercel decodes %2F)", async () => {
    const root = await mkdtemp(join(tmpdir(), "reprorelay-api-"));
    const app = await buildApp({
      config: authenticatedConfig(),
      store: new MemoryReportStore(),
      storage: new LocalObjectStorage("http://localhost:4000", root),
    });

    try {
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const upload = (await app.inject({
        method: "POST",
        url: "/v1/uploads",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: { sessionId: session.sessionId, projectKey: "proj_test", kind: "video", contentType: "video/mp4", contentLength: 4 },
      })).json();

      // The production rewrite decodes %2F, so the API receives real slashes.
      const decodedUploadPath = decodeURIComponent(new URL(upload.uploadUrl).pathname);
      const put = await app.inject({
        method: "PUT",
        url: decodedUploadPath,
        headers: { ...upload.headers, "content-type": "video/mp4" },
        payload: Buffer.from("mp4!"),
      });
      expect(put.statusCode).toBe(204);

      const cookie = await login(app);
      const decodedAssetPath = decodeURIComponent(new URL(upload.publicUrl).pathname);
      expect(decodedAssetPath).toContain("/video.mp4");
      const asset = await app.inject({ method: "GET", url: decodedAssetPath, headers: { cookie } });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("video/mp4");
      expect(asset.body).toBe("mp4!");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to proxying the asset when presigning fails", async () => {
    const storage: ObjectStorage = {
      async createUploadIntent() {
        throw new Error("not needed");
      },
      async readObject() {
        return { body: Buffer.from("proxied-bytes"), contentType: "image/png" };
      },
      async deleteObject() {},
      async createDownloadUrl() {
        throw new Error("presign exploded");
      },
    };
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore(), storage });

    try {
      const cookie = await login(app);
      const response = await app.inject({ method: "GET", url: "/v1/assets/proj_test%2Fabc%2Fscreenshot.png", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
      expect(response.body).toBe("proxied-bytes");
    } finally {
      await app.close();
    }
  });

  it("redirects asset requests to a presigned download URL when storage supports it", async () => {
    const storage: ObjectStorage = {
      async createUploadIntent() {
        throw new Error("not needed");
      },
      async readObject() {
        throw new Error("readObject should not be called when a download URL exists");
      },
      async deleteObject() {},
      async createDownloadUrl(objectKey: string) {
        return `https://blobs.example/${objectKey}?signed=1`;
      },
    };
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore(), storage });

    try {
      const cookie = await login(app);
      const unauthorized = await app.inject({ method: "GET", url: "/v1/assets/proj_test%2Fabc%2Fvideo.webm" });
      expect(unauthorized.statusCode).toBe(401);

      const response = await app.inject({ method: "GET", url: "/v1/assets/proj_test%2Fabc%2Fvideo.webm", headers: { cookie } });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://blobs.example/proj_test/abc/video.webm?signed=1");
      expect(response.headers["cache-control"]).toContain("no-store");
    } finally {
      await app.close();
    }
  });

  it("protects report reads and mutations with an admin session", async () => {
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });

    const unauthorized = await app.inject({ method: "GET", url: "/v1/reports" });
    const badLogin = await app.inject({ method: "POST", url: "/v1/admin/login", payload: { password: "wrong" } });
    const cookie = await login(app);
    const session = await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie } });
    const reports = await app.inject({ method: "GET", url: "/v1/reports", headers: { cookie } });
    const internal = await app.inject({
      method: "GET",
      url: "/v1/reports",
      headers: { authorization: "Bearer test-internal-token" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(badLogin.statusCode).toBe(401);
    expect(session.statusCode).toBe(200);
    expect(reports.statusCode).toBe(200);
    expect(internal.statusCode).toBe(200);
    await app.close();
  });

  it("archives reports out of the default inbox and allows restoring them", async () => {
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });
    try {
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const report = (await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      })).json();
      const cookie = await login(app);

      const archived = await app.inject({ method: "POST", url: `/v1/reports/${report.id}/archive`, headers: { cookie } });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ id: report.id, archivedBy: "Operator", archivedAt: expect.any(String) });

      expect((await app.inject({ method: "GET", url: "/v1/reports", headers: { cookie } })).json()).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/v1/reports?includeArchived=true", headers: { cookie } })).json())
        .toEqual([expect.objectContaining({ id: report.id, archivedAt: expect.any(String) })]);

      const restored = await app.inject({ method: "DELETE", url: `/v1/reports/${report.id}/archive`, headers: { cookie } });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().archivedAt).toBeUndefined();
      expect((await app.inject({ method: "GET", url: "/v1/reports", headers: { cookie } })).json())
        .toEqual([expect.objectContaining({ id: report.id })]);
    } finally {
      await app.close();
    }
  });

  it("deletes video evidence after seven days and keeps the rest of the report", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const storage: ObjectStorage = {
      async createUploadIntent() { throw new Error("not needed"); },
      async readObject() { throw new Error("not needed"); },
      deleteObject,
    };
    const app = await buildApp({
      config: authenticatedConfig({ CRON_SECRET: "test-cron-secret", REPRORELAY_VIDEO_RETENTION_DAYS: "7" }),
      store: new MemoryReportStore(),
      storage,
    });
    try {
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const videoKey = `proj_test/${session.sessionId}/video.mp4`;
      const screenshotKey = `proj_test/${session.sessionId}/screenshot.png`;
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: {
          ...reportPayload(session.sessionId, "proj_test"),
          createdAt: "2026-07-01T00:00:00.000Z",
          assets: [
            { kind: "video", objectKey: videoKey, contentType: "video/mp4", size: 4 },
            { kind: "screenshot", objectKey: screenshotKey, contentType: "image/png", size: 4 },
          ],
        },
      });
      expect(created.statusCode).toBe(201);

      expect((await app.inject({ method: "GET", url: "/v1/internal/retention" })).statusCode).toBe(401);
      const cleanup = await app.inject({
        method: "GET",
        url: "/v1/internal/retention",
        headers: { authorization: "Bearer test-cron-secret" },
      });
      expect(cleanup.statusCode).toBe(200);
      expect(cleanup.json()).toEqual({ reportsUpdated: 1, videosDeleted: 1, failures: 0 });
      expect(deleteObject).toHaveBeenCalledWith(videoKey);

      const cookie = await login(app);
      const report = (await app.inject({ method: "GET", url: `/v1/reports/${created.json().id}`, headers: { cookie } })).json();
      expect(report.assets).toEqual([expect.objectContaining({ kind: "screenshot", objectKey: screenshotKey })]);
      expect(report.videoDeletedAt).toEqual(expect.any(String));

      const repeated = await app.inject({
        method: "GET",
        url: "/v1/internal/retention",
        headers: { authorization: "Bearer test-cron-secret" },
      });
      expect(repeated.json()).toEqual({ reportsUpdated: 0, videosDeleted: 0, failures: 0 });
      expect(deleteObject).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns live sanitized statuses only for receipts owned by the submitting browser", async () => {
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });
    try {
      const session = (await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { projectKey: "proj_test" },
      })).json();
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      });
      const report = created.json();

      const initial = await app.inject({
        method: "POST",
        url: "/v1/report-statuses",
        payload: {
          projectKey: "proj_test",
          receipts: [{ id: report.id, trackingToken: session.uploadToken }],
        },
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().reports).toEqual([expect.objectContaining({
        id: report.id,
        status: "new",
        hadVideo: false,
        hadScreenshot: false,
      })]);
      expect(initial.json().reports[0].title).toBeUndefined();
      expect(initial.json().reports[0].comment).toBeUndefined();
      expect(initial.json().reports[0].assets).toBeUndefined();

      const seenAt = new Date().toISOString();
      const cookie = await login(app);
      await app.inject({
        method: "PATCH",
        url: `/v1/reports/${report.id}`,
        headers: { cookie },
        payload: { seenAt, status: "agent_handoff" },
      });
      const refreshed = await app.inject({
        method: "POST",
        url: "/v1/report-statuses",
        payload: {
          projectKey: "proj_test",
          receipts: [
            { id: report.id, trackingToken: session.uploadToken },
            { id: report.id, trackingToken: "x".repeat(64) },
          ],
        },
      });
      expect(refreshed.json().reports).toEqual([expect.objectContaining({
        id: report.id,
        status: "agent_handoff",
        seenAt,
      })]);
    } finally {
      await app.close();
    }
  });

  it("returns one project-wide status feed only to its server credential", async () => {
    const statusKey = "project-status-key-".padEnd(40, "x");
    const app = await buildApp({
      config: loadConfig({
        PORT: "0",
        REPRORELAY_API_URL: "http://localhost:4000",
        REPRORELAY_STATUS_API_KEYS: JSON.stringify({ proj_prime: statusKey }),
      }),
      store: new MemoryReportStore(),
    });
    try {
      const primeSession = (await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { projectKey: "proj_prime" },
      })).json();
      const primeReport = (await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": primeSession.uploadToken },
        payload: { ...reportPayload(primeSession.sessionId, "proj_prime"), title: "Provider dashboard freezes" },
      })).json();

      const otherSession = (await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { projectKey: "proj_other" },
      })).json();
      await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": otherSession.uploadToken },
        payload: { ...reportPayload(otherSession.sessionId, "proj_other"), title: "Another organisation report" },
      });

      const unauthorized = await app.inject({
        method: "POST",
        url: "/v1/project-report-statuses",
        payload: { projectKey: "proj_prime" },
      });
      const wrongKey = await app.inject({
        method: "POST",
        url: "/v1/project-report-statuses",
        headers: { authorization: `Bearer ${"w".repeat(40)}` },
        payload: { projectKey: "proj_prime" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/project-report-statuses",
        headers: { authorization: `Bearer ${statusKey}` },
        payload: { projectKey: "proj_prime" },
      });

      expect(unauthorized.statusCode).toBe(401);
      expect(wrongKey.statusCode).toBe(401);
      expect(response.statusCode).toBe(200);
      expect(response.json().reports).toEqual([expect.objectContaining({
        id: primeReport.id,
        title: "Provider dashboard freezes",
        severity: "high",
        status: "new",
        hadVideo: false,
        hadScreenshot: false,
      })]);
      expect(response.json().reports[0].comment).toBeUndefined();
      expect(response.json().reports[0].assets).toBeUndefined();
      expect(response.json().reports[0].user).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("appends notes, guards replies, and flags github issue requests", async () => {
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });
    try {
      const cookie = await login(app);
      const sessionResponse = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } });
      const session = sessionResponse.json();
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;

      const note = await app.inject({ method: "POST", url: `/v1/reports/${id}/notes`, headers: { cookie }, payload: { body: "Reproduced on staging." } });
      expect(note.statusCode).toBe(200);
      expect(note.json().notes).toHaveLength(1);
      expect(note.json().notes[0].channel).toBe("note");

      const emptyNote = await app.inject({ method: "POST", url: `/v1/reports/${id}/notes`, headers: { cookie }, payload: { body: "  " } });
      expect(emptyNote.statusCode).toBe(400);

      const reply = await app.inject({ method: "POST", url: `/v1/reports/${id}/reply`, headers: { cookie }, payload: { body: "Thanks for the report." } });
      expect(reply.statusCode).toBe(503);

      const issue = await app.inject({ method: "POST", url: `/v1/reports/${id}/github-issue`, headers: { cookie }, payload: {} });
      expect(issue.statusCode).toBe(200);
      expect(issue.json().githubIssueRequestedAt).toBeTruthy();

      const unauthorized = await app.inject({ method: "POST", url: `/v1/reports/${id}/notes`, payload: { body: "x" } });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("queues engineering handoff without claiming it was sent", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });
    try {
      const cookie = await login(app);
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/reports/${created.json().id}/engineering-handoff`,
        headers: { cookie },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "new",
        agentStatus: "queued",
        humanReview: { status: "approved", agentHandoffApproved: true },
      });
      expect(response.json().githubIssueRequestedAt).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("adds a missing reporter email and records Resend's message id", async () => {
    let sentEmail: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.resend.com/emails") {
        sentEmail = input instanceof Request
          ? await input.clone().json() as Record<string, unknown>
          : JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({
      config: authenticatedConfig({
        RESEND_API_KEY: "re_test",
        REPRORELAY_REPLY_FROM: "ReproRelay <support@example.com>",
      }),
      store: new MemoryReportStore(),
    });
    try {
      const cookie = await login(app);
      const session = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const created = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": session.uploadToken },
        payload: reportPayload(session.sessionId, "proj_test"),
      });
      const id = created.json().id as string;

      const reporter = await app.inject({
        method: "POST",
        url: `/v1/reports/${id}/reporter`,
        headers: { cookie },
        payload: { email: "reporter@example.com" },
      });
      expect(reporter.statusCode).toBe(200);
      expect(reporter.json().user.email).toBe("reporter@example.com");
      expect(reporter.json().notes.at(-1).body).toBe("Reporter email added for reply delivery.");

      const reply = await app.inject({
        method: "POST",
        url: `/v1/reports/${id}/reply`,
        headers: { cookie },
        payload: { body: "Thanks — we are looking into this." },
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().notes.at(-1)).toMatchObject({ channel: "email", providerId: "email_123" });
      expect(sentEmail).toMatchObject({
        to: ["reporter@example.com"],
        subject: `Re: Button does not submit [#${id.slice(0, 8).toUpperCase()}]`,
      });
      expect(sentEmail?.text).toContain("Regarding your report\nButton does not submit");
      expect(sentEmail?.text).toContain(`Reference: #${id.slice(0, 8).toUpperCase()}`);
      expect(sentEmail?.html).toContain("Regarding your report");
      expect(sentEmail?.html).toContain("I clicked save and nothing happened.");

      const emailStatus = await app.inject({ method: "GET", url: "/v1/admin/email", headers: { cookie } });
      expect(emailStatus.json()).toMatchObject({ configured: true, from: "ReproRelay <support@example.com>" });
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("binds report submission and assets to the issued session", async () => {
    const app = await buildApp({
      config: loadConfig({ PORT: "0", REPRORELAY_API_URL: "http://localhost:4000" }),
      store: new MemoryReportStore(),
    });

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { projectKey: "proj_test" },
    });
    const session = sessionResponse.json();
    const payload = reportPayload(session.sessionId, "proj_test");

    const missingToken = await app.inject({ method: "POST", url: "/v1/reports", payload });
    expect(missingToken.statusCode).toBe(401);

    const foreignAsset = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { "x-reprorelay-upload-token": session.uploadToken },
      payload: {
        ...payload,
        assets: [{ kind: "screenshot", objectKey: `proj_other/${session.sessionId}/screenshot.png`, contentType: "image/png", size: 4 }],
      },
    });
    expect(foreignAsset.statusCode).toBe(400);

    const validObjectKey = `proj_test/${session.sessionId}/screenshot.png`;
    const canonicalAsset = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { "x-reprorelay-upload-token": session.uploadToken },
      payload: {
        ...payload,
        assets: [{
          kind: "screenshot",
          objectKey: validObjectKey,
          contentType: "image/png",
          size: 4,
          url: "https://untrusted.example/evidence.png",
        }],
      },
    });
    expect(canonicalAsset.statusCode).toBe(201);
    expect(canonicalAsset.json().assets[0].url).toBe(`http://localhost:4000/v1/assets/${encodeURIComponent(validObjectKey)}`);

    await app.close();
  });

  it("manages projects in the store and accepts sessions for them", async () => {
    const store = new MemoryReportStore();
    const app = await buildApp({ config: authenticatedConfig(), store });

    try {
      const cookie = await login(app);

      const unauthorized = await app.inject({ method: "GET", url: "/v1/projects" });
      expect(unauthorized.statusCode).toBe(401);

      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { cookie },
        payload: { name: "Prime Connect Back Office", origin: "https://prime-connect.chat" },
      });
      expect(created.statusCode).toBe(201);
      const project = created.json();
      expect(project.projectKey).toMatch(/^proj_[a-z0-9_-]+$/);
      expect(project.name).toBe("Prime Connect Back Office");
      expect(project.origins).toEqual(["https://prime-connect.chat"]);

      const listed = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toHaveLength(1);

      // Sessions for a store-managed project are accepted; unknown keys are not
      // once at least one project exists.
      const knownSession = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: project.projectKey } });
      expect(knownSession.statusCode).toBe(200);
      const unknownSession = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_unknown" } });
      expect(unknownSession.statusCode).toBe(404);

      // The project's origin is allowed for CORS without a redeploy.
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/v1/sessions",
        headers: {
          origin: "https://prime-connect.chat",
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("https://prime-connect.chat");

      const invalidOrigin = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { cookie },
        payload: { name: "Bad", origin: "not-a-url" },
      });
      expect(invalidOrigin.statusCode).toBe(400);

      const deleted = await app.inject({ method: "DELETE", url: `/v1/projects/${project.projectKey}`, headers: { cookie } });
      expect(deleted.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } })).json()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("seeds env-configured project keys into the store", async () => {
    const store = new MemoryReportStore();
    const app = await buildApp({
      config: loadConfig({
        PORT: "0",
        REPRORELAY_API_URL: "http://localhost:4000",
        REPRORELAY_PROJECT_KEYS: "proj_prime_connect_back_office",
        REPRORELAY_ADMIN_PASSWORD: "test-password",
        REPRORELAY_ADMIN_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
        REPRORELAY_INTERNAL_TOKEN: "test-internal-token",
      }),
      store,
    });

    try {
      const cookie = await login(app);
      const listed = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } });
      expect(listed.json()).toMatchObject([{ projectKey: "proj_prime_connect_back_office", name: "Prime Connect Back Office" }]);
    } finally {
      await app.close();
    }
  });

  it("manages team members and signs them in with their own credentials", async () => {
    const app = await buildApp({ config: authenticatedConfig(), store: new MemoryReportStore() });

    try {
      const cookie = await login(app);

      const created = await app.inject({
        method: "POST",
        url: "/v1/admin/users",
        headers: { cookie },
        payload: { email: "Ada@example.com", name: "Ada Lovelace", password: "correct-horse-battery" },
      });
      expect(created.statusCode).toBe(201);
      const user = created.json();
      expect(user).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
      expect(user.passwordHash).toBeUndefined();

      const duplicate = await app.inject({
        method: "POST",
        url: "/v1/admin/users",
        headers: { cookie },
        payload: { email: "ada@example.com", name: "Duplicate", password: "another-password" },
      });
      expect(duplicate.statusCode).toBe(409);

      const weakPassword = await app.inject({
        method: "POST",
        url: "/v1/admin/users",
        headers: { cookie },
        payload: { email: "b@example.com", name: "B", password: "short" },
      });
      expect(weakPassword.statusCode).toBe(400);

      const badLogin = await app.inject({ method: "POST", url: "/v1/admin/login", payload: { email: "ada@example.com", password: "wrong" } });
      expect(badLogin.statusCode).toBe(401);

      const userLogin = await app.inject({ method: "POST", url: "/v1/admin/login", payload: { email: "ada@example.com", password: "correct-horse-battery" } });
      expect(userLogin.statusCode).toBe(200);
      const userCookie = (userLogin.headers["set-cookie"] as string).split(";", 1)[0];

      const session = await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie: userCookie } });
      expect(session.statusCode).toBe(200);
      expect(session.json().user).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });

      // Legacy shared-password session has no user identity.
      const legacySession = await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie } });
      expect(legacySession.json().user).toBeUndefined();

      // Notes are attributed to the signed-in user.
      const sdkSession = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } })).json();
      const report = await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: { "x-reprorelay-upload-token": sdkSession.uploadToken },
        payload: reportPayload(sdkSession.sessionId, "proj_test"),
      });
      const reportId = report.json().id as string;
      const note = await app.inject({ method: "POST", url: `/v1/reports/${reportId}/notes`, headers: { cookie: userCookie }, payload: { body: "Mine." } });
      expect(note.json().notes[0].author).toBe("Ada Lovelace");

      // A user cannot delete themselves; deleting a user revokes their session.
      const selfDelete = await app.inject({ method: "DELETE", url: `/v1/admin/users/${user.id}`, headers: { cookie: userCookie } });
      expect(selfDelete.statusCode).toBe(400);
      const removed = await app.inject({ method: "DELETE", url: `/v1/admin/users/${user.id}`, headers: { cookie } });
      expect(removed.statusCode).toBe(200);
      const revoked = await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie: userCookie } });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("connects a GitHub App via the manifest flow and links repos to projects", async () => {
    const store = new MemoryReportStore();
    const exchanged: string[] = [];
    const app = await buildApp({
      config: authenticatedConfig(),
      store,
      githubConnect: {
        async exchangeManifestCode(code: string) {
          exchanged.push(code);
          return {
            appId: 4242,
            slug: "reprorelay-test",
            name: "ReproRelay Test",
            webhookSecret: "hook-secret",
            pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
            htmlUrl: "https://github.com/apps/reprorelay-test",
          };
        },
        async listRepos() {
          return ["example-org/example-app", "example-org/other-app"];
        },
      },
    });

    try {
      const cookie = await login(app);

      const before = await app.inject({ method: "GET", url: "/v1/admin/github", headers: { cookie } });
      expect(before.json()).toMatchObject({ connected: false });

      const connect = await app.inject({ method: "GET", url: "/v1/admin/github/connect", headers: { cookie } });
      expect(connect.statusCode).toBe(200);
      expect(connect.headers["content-type"]).toContain("text/html");
      expect(connect.body).toContain("https://github.com/settings/apps/new");
      expect(connect.body).toContain("/v1/webhooks/github");
      const state = connect.body.match(/state=([^"&]+)/)?.[1];
      expect(state).toBeTruthy();

      const badState = await app.inject({ method: "GET", url: "/v1/admin/github/callback?code=abc&state=tampered" });
      expect(badState.statusCode).toBe(400);

      const callback = await app.inject({ method: "GET", url: `/v1/admin/github/callback?code=abc&state=${state}` });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("https://github.com/apps/reprorelay-test/installations/new");
      expect(exchanged).toEqual(["abc"]);

      const after = await app.inject({ method: "GET", url: "/v1/admin/github", headers: { cookie } });
      expect(after.json()).toMatchObject({ connected: true, slug: "reprorelay-test", name: "ReproRelay Test" });
      expect(JSON.stringify(after.json())).not.toContain("PRIVATE KEY");

      const repos = await app.inject({ method: "GET", url: "/v1/admin/github/repos", headers: { cookie } });
      expect(repos.json()).toEqual(["example-org/example-app", "example-org/other-app"]);

      const project = (await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { cookie },
        payload: { name: "Prime Connect" },
      })).json();
      const linked = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${project.projectKey}`,
        headers: { cookie },
        payload: { githubRepo: "example-org/example-app" },
      });
      expect(linked.statusCode).toBe(200);
      expect(linked.json().githubRepo).toBe("example-org/example-app");

      const badRepo = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${project.projectKey}`,
        headers: { cookie },
        payload: { githubRepo: "not a repo" },
      });
      expect(badRepo.statusCode).toBe(400);

      const publicRepo = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${project.projectKey}`,
        headers: { cookie },
        payload: { githubRepo: "example-org/public-app" },
      });
      expect(publicRepo.statusCode).toBe(400);
      expect(publicRepo.json().error).toContain("private repository");

      const disconnect = await app.inject({ method: "DELETE", url: "/v1/admin/github", headers: { cookie } });
      expect(disconnect.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/admin/github", headers: { cookie } })).json()).toMatchObject({ connected: false });
    } finally {
      await app.close();
    }
  });

  it("rejects unknown projects when an allowlist is configured", async () => {
    const app = await buildApp({
      config: loadConfig({
        PORT: "0",
        REPRORELAY_API_URL: "http://localhost:4000",
        REPRORELAY_PROJECT_KEYS: "proj_allowed",
      }),
      store: new MemoryReportStore(),
    });

    const unknown = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_unknown" } });
    const allowed = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_allowed" } });

    expect(unknown.statusCode).toBe(404);
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("allows configured browser origins and rejects other origins", async () => {
    const app = await buildApp({
      config: loadConfig({
        PORT: "0",
        REPRORELAY_API_URL: "http://localhost:4000",
        CORS_ORIGINS: "https://prime-connect.chat",
      }),
      store: new MemoryReportStore(),
    });

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v1/sessions",
      headers: {
        origin: "https://prime-connect.chat",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-reprorelay-project",
      },
    });
    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/v1/sessions",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://prime-connect.chat");
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("retries transient report-store initialization failures", async () => {
    const store = new MemoryReportStore();
    const resetError = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const init = vi.spyOn(store, "init")
      .mockRejectedValueOnce(resetError)
      .mockRejectedValueOnce(resetError)
      .mockResolvedValueOnce(undefined);

    const app = await buildApp({
      config: loadConfig({ PORT: "0", REPRORELAY_API_URL: "http://localhost:4000" }),
      store,
      storeInitRetryDelaysMs: [0, 0],
    });

    expect(init).toHaveBeenCalledTimes(3);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects evidence content types that do not match their asset kind", async () => {
    const app = await buildApp({
      config: loadConfig({ PORT: "0", REPRORELAY_API_URL: "http://localhost:4000" }),
      store: new MemoryReportStore(),
    });
    const sessionResponse = await app.inject({ method: "POST", url: "/v1/sessions", payload: { projectKey: "proj_test" } });
    const session = sessionResponse.json();

    const response = await app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: { "x-reprorelay-upload-token": session.uploadToken },
      payload: {
        sessionId: session.sessionId,
        projectKey: "proj_test",
        kind: "replay",
        contentType: "video/webm",
        contentLength: 4,
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

function reportPayload(sessionId: string, projectKey: string) {
  return {
    sessionId,
    projectKey,
    title: "Button does not submit",
    comment: "I clicked save and nothing happened.",
    severity: "high",
    environment: "staging",
    browser: {
      url: "https://example.com",
      title: "Example",
      userAgent: "Vitest",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    },
    breadcrumbs: [],
    console: [],
    network: [],
    replayEvents: [],
    assets: [],
    createdAt: new Date().toISOString(),
  };
}

function authenticatedConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    PORT: "0",
    REPRORELAY_API_URL: "http://localhost:4000",
    REPRORELAY_ADMIN_PASSWORD: "test-password",
    REPRORELAY_ADMIN_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
    REPRORELAY_INTERNAL_TOKEN: "test-internal-token",
    ...overrides,
  });
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    payload: { password: "test-password" },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  if (!cookie) throw new Error("Expected an admin session cookie");
  return cookie.split(";", 1)[0] ?? cookie;
}
