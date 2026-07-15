import type { ReportRecord } from "@reprorelay/shared";
import { demoReports } from "@reprorelay/shared/fixtures";
import {
  formatDateTime,
  projectName,
  type ActivityPresentation,
  type AttachmentPresentation,
  type DashboardDataSource,
  type NotePresentation,
  type PersonPresentation,
  type ReportPresentation,
  type SavedViewPresentation,
} from "../lib/data-source.js";
import mayaAvatar from "./assets/avatars/maya-patel.jpg";
import sarahAvatar from "./assets/avatars/sarah-chen.jpg";
import evidenceScreenshot from "./assets/evidence/template-preview-blank.png";

async function fetchReports(): Promise<ReportRecord[]> {
  return demoReports;
}

async function updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord> {
  const report = demoReports.find((item) => item.id === id);
  if (!report) throw new Error("Showcase report not found.");
  return { ...report, ...patch };
}

function findReport(id: string): ReportRecord {
  const report = demoReports.find((item) => item.id === id);
  if (!report) throw new Error("Showcase report not found.");
  return report;
}

async function addNote(id: string, body: string): Promise<ReportRecord> {
  const report = findReport(id);
  return {
    ...report,
    notes: [
      ...(report.notes ?? []),
      { id: crypto.randomUUID(), author: "Operator", body, channel: "note", createdAt: new Date().toISOString() },
    ],
  };
}

async function sendReply(id: string, body: string): Promise<ReportRecord> {
  const report = findReport(id);
  return {
    ...report,
    notes: [
      ...(report.notes ?? []),
      { id: crypto.randomUUID(), author: "Operator", body, channel: "email", createdAt: new Date().toISOString() },
    ],
  };
}

async function requestGitHubIssue(id: string): Promise<ReportRecord> {
  const report = findReport(id);
  return { ...report, githubIssueRequestedAt: new Date().toISOString() };
}

async function requestEngineeringHandoff(id: string): Promise<ReportRecord> {
  const report = findReport(id);
  return {
    ...report,
    agentStatus: "queued",
    githubIssueRequestedAt: report.githubIssueRequestedAt ?? new Date().toISOString(),
    humanReview: { status: "approved", agentHandoffApproved: true, reviewedBy: "Operator", reviewedAt: new Date().toISOString() },
  };
}

async function updateReporterEmail(id: string, email: string): Promise<ReportRecord> {
  const report = findReport(id);
  return { ...report, user: { ...report.user, email } };
}

async function archiveReport(id: string): Promise<ReportRecord> {
  const report = findReport(id);
  return { ...report, archivedAt: new Date().toISOString(), archivedBy: "Operator" };
}

async function restoreReport(id: string): Promise<ReportRecord> {
  const report = findReport(id);
  return { ...report, archivedAt: undefined, archivedBy: undefined };
}

const showcaseNumbers = new Map<string, string>([
  [demoReports[0]?.id ?? "", "#RPR-10247"],
  [demoReports[1]?.id ?? "", "#RPR-10246"],
]);

