import { buildAgentHandoff, type AgentRule } from "@reprorelay/agent-adapters";
import { createGitHubIssueForReport, type GitHubClient } from "@reprorelay/github";
import { buildAiTriage, type ReportRecord } from "@reprorelay/shared";
import type { TriageGenerator } from "./ai.js";
import type { ReproRelayApiClient } from "./api-client.js";

export type GitHubClientResolver = (report: ReportRecord) => Promise<GitHubClient | undefined>;

export interface ProcessReportsOptions {
  dashboardUrl?: string;
  agentRules: AgentRule[];
  triage?: TriageGenerator;
}

export async function processReports(api: ReproRelayApiClient, githubForReport: GitHubClientResolver, options: ProcessReportsOptions): Promise<number> {
  const reports = await api.listReports();
  const generateTriage: TriageGenerator = options.triage ?? (async (report) => buildAiTriage(report));
  let processed = 0;

  for (const report of reports) {
    if (!shouldProcess(report)) continue;

    let current = report;
    if (!current.aiTriage) {
      current = await api.updateReport(current.id, {
        aiTriage: await generateTriage(current),
        humanReview: current.humanReview ?? { status: "pending", agentHandoffApproved: false },
        agentStatus: current.agentStatus === "pending" ? "needs_review" : current.agentStatus,
      });
      processed += 1;
    }

    const github = await githubForReport(current);
    if (!github) continue;

    if (!current.githubIssueUrl) {
      const issue = await createGitHubIssueForReport(github, current, {
        dashboardBaseUrl: options.dashboardUrl,
        agentTriggers: options.agentRules
          .map((rule) => rule.trigger)
          .filter((trigger): trigger is string => Boolean(trigger)),
      });
      current = await api.updateReport(current.id, {
        status: "github_created",
        githubIssueUrl: issue.issueUrl,
        githubIssueNumber: issue.issueNumber,
      });
      processed += 1;
    }

    if (current.githubIssueNumber && ["pending", "queued", "needs_review"].includes(current.agentStatus)) {
      if (!current.humanReview?.agentHandoffApproved) {
        if (current.agentStatus !== "needs_review") {
          await api.updateReport(current.id, {
            agentStatus: "needs_review",
            humanReview: current.humanReview ?? { status: "pending", agentHandoffApproved: false },
          });
          processed += 1;
        }
        continue;
      }

      const actions = options.agentRules.map((rule) => buildAgentHandoff(current, rule));
      let sent = false;

      for (const action of actions) {
        if (!action.shouldSend) continue;
        if (action.comment) {
          await github.createComment({ issueNumber: current.githubIssueNumber, body: action.comment });
          sent = true;
        }
        if (action.labels?.length) {
          await github.addLabels({ issueNumber: current.githubIssueNumber, labels: action.labels });
          sent = true;
        }
      }

      await api.updateReport(current.id, {
        agentStatus: sent ? "sent" : "skipped",
        status: sent ? "agent_handoff" : current.status,
      });
      processed += 1;
    }
  }

  return processed;
}

export function shouldProcess(report: ReportRecord): boolean {
  if (!report.aiTriage && report.status !== "closed") return true;
  if (report.githubIssueRequestedAt && !report.githubIssueUrl) return true;
  if (report.agentStatus === "queued") return true;
  return ["new", "triaged"].includes(report.status)
    || (report.status === "github_created" && ["pending", "needs_review"].includes(report.agentStatus));
}
