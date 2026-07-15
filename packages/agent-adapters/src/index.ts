import type { ReportRecord } from "@reprorelay/shared";

export type AgentAdapterKind = "claude" | "codex" | "copilot" | "custom";
export type HandoffMode = "manual" | "triage" | "auto";

export interface AgentRule {
  kind: AgentAdapterKind;
  mode?: HandoffMode;
  trigger?: string;
  minSeverity?: ReportRecord["severity"];
  environments?: string[];
}

export interface AgentHandoffAction {
  kind: AgentAdapterKind;
  shouldSend: boolean;
  comment?: string;
  labels?: string[];
  reason: string;
}

const severityRank: Record<ReportRecord["severity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function buildAgentHandoff(report: ReportRecord, rule: AgentRule): AgentHandoffAction {
  const mode = rule.mode ?? "triage";
  if (mode === "manual") {
    return { kind: rule.kind, shouldSend: false, reason: "Manual mode requires human approval." };
  }

  const minSeverity = rule.minSeverity ?? "high";
  if (severityRank[report.severity]! < severityRank[minSeverity]!) {
    return { kind: rule.kind, shouldSend: false, reason: `Severity ${report.severity} is below ${minSeverity}.` };
  }

  if (rule.environments?.length && !rule.environments.includes(report.environment)) {
    return { kind: rule.kind, shouldSend: false, reason: `Environment ${report.environment} is not enabled.` };
  }

  if (rule.kind === "copilot") {
    return {
      kind: "copilot",
      shouldSend: true,
      labels: [rule.trigger ?? "copilot"],
      reason: "Copilot handoff uses labels so a configured workflow or cloud agent can pick up the issue.",
    };
  }

  return {
    kind: rule.kind,
    shouldSend: true,
    comment: buildAgentComment(report, rule),
    reason: `${rule.kind} trigger comment is ready.`,
  };
}

export function buildAgentComment(report: ReportRecord, rule: AgentRule): string {
  const trigger = rule.trigger ?? defaultTrigger(rule.kind);
  const reviewedBy = report.humanReview?.reviewedBy ? `Reviewed by: ${report.humanReview.reviewedBy}` : undefined;
  const reviewedAt = report.humanReview?.reviewedAt ? `Reviewed at: ${report.humanReview.reviewedAt}` : undefined;
  return [
    `${trigger}`,
    "",
    "Please investigate this human-reviewed ReproRelay report.",
    "",
    `- Report: ${report.title}`,
    `- Severity: ${report.severity}`,
    `- Environment: ${report.environment}`,
    `- URL: ${report.browser.url}`,
    report.githubIssueUrl ? `- GitHub Issue: ${report.githubIssueUrl}` : undefined,
    reviewedBy ? `- ${reviewedBy}` : undefined,
    reviewedAt ? `- ${reviewedAt}` : undefined,
    "",
    report.aiTriage?.agentPrompt ??
      "Use the reproduction timeline, console summary, network summary, and linked replay assets above. Produce the smallest safe fix and mention any data you could not access.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function defaultTrigger(kind: AgentAdapterKind): string {
  switch (kind) {
    case "claude":
      return "@claude";
    case "codex":
      return "@codex";
    case "copilot":
      return "copilot";
    case "custom":
      return "@agent";
  }
}
