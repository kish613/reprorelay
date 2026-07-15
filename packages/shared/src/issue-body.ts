import type { AiTriage, HumanReview, ReportPayload } from "./schemas.js";

type IssueBodyReport = ReportPayload & {
  aiTriage?: AiTriage;
  humanReview?: HumanReview;
};

export interface IssueBodyOptions {
  dashboardUrl?: string;
  replayUrl?: string;
  screenshotUrl?: string;
  videoUrl?: string;
}

export function buildIssueTitle(report: Pick<ReportPayload, "title" | "severity" | "environment">): string {
  return `[${report.severity.toUpperCase()}][${report.environment}] ${report.title}`;
}

export function buildIssueBody(report: IssueBodyReport, options: IssueBodyOptions = {}): string {
  const timeline = report.breadcrumbs
    .slice(-30)
    .map((item, index) => `${index + 1}. \`${item.timestamp}\` **${item.type}** - ${item.message}`)
    .join("\n");

  const consoleSummary = report.console
    .slice(-20)
    .map((item) => `- \`${item.level}\` ${item.message}`)
    .join("\n");

  const networkSummary = report.network
    .slice(-20)
    .map((item) => `- \`${item.method}\` ${item.url}${item.status ? ` -> ${item.status}` : ""}`)
    .join("\n");

  const assets = [
    options.dashboardUrl ? `- Dashboard: ${options.dashboardUrl}` : undefined,
    options.replayUrl ? `- Replay: ${options.replayUrl}` : undefined,
    options.screenshotUrl ? `- Screenshot: ${options.screenshotUrl}` : undefined,
    options.videoUrl ? `- Video: ${options.videoUrl}` : undefined,
  ].filter(Boolean);

  return [
    "## Client Report",
    report.comment,
    "",
    "## Evidence",
    assets.length ? assets.join("\n") : "- No uploaded assets were attached.",
    "",
    "## Environment",
    `- URL: ${report.browser.url}`,
    `- Page title: ${report.browser.title}`,
    `- Release: ${report.release ?? "unknown"}`,
    `- Environment: ${report.environment}`,
    `- Viewport: ${report.browser.viewport.width}x${report.browser.viewport.height} @ ${report.browser.viewport.devicePixelRatio}x`,
    `- Browser: ${report.browser.userAgent}`,
    report.user?.email ? `- User: ${report.user.email}` : undefined,
    "",
    "## Reproduction Timeline",
    timeline || "_No timeline events captured._",
    "",
    "## Console Summary",
    consoleSummary || "_No console events captured._",
    "",
    "## Network Summary",
    networkSummary || "_No network events captured._",
    "",
    report.aiTriage
      ? [
          "## AI Triage Draft",
          `- Summary: ${report.aiTriage.summary}`,
          `- Likely area: ${report.aiTriage.likelyArea}`,
          `- Severity recommendation: ${report.aiTriage.severityRecommendation}`,
          `- Confidence: ${Math.round(report.aiTriage.confidence * 100)}%`,
          `- Human review: ${report.humanReview?.status ?? "pending"}`,
          "",
          "### Suggested Labels",
          report.aiTriage.suggestedLabels.map((label) => `- \`${label}\``).join("\n") || "_No labels suggested._",
          "",
          "### Suggested Tests",
          report.aiTriage.suggestedTests.map((test) => `- ${test}`).join("\n") || "_No tests suggested._",
        ].join("\n")
      : undefined,
    "",
    "## Agent Prompt",
    "Copy this to your AI coding agent:",
    "",
    // Four-backtick fence so the prompt itself may safely contain ``` blocks.
    "````text",
    report.aiTriage?.agentPrompt ??
      [
        "Investigate this client-reported bug using the evidence above.",
        "Prioritize reproducing the issue from the timeline, inspect the affected route, and propose the smallest safe fix.",
        "Do not expose private client data in comments or commits.",
      ].join(" "),
    "````",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
