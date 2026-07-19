import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendReportHistory, readReportHistory, refreshReportHistory } from "../src/history.js";
import { memoryStorage } from "./memory-storage.js";

const entry = (id: string) => ({
  id,
  title: `Report ${id}`,
  severity: "medium",
  createdAt: new Date().toISOString(),
  hadVideo: id.endsWith("v"),
  hadScreenshot: true,
  status: "new",
});

// Node 24 ships a non-functional bare `localStorage` global that shadows
// jsdom's implementation in vitest — stub a working in-memory Storage.
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("report history store", () => {
  it("round-trips entries per project, newest first", () => {
    appendReportHistory("proj_a", entry("1"));
    appendReportHistory("proj_a", entry("2v"));
    appendReportHistory("proj_b", entry("3"));

    const a = readReportHistory("proj_a");
    expect(a.map((item) => item.id)).toEqual(["2v", "1"]);
    expect(a[0]?.hadVideo).toBe(true);
    expect(readReportHistory("proj_b")).toHaveLength(1);
  });

  it("caps the list at 20 entries", () => {
    for (let index = 0; index < 25; index += 1) appendReportHistory("proj_a", entry(String(index)));
    const entries = readReportHistory("proj_a");
    expect(entries).toHaveLength(20);
    expect(entries[0]?.id).toBe("24");
  });

  it("tolerates corrupt storage", () => {
    window.localStorage.setItem("reprorelay.history.proj_a.v1", "{not json");
    expect(readReportHistory("proj_a")).toEqual([]);
    appendReportHistory("proj_a", entry("1"));
    expect(readReportHistory("proj_a")).toHaveLength(1);
  });

  it("refreshes live progress with the private receipt and persists the sanitized result", async () => {
    const id = "018ff3ef-f9dd-7c29-a648-d8dd59a9b001";
    appendReportHistory("proj_a", {
      ...entry(id),
      trackingToken: "a".repeat(64),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      reports: [{
        id,
        status: "agent_handoff",
        createdAt: "2026-07-12T09:00:00.000Z",
        updatedAt: "2026-07-13T10:30:00.000Z",
        seenAt: "2026-07-12T10:00:00.000Z",
        hadVideo: true,
        hadScreenshot: true,
        messages: [{
          id: "018ff3ef-f9dd-7c29-a648-d8dd59a9b099",
          body: "Thanks — we found the issue and are working on it.",
          createdAt: "2026-07-13T10:25:00.000Z",
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshReportHistory("proj_a", "https://api.example.com/");

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/report-statuses", expect.objectContaining({ method: "POST" }));
    expect(refreshed[0]).toMatchObject({
      id,
      status: "agent_handoff",
      seenAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-13T10:30:00.000Z",
      hadVideo: true,
      messages: [expect.objectContaining({ body: "Thanks — we found the issue and are working on it." })],
    });
    expect(readReportHistory("proj_a")[0]?.status).toBe("agent_handoff");
  });

  it("hydrates an empty browser from an authenticated project status feed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      reports: [
        {
          id: "018ff3ef-f9dd-7c29-a648-d8dd59a9b010",
          title: "Checkout freezes",
          severity: "high",
          status: "agent_handoff",
          createdAt: "2026-07-13T09:00:00.000Z",
          updatedAt: "2026-07-13T10:30:00.000Z",
          seenAt: "2026-07-13T09:30:00.000Z",
          hadVideo: true,
          hadScreenshot: true,
        },
        {
          id: "018ff3ef-f9dd-7c29-a648-d8dd59a9b011",
          title: "Button alignment",
          severity: "low",
          status: "closed",
          createdAt: "2026-07-11T09:00:00.000Z",
          updatedAt: "2026-07-12T10:30:00.000Z",
          seenAt: "2026-07-11T09:30:00.000Z",
          hadVideo: false,
          hadScreenshot: true,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshReportHistory(
      "proj_a",
      "https://api.example.com",
      "/api/reprorelay/status",
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/reprorelay/status", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(refreshed.map((report) => report.title)).toEqual(["Checkout freezes", "Button alignment"]);
    expect(readReportHistory("proj_a")).toEqual(refreshed);
  });

  it("preserves a local receipt while the project feed becomes authoritative", async () => {
    const id = "018ff3ef-f9dd-7c29-a648-d8dd59a9b012";
    appendReportHistory("proj_a", { ...entry(id), trackingToken: "r".repeat(64) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      reports: [{
        id,
        title: "Renamed report",
        severity: "critical",
        status: "triaged",
        createdAt: "2026-07-13T09:00:00.000Z",
        updatedAt: "2026-07-13T10:00:00.000Z",
        seenAt: "2026-07-13T09:30:00.000Z",
        hadVideo: false,
        hadScreenshot: true,
      }],
    }), { status: 200 })));

    const [refreshed] = await refreshReportHistory("proj_a", "https://api.example.com", "/status-feed");
    expect(refreshed).toMatchObject({
      id,
      title: "Renamed report",
      severity: "critical",
      status: "triaged",
      trackingToken: "r".repeat(64),
    });
  });
});
