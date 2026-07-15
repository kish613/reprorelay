import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("refuses ephemeral report storage in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL is required in production",
    );
  });

  it("allows the in-memory store for local development", () => {
    expect(loadConfig({ NODE_ENV: "development" }).databaseUrl).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "development" }).retention.videoDays).toBe(7);
  });

  it("configures authenticated video retention cleanup", () => {
    expect(loadConfig({
      NODE_ENV: "development",
      CRON_SECRET: "cron-secret",
      REPRORELAY_VIDEO_RETENTION_DAYS: "14",
    }).retention).toEqual({ cronSecret: "cron-secret", videoDays: 14 });
  });

  it("parses project-scoped status API keys", () => {
    expect(loadConfig({
      NODE_ENV: "development",
      REPRORELAY_STATUS_API_KEYS: JSON.stringify({ proj_prime: "s".repeat(32) }),
    }).statusApiKeys).toEqual({ proj_prime: "s".repeat(32) });
  });

  it("rejects malformed or weak status API keys", () => {
    expect(() => loadConfig({ NODE_ENV: "development", REPRORELAY_STATUS_API_KEYS: "not-json" })).toThrow(
      "must be a JSON object",
    );
    expect(() => loadConfig({
      NODE_ENV: "development",
      REPRORELAY_STATUS_API_KEYS: JSON.stringify({ proj_prime: "too-short" }),
    })).toThrow("at least 32 characters");
  });

  it("keeps the tracked environment example parseable as a development configuration", () => {
    const contents = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const env = Object.fromEntries(contents.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const separator = trimmed.indexOf("=");
      if (separator < 1) throw new Error(`Invalid .env.example line: ${line}`);
      const value = trimmed.slice(separator + 1).replace(/\s+#.*$/, "");
      return [[trimmed.slice(0, separator), value]];
    }));

    const config = loadConfig(env);
    expect(config.publicUrl).toBe("http://localhost:4000");
    expect(config.projectKeys).toEqual(["proj_demo-react", "proj_client_app"]);
    expect(config.storage.driver).toBe("auto");
    expect(config.storage.blobAccess).toBe("private");
  });
});
