import type { ReportRecord } from "@reprorelay/shared";
import { demoReports } from "@reprorelay/shared/fixtures";
import { DryRunGitHubClient } from "@reprorelay/github";
import { describe, expect, it } from "vitest";
import type { ReproRelayApiClient } from "../src/api-client.js";
import { processReports, shouldProcess } from "../src/processor.js";

describe("worker report eligibility", () => {
  it("keeps a human-approved queued handoff eligible even with an agent_handoff display status", () => {
    const report: ReportRecord = {
      ...demoReports[0]!,
      status: "agent_handoff",
      agentStatus: "queued",
      githubIssueUrl: "https://github.com/example/repo/issues/12",
      githubIssueNumber: 12,
      humanReview: { status: "approved", agentHandoffApproved: true },
    };

    expect(shouldProcess(report)).toBe(true);
  });

  it("dispatches an approved queued agent handoff and only then marks it sent", async () => {
    let current: ReportRecord = {
      ...demoReports[0]!,
      status: "github_created",
      agentStatus: "queued",
      githubIssueUrl: "https://github.com/example/repo/issues/12",
      githubIssueNumber: 12,
      humanReview: { status: "approved", agentHandoffApproved: true, reviewedBy: "Operator" },
    };
    const api = {
      listReports: async () => [current],
      updateReport: async (_id: string, patch: Partial<ReportRecord>) => {
        current = { ...current, ...patch };
        return current;
      },
    } as ReproRelayApiClient;
    const github = new DryRunGitHubClient();

    await processReports(api, async () => github, {
      agentRules: [{ kind: "codex", mode: "triage", trigger: "@codex", minSeverity: "high" }],
    });

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("@codex");
    expect(current.agentStatus).toBe("sent");
    expect(current.status).toBe("agent_handoff");
  });

  it("neutralizes configured triggers in the initial issue before approval", async () => {
    let current: ReportRecord = {
      ...demoReports[0]!,
      title: "@codex inspect this report",
      comment: "@claude run before approval",
      aiTriage: undefined,
      githubIssueUrl: undefined,
      githubIssueNumber: undefined,
      humanReview: { status: "pending", agentHandoffApproved: false },
      agentStatus: "pending",
      status: "new",
    };
    const api = {
      listReports: async () => [current],
      updateReport: async (_id: string, patch: Partial<ReportRecord>) => {
        current = { ...current, ...patch };
        return current;
      },
    } as ReproRelayApiClient;
    const github = new DryRunGitHubClient();

    await processReports(api, async () => github, {
      agentRules: [
        { kind: "codex", mode: "triage", trigger: "@codex", minSeverity: "high" },
        { kind: "claude", mode: "triage", trigger: "@claude", minSeverity: "high" },
      ],
    });

    expect(github.createdIssues).toHaveLength(1);
    expect(github.createdIssues[0]?.title).not.toContain("@codex");
    expect(github.createdIssues[0]?.body).not.toContain("@claude");
    expect(github.comments).toHaveLength(0);
    expect(current.agentStatus).toBe("needs_review");
  });
});