export function presentShowcaseReport(report: ReportRecord): ReportPresentation {
  const maya = { name: "Maya Patel", email: "maya.patel@example.com", team: "Support Team", avatarUrl: mayaAvatar };
  const isPrimaryReport = report.id === demoReports[0]?.id;
  const reporter: PersonPresentation = isPrimaryReport
    ? {
        name: report.user?.name ?? "Sarah Chen",
        email: report.user?.email,
        avatarUrl: sarahAvatar,
        customerSince: "Sep 4, 2023",
        company: "Acme Corp",
        plan: "Growth",
        ticketSummary: "8 (5 closed)",
      }
    : {
        name: report.user?.name ?? report.user?.email ?? report.user?.id ?? "Anonymous reporter",
        email: report.user?.email,
      };
  const createdLabel = formatDateTime(report.createdAt);
  const failedRequest = report.network.find((event) => (event.status ?? 0) >= 400);
  const consoleError = report.console.find((event) => event.level === "error");
  const errorSignal = failedRequest
    ? `${failedRequest.method} ${failedRequest.url} ${failedRequest.status ?? ""}`.trim()
    : consoleError
      ? `${consoleError.level.toUpperCase()} ${consoleError.message}`
      : undefined;
  const attachments: AttachmentPresentation[] = [];
  if (consoleError) attachments.push({ id: "console", title: "console-error.log", time: createdLabel, kind: "text" });
  if (failedRequest) attachments.push({ id: "network", title: "failed-request.har", time: createdLabel, kind: "data" });
  const internalNotes: NotePresentation[] = (report.notes ?? []).map((note) => ({
    author: { name: note.author },
    createdLabel: formatDateTime(note.createdAt),
    body: note.body,
    channel: note.channel,
    providerId: note.providerId,
  }));
  if (isPrimaryReport) internalNotes.unshift({
    author: maya,
    createdLabel: "Jul 9, 2026 · 11:03 AM",
    body: "Reproduced on our staging instance using the same steps. Browser console shows a 500 error from /api/templates/tpl_123. Investigating.",
  });
  const activity: ActivityPresentation[] = [{
    label: `Evidence captured by ${reporter.name}`,
    detail: report.assets.length || report.console.length || report.network.length
      ? "Browser and reproduction evidence captured."
      : "Report submitted without additional evidence.",
    time: createdLabel,
    kind: "report",
  }];
  if (report.aiTriage) activity.push({
    label: "AI summary generated",
    detail: `${Math.round(report.aiTriage.confidence * 100)}% confidence · ${report.aiTriage.likelyArea}`,
    time: formatDateTime(report.aiTriage.generatedAt),
    kind: "ai",
  });
  if (isPrimaryReport) activity.push({
    label: "Assigned to Maya Patel",
    detail: "Support team accepted ownership.",
    time: "Jul 9, 2026 · 10:58 AM",
    kind: "assignment",
  });

  return {
    mode: "showcase",
    workspaceName: projectName(report.projectKey),
    areaName: report.browser.title,
    reportNumber: showcaseNumbers.get(report.id) ?? `#${report.id.slice(0, 8).toUpperCase()}`,
    createdLabel,
    reporter,
    currentUser: maya,
    notificationCount: 4,
    deploymentVersion: "v1.9.0",
    assignee: isPrimaryReport ? maya : undefined,
    team: "Support",
    tags: report.aiTriage?.suggestedLabels ?? [],
    slaDue: isPrimaryReport ? "Jul 11, 2026 10:10 AM · in 1d 23h" : undefined,
    releaseLabel: report.release,
    environmentLabel: `${report.environment.charAt(0).toUpperCase()}${report.environment.slice(1)}`,
    browserLabel: browserName(report.browser.userAgent),
    platformLabel: platformName(report.browser.userAgent, report.browser.viewport.width, report.browser.viewport.height),
    aiSummary: report.aiTriage?.reproductionSteps ?? [],
    agentPrompt: report.aiTriage?.agentPrompt,
    internalNotes,
    defaultReply: `Hi ${reporter.name.split(" ")[0] ?? reporter.name}, thanks for the detailed report. We’ll keep you updated here.`,
    evidence: {
      capturedLabel: createdLabel,
      screenshotUrl: report.assets.some((asset) => asset.kind === "screenshot") ? evidenceScreenshot : undefined,
      screenshotAlt: `Captured screen for ${report.title}`,
      steps: report.aiTriage?.reproductionSteps ?? report.breadcrumbs.map((item) => item.message),
      errorSignal,
      attachments,
    },
    duplicates: isPrimaryReport ? [
      { id: "#RPR-9871", title: "Template preview blank for Gold customers", confidence: "85%" },
      { id: "#RPR-9432", title: "Preview panel empty after selecting group", confidence: "73%" },
      { id: "#RPR-8720", title: "Cannot send campaign when preview is blank", confidence: "69%" },
    ] : [],
    activity,
  };
}

function browserName(userAgent: string): string {
  const match = userAgent.match(/(Chrome|Firefox|Edg|Version|Safari)\/([\d.]+)/);
  if (!match) return "Browser";
  const name = match[1] === "Version" && userAgent.includes("Safari") ? "Safari" : match[1];
  return `${name} ${match[2]?.split(".")[0] ?? ""}`.trim();
}

function platformName(userAgent: string, width: number, height: number): string {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/iPhone|iPad/i.test(userAgent)) return "iOS";
  if (/Android/i.test(userAgent)) return "Android";
  return `${width}×${height}`;
}

function savedViews(): SavedViewPresentation[] {
  return [
    { label: "Needs review", count: 2 },
    { label: "Assigned to me", count: 5 },
    { label: "High severity", count: 7 },
    { label: "Bug reports", count: 12 },
    { label: "Open", count: 23 },
    { label: "Waiting on customer", count: 4 },
  ];
}

export const dashboardDataSource: DashboardDataSource = {
  mode: "showcase",
  fetchReports,
  updateReport,
  addNote,
  sendReply,
  requestGitHubIssue,
  requestEngineeringHandoff,
  updateReporterEmail,
  archiveReport,
  restoreReport,
  emailStatus: async () => ({ configured: true, from: "ReproRelay <support@example.com>" }),
  present: presentShowcaseReport,
  savedViews,
};
