import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWorkerTrigger } from "../src/worker-trigger.js";

const trustedEnv = {
  REPRORELAY_INTERNAL_TOKEN: "worker-test-token",
  REPRORELAY_API_URL: "https://api.example.com",
};

describe("worker trigger", () => {
  it("uses the configured API authority when the trigger body is empty", async () => {
    const app = Fastify();
    const run = vi.fn(async () => ({ processed: 0 }));
    registerWorkerTrigger(app, trustedEnv, run);

    const response = await app.inject({
      method: "POST",
      url: "/internal/worker",
      headers: { authorization: "Bearer worker-test-token" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      REPRORELAY_API_URL: "https://api.example.com",
    }));
    await app.close();
  });

  it("accepts an older matching URL but still uses the configured authority", async () => {
    const app = Fastify();
    const run = vi.fn(async () => ({ processed: 0 }));
    registerWorkerTrigger(app, trustedEnv, run);

    const response = await app.inject({
      method: "POST",
      url: "/internal/worker",
      headers: { authorization: "Bearer worker-test-token" },
      payload: { apiUrl: "https://api.example.com/" },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      REPRORELAY_API_URL: "https://api.example.com",
    }));
    await app.close();
  });

  it("rejects a caller-selected API authority", async () => {
    const app = Fastify();
    const run = vi.fn(async () => ({ processed: 0 }));
    registerWorkerTrigger(app, trustedEnv, run);

    const response = await app.inject({
      method: "POST",
      url: "/internal/worker",
      headers: { authorization: "Bearer worker-test-token" },
      payload: { apiUrl: "https://127.0.0.1:8443" },
    });

    expect(response.statusCode).toBe(400);
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unauthenticated triggers", async () => {
    const app = Fastify();
    const run = vi.fn(async () => ({ processed: 0 }));
    registerWorkerTrigger(app, trustedEnv, run);

    const response = await app.inject({ method: "POST", url: "/internal/worker", payload: {} });

    expect(response.statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });
});
