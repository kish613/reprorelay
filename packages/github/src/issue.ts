import { buildIssueBody, buildIssueTitle, type ReportRecord } from "@reprorelay/shared";
import type { GitHubClient } from "./client.js";

export interface GitHubIssueResult {
  issueNumber: number;
  issueUrl: string;
}

export async function createGitHubIssueForReport(
  client: GitHubClient,
  report: ReportRecord,
  options: { dashboardBaseUrl?: string; agentTriggers?: string[] } = {},
): Promise<GitHubIssueResult> {
  const dashboardUrl = options.dashboardBaseUrl ? `${options.dashboardBaseUrl.replace(/\/$/, "")}/reports/${report.id}` : undefined;
  const screenshotUrl = report.assets.find((asset) => asset.kind === "screenshot")?.url;
  const videoUrl = report.assets.find((asset) => asset.kind === "video")?.url;
  const replayUrl = report.assets.find((asset) => asset.kind === "replay")?.url ?? dashboardUrl;
  const issue = await client.createIssue({
    title: neutralizeAgentTriggers(buildIssueTitle(report), options.agentTriggers),
    body: neutralizeAgentTriggers(
      buildIssueBody(report, { dashboardUrl, screenshotUrl, videoUrl, replayUrl }),
      options.agentTriggers,
    ),
    labels: ["reprorelay", `severity:${report.severity}`, `env:${report.environment}`],
  });
  return { issueNumber: issue.number, issueUrl: issue.htmlUrl };
}

/**
 * Breaks trigger phrases and GitHub mentions in reporter-controlled issue
 * content. The zero-width separator preserves readable text while ensuring an
 * issue-open event cannot activate a coding agent before human approval.
 */
export function neutralizeAgentTriggers(value: string, triggers: string[] = []): string {
  let safe = value;
  for (const trigger of [...new Set(triggers.map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(escapeRegExp(trigger), "giu");
    safe = safe.replace(pattern, (match) => breakPhrase(match));
  }
  return safe.replace(/@(?!\u200B)/gu, "@\u200B");
}

function breakPhrase(value: string): string {
  const characters = Array.from(value);
  if (characters.length < 2) return `[blocked trigger: ${value}]`;
  return `${characters[0]}\u200B${characters.slice(1).join("")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
