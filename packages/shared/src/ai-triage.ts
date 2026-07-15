import type { AiTriage, ConsoleEvent, NetworkEvent, ReportPayload } from "./schemas.js";

const failedStatusThreshold = 400;

export function buildAiTriage(report: ReportPayload): AiTriage {
  const failedRequests = report.network.filter((event) => typeof event.status === "number" && event.status >= failedStatusThreshold);
  const consoleErrors = report.console.filter((event) => event.level === "error");
  const likelyArea = inferLikelyArea(report, failedRequests, consoleErrors);
  const severityRecommendation = inferSeverity(report, failedRequests, consoleErrors);
  const reproductionSteps = buildReproductionSteps(report);
  const keySignals = buildKeySignals(report, failedRequests, consoleErrors);
  const suggestedLabels = buildSuggestedLabels(report, likelyArea, severityRecommendation);
  const suggestedTests = buildSuggestedTests(report, likelyArea);
  const agentPrompt = buildReviewedAgentPrompt(report, {
    likelyArea,
    severityRecommendation,
    reproductionSteps,
    keySignals,
    suggestedTests,
  });

  return {
    provider: "reprorelay-local-triage",
    generatedAt: new Date().toISOString(),
    summary: buildSummary(report, failedRequests, consoleErrors),
    likelyArea,
    severityRecommendation,
    confidence: estimateConfidence(report, failedRequests, consoleErrors),
    reproductionSteps,
    keySignals,
    suggestedLabels,
    suggestedTests,
    agentPrompt,
    safetyNotes: [
      "Human review is required before any coding agent handoff.",
      "Do not paste private client data, credentials, cookies, tokens, or payment details into public agent comments.",
    ],
    requiresHumanReview: true,
  };
}

function buildSummary(report: ReportPayload, failedRequests: NetworkEvent[], consoleErrors: ConsoleEvent[]): string {
  const parts = [`Client reported: ${report.title}.`, `Comment: ${report.comment}`];
  if (consoleErrors[0]) parts.push(`Primary console signal: ${consoleErrors[0].message}`);
  if (failedRequests[0]) parts.push(`Primary network signal: ${failedRequests[0].method} ${failedRequests[0].url} returned ${failedRequests[0].status}.`);
  parts.push(`Observed on ${report.environment} at ${report.browser.url}.`);
  return parts.join(" ");
}

function buildReproductionSteps(report: ReportPayload): string[] {
  const timelineSteps = report.breadcrumbs
    .filter((item) => ["route", "click"].includes(item.type))
    .slice(-8)
    .map((item) => (item.type === "route" ? `Navigate to ${item.message}.` : `Interact with ${item.message}.`));

  if (timelineSteps.length) return timelineSteps;
  return [`Open ${report.browser.url}.`, `Attempt the workflow described by the client: ${report.comment}`];
}

function buildKeySignals(report: ReportPayload, failedRequests: NetworkEvent[], consoleErrors: ConsoleEvent[]): string[] {
  return [
    consoleErrors[0] ? `Console error: ${consoleErrors[0].message}` : undefined,
    failedRequests[0] ? `Failed request: ${failedRequests[0].method} ${failedRequests[0].url} -> ${failedRequests[0].status}` : undefined,
    report.assets.some((asset) => asset.kind === "screenshot") ? "Screenshot attached." : "No screenshot attached.",
    report.assets.some((asset) => asset.kind === "replay") ? "Replay blob attached." : "No replay blob attached.",
    `Release: ${report.release ?? "unknown"}.`,
  ].filter((signal): signal is string => Boolean(signal));
}

function inferLikelyArea(report: ReportPayload, failedRequests: NetworkEvent[], consoleErrors: ConsoleEvent[]): AiTriage["likelyArea"] {
  const text = `${report.title} ${report.comment} ${consoleErrors.map((event) => event.message).join(" ")}`.toLowerCase();
  if (text.includes("login") || text.includes("auth") || text.includes("permission") || text.includes("unauthorized")) return "auth";
  if (failedRequests.some((event) => event.status && event.status >= 500)) return "backend";
  if (failedRequests.some((event) => event.status && event.status >= 400)) return "network";
  if (text.includes("undefined") || text.includes("null") || text.includes("crash") || text.includes("blank")) return "frontend";
  if (text.includes("filter") || text.includes("data") || text.includes("missing")) return "data";
  if (text.includes("layout") || text.includes("visual") || text.includes("overlap")) return "design";
  return "unknown";
}

function inferSeverity(report: ReportPayload, failedRequests: NetworkEvent[], consoleErrors: ConsoleEvent[]): AiTriage["severityRecommendation"] {
  if (report.severity === "critical") return "critical";
  if (failedRequests.some((event) => event.status && event.status >= 500) || consoleErrors.length > 0) return report.severity === "low" ? "medium" : "high";
  return report.severity;
}

function estimateConfidence(report: ReportPayload, failedRequests: NetworkEvent[], consoleErrors: ConsoleEvent[]): number {
  let score = 0.35;
  if (report.breadcrumbs.length >= 3) score += 0.2;
  if (consoleErrors.length) score += 0.2;
  if (failedRequests.length) score += 0.15;
  if (report.assets.length) score += 0.1;
  return Math.min(score, 0.95);
}

function buildSuggestedLabels(report: ReportPayload, likelyArea: AiTriage["likelyArea"], severity: AiTriage["severityRecommendation"]): string[] {
  return [`area:${likelyArea}`, `severity:${severity}`, `env:${report.environment}`, "source:reprorelay", "needs:human-review"];
}

function buildSuggestedTests(report: ReportPayload, likelyArea: AiTriage["likelyArea"]): string[] {
  const route = new URL(report.browser.url).pathname;
  const baseline = [`Regression test for the reported workflow on ${route}.`, "UI should show a recoverable error state instead of failing silently."];
  if (likelyArea === "backend" || likelyArea === "network") baseline.push("API should return a typed error response for the failing request.");
  if (likelyArea === "frontend") baseline.push("Component should handle missing/null data without throwing.");
  if (likelyArea === "auth") baseline.push("Permission failure should redirect or show an access message without data leakage.");
  return baseline;
}

function buildReviewedAgentPrompt(
  report: ReportPayload,
  input: Pick<AiTriage, "likelyArea" | "severityRecommendation" | "reproductionSteps" | "keySignals" | "suggestedTests">,
): string {
  const consoleError = report.console.find((event) => event.level === "error");
  const failedRequest = report.network.find((event) => typeof event.status === "number" && event.status >= failedStatusThreshold);

  return [
    "Human-approved agent task:",
    "",
    `Investigate and fix the ReproRelay report "${report.title}".`,
    `Likely area: ${input.likelyArea}. Severity recommendation: ${input.severityRecommendation}.`,
    "",
    "Context:",
    `- Page: ${report.browser.url}${report.browser.title ? ` ("${report.browser.title}")` : ""}`,
    `- Environment: ${report.environment}${report.release ? ` · release ${report.release}` : ""}`,
    `- Reporter says: ${report.comment}`,
    consoleError ? `- Console error: ${consoleError.message}` : undefined,
    failedRequest ? `- Failed request: ${failedRequest.method} ${failedRequest.url} -> ${failedRequest.status}` : undefined,
    "",
    "Reproduction steps:",
    ...input.reproductionSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Key signals:",
    ...input.keySignals.map((signal) => `- ${signal}`),
    "",
    "Acceptance criteria:",
    ...input.suggestedTests.map((test) => `- ${test}`),
    "",
    "Produce the smallest safe fix, include a regression test where practical, and call out any evidence you could not access.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
