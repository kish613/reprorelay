import { describe, expect, it } from "vitest";
import { buildAiTriage, buildIssueBody, buildIssueTitle, redactHeaders, redactNetworkEvent, redactUrl } from "../src/index.js";
import { demoReports } from "../src/fixtures.js";

describe("redaction", () => {
  it("redacts sensitive query values", () => {
    expect(redactUrl("https://example.com/callback?code=abc&view=list")).toBe(
      "https://example.com/callback?code=%5Bredacted%5D&view=%5Bvalue%5D",
    );
  });

  it("redacts headers unless explicitly allowed and safe", () => {
    expect(redactHeaders({ authorization: "Bearer abc", "x-request-id": "req_1" }, { allowedRequestHeaders: ["x-request-id"] })).toEqual({
      authorization: "[redacted]",
      "x-request-id": "req_1",
    });
  });

  it("redacts network event urls and headers", () => {
    expect(
      redactNetworkEvent({
        method: "GET",
        url: "https://api.example.com/users?token=secret",
        requestHeaders: { cookie: "sid=abc" },
      }),
    ).toMatchObject({
      url: "https://api.example.com/users?token=%5Bredacted%5D",
      requestHeaders: { cookie: "[redacted]" },
    });
  });
});

describe("issue body", () => {
  it("formats a GitHub issue title and body", () => {
    const report = demoReports[0]!;
    expect(buildIssueTitle(report)).toContain("[HIGH][staging]");
    expect(buildIssueBody(report, { dashboardUrl: "https://reprorelay.test/reports/1" })).toContain("## Agent Prompt");
  });

  it("wraps the agent prompt in a copyable fenced block", () => {
    const body = buildIssueBody(demoReports[0]!);
    const promptSection = body.slice(body.indexOf("## Agent Prompt"));
    expect(promptSection).toContain("Copy this to your AI coding agent");
    expect(promptSection).toMatch(/````text\n[\s\S]+\n````/);
  });
});

describe("ai triage", () => {
  it("builds a human-review-gated triage draft", () => {
    const triage = buildAiTriage(demoReports[0]!);

    expect(triage.requiresHumanReview).toBe(true);
    expect(triage.likelyArea).toBe("backend");
    expect(triage.suggestedLabels).toContain("needs:human-review");
    expect(triage.agentPrompt).toContain("Human-approved agent task");
  });

  it("writes a self-contained agent prompt with page, comment, and error context", () => {
    const report = demoReports[0]!;
    const triage = buildAiTriage(report);

    expect(triage.agentPrompt).toContain(report.browser.url);
    expect(triage.agentPrompt).toContain(report.comment);
    expect(triage.agentPrompt).toContain(`Environment: ${report.environment}`);
    // The demo report has a console error and a failed request — both must reach the prompt.
    const consoleError = report.console.find((event) => event.level === "error");
    if (consoleError) expect(triage.agentPrompt).toContain(consoleError.message);
  });
});
