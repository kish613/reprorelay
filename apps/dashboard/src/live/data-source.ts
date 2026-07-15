import { ReportRecordSchema, type ReportRecord } from "@reprorelay/shared";
import {
  EmailNotConfiguredError,
  formatDateTime,
  projectName,
  type ActivityPresentation,
  type AttachmentPresentation,
  type DashboardDataSource,
  type EmailStatus,
  type GitHubStatus,
  type LoginInput,
  type NotePresentation,
  type PersonPresentation,
  type ProjectInfo,
  type ReportPresentation,
  type SavedViewPresentation,
  type SessionCheck,
  type SessionUser,
  type TeamUser,
  type VideoPresentation,
} from "../lib/data-source.js";

const apiUrl = (import.meta.env.VITE_REPRORELAY_API_URL || window.location.origin).replace(/\/$/, "");

let signedInUser: SessionUser | undefined;

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { ...init, credentials: "include" });
}

async function checkSession(): Promise<SessionCheck> {
  const response = await apiFetch("/v1/admin/session");
  if (response.status === 401) return { authenticated: false };
  if (!response.ok) throw new Error(`Could not check your session: ${response.status} ${response.statusText}`);
  const body = (await response.json().catch(() => undefined)) as { user?: SessionUser } | undefined;
  signedInUser = body?.user;
  return { authenticated: true, user: signedInUser };
}

async function login(input: LoginInput): Promise<void> {
  const response = await apiFetch("/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? "Sign in failed");
  }
  const body = (await response.json().catch(() => undefined)) as { user?: SessionUser } | undefined;
  signedInUser = body?.user;
}

async function logout(): Promise<void> {
  await apiFetch("/v1/admin/logout", { method: "POST" });
  signedInUser = undefined;
}

async function listProjects(): Promise<ProjectInfo[]> {
  const response = await apiFetch("/v1/projects");
  if (!response.ok) throw new Error(await readError(response, "Could not load projects"));
  return await response.json() as ProjectInfo[];
}

async function createProject(input: { name: string; origin?: string }): Promise<ProjectInfo> {
  const response = await apiFetch("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create the project"));
  return await response.json() as ProjectInfo;
}

async function updateProject(projectKey: string, patch: { githubRepo?: string | null }): Promise<ProjectInfo> {
  const response = await apiFetch(`/v1/projects/${encodeURIComponent(projectKey)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not update the project"));
  return await response.json() as ProjectInfo;
}

async function deleteProject(projectKey: string): Promise<void> {
  const response = await apiFetch(`/v1/projects/${encodeURIComponent(projectKey)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not delete the project"));
}

async function githubStatus(): Promise<GitHubStatus> {
  const response = await apiFetch("/v1/admin/github");
  if (!response.ok) throw new Error(await readError(response, "Could not check the GitHub connection"));
  return await response.json() as GitHubStatus;
}

async function listGitHubRepos(): Promise<string[]> {
  const response = await apiFetch("/v1/admin/github/repos");
  if (!response.ok) throw new Error(await readError(response, "Could not list GitHub repositories"));
  return await response.json() as string[];
}

async function disconnectGitHub(): Promise<void> {
  const response = await apiFetch("/v1/admin/github", { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not disconnect GitHub"));
}

async function emailStatus(): Promise<EmailStatus> {
  const response = await apiFetch("/v1/admin/email");
  if (!response.ok) throw new Error(await readError(response, "Could not check email delivery"));
  return await response.json() as EmailStatus;
}

async function listUsers(): Promise<TeamUser[]> {
  const response = await apiFetch("/v1/admin/users");
  if (!response.ok) throw new Error(await readError(response, "Could not load your team"));
  return await response.json() as TeamUser[];
}

async function createUser(input: { email: string; name: string; password: string }): Promise<TeamUser> {
  const response = await apiFetch("/v1/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not add the teammate"));
  return await response.json() as TeamUser;
}

async function deleteUser(id: string): Promise<void> {
  const response = await apiFetch(`/v1/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not remove the teammate"));
}

async function fetchReports(): Promise<ReportRecord[]> {
  const response = await apiFetch("/v1/reports?includeArchived=true");
  if (!response.ok) throw new Error(`Could not load reports: ${response.status} ${response.statusText}`);
  return ReportRecordSchema.array().parse(await response.json());
}

async function updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord> {
  const response = await apiFetch(`/v1/reports/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Failed to update report: ${response.status} ${await response.text()}`);
  return ReportRecordSchema.parse(await response.json());
}

async function postReportAction(id: string, action: string, body: Record<string, unknown>): Promise<Response> {
  return apiFetch(`/v1/reports/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addNote(id: string, body: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "notes", { body });
  if (!response.ok) throw new Error(await readError(response, "Could not save note"));
  return ReportRecordSchema.parse(await response.json());
}

async function sendReply(id: string, body: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "reply", { body });
  if (response.status === 503) throw new EmailNotConfiguredError();
  if (!response.ok) throw new Error(await readError(response, "Could not send reply"));
  return ReportRecordSchema.parse(await response.json());
}

async function requestGitHubIssue(id: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "github-issue", {});
  if (!response.ok) throw new Error(await readError(response, "Could not create GitHub issue"));
  return ReportRecordSchema.parse(await response.json());
}

async function requestEngineeringHandoff(id: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "engineering-handoff", {});
  if (!response.ok) throw new Error(await readError(response, "Could not queue engineering handoff"));
  return ReportRecordSchema.parse(await response.json());
}

async function updateReporterEmail(id: string, email: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "reporter", { email });
  if (!response.ok) throw new Error(await readError(response, "Could not save reporter email"));
  return ReportRecordSchema.parse(await response.json());
}

async function archiveReport(id: string): Promise<ReportRecord> {
  const response = await postReportAction(id, "archive", {});
  if (!response.ok) throw new Error(await readError(response, "Could not archive report"));
  return ReportRecordSchema.parse(await response.json());
}

async function restoreReport(id: string): Promise<ReportRecord> {
  const response = await apiFetch(`/v1/reports/${id}/archive`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not restore report"));
  return ReportRecordSchema.parse(await response.json());
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  return body?.error ?? `${fallback}: ${response.status}`;
}

function present(report: ReportRecord): ReportPresentation {
  const reporter = reporterPresentation(report);
  const currentUser: PersonPresentation = signedInUser
    ? { name: signedInUser.name, email: signedInUser.email, team: "Self-hosted" }
    : { name: "Workspace operator", team: "Self-hosted" };
  const reviewedBy = report.humanReview?.reviewedBy;
  const assignee = reviewedBy ? { name: displayIdentity(reviewedBy) } : undefined;
  const screenshot = report.assets.find((asset) => asset.kind === "screenshot");
  const videoAsset = report.assets.find((asset) => asset.kind === "video");
  const video: VideoPresentation | undefined = videoAsset?.url
    ? { url: videoAsset.url, contentType: videoAsset.contentType }
    : undefined;
  const steps = report.aiTriage?.reproductionSteps.length
    ? report.aiTriage.reproductionSteps
    : report.breadcrumbs.map((item) => item.message);

  return {
    mode: "live",
    workspaceName: projectName(report.projectKey) || "Project",
    areaName: pageArea(report),
    reportNumber: `#${report.id.slice(0, 8).toUpperCase()}`,
    createdLabel: formatDateTime(report.createdAt),
    reporter,
    currentUser,
    assignee,
    tags: report.aiTriage?.suggestedLabels ?? [],
    releaseLabel: report.release,
    environmentLabel: report.environment,
    browserLabel: browserName(report.browser.userAgent),
    platformLabel: platformName(report.browser.userAgent, report.browser.viewport.width, report.browser.viewport.height),
    aiSummary: report.aiTriage ? [report.aiTriage.summary] : [],
    agentPrompt: report.aiTriage?.agentPrompt,
    internalNotes: notesPresentation(report),
    defaultReply: "",
    evidence: {
      capturedLabel: formatDateTime(report.createdAt),
      screenshotUrl: screenshot?.url,
      screenshotAlt: `Captured screen for ${report.title}`,
      steps,
      errorSignal: errorSignal(report),
      attachments: report.assets.map((asset, index) => attachmentPresentation(asset, index, report.createdAt)),
      video,
    },
    duplicates: [],
    activity: activityPresentation(report, reporter),
  };
}

function notesPresentation(report: ReportRecord): NotePresentation[] {
  const notes: NotePresentation[] = (report.notes ?? []).map((note) => ({
    author: { name: note.author },
    createdLabel: formatDateTime(note.createdAt),
    body: note.body,
    channel: note.channel,
    providerId: note.providerId,
  }));
  if (report.humanReview?.notes) {
    notes.unshift({
      author: { name: report.humanReview.reviewedBy ? displayIdentity(report.humanReview.reviewedBy) : "Reviewer" },
      createdLabel: report.humanReview.reviewedAt ? formatDateTime(report.humanReview.reviewedAt) : "Review note",
      body: report.humanReview.notes,
      channel: "note",
    });
  }
  return notes;
}

function savedViews(reports: ReportRecord[]): SavedViewPresentation[] {
  const active = reports.filter((report) => !report.archivedAt);
  return [
    { label: "Needs review", count: active.filter((report) => report.humanReview?.status === "pending" || report.agentStatus === "needs_review").length },
    { label: "High severity", count: active.filter((report) => report.severity === "high" || report.severity === "critical").length },
    { label: "Open", count: active.filter((report) => report.status !== "closed").length },
  ];
}

function reporterPresentation(report: ReportRecord): PersonPresentation {
  if (report.user?.name) return { name: report.user.name, email: report.user.email };
  if (report.user?.email) return { name: displayIdentity(report.user.email), email: report.user.email };
  if (report.user?.id) return { name: report.user.id };
  return { name: "Anonymous reporter" };
}

function displayIdentity(value: string): string {
  const localPart = value.split("@", 1)[0] ?? value;
  return localPart
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || value;
}

function browserName(userAgent: string): string {
  const match = userAgent.match(/(Chrome|Firefox|Edg|Version)\/([\d.]+)/);
  if (!match) return "Browser";
  const name = match[1] === "Version" && userAgent.includes("Safari") ? "Safari" : match[1];
  return `${name} ${match[2]?.split(".")[0] ?? ""}`.trim();
}

function platformName(userAgent: string, width: number, height: number): string {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/iPhone|iPad/i.test(userAgent)) return "iOS";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Linux/i.test(userAgent)) return "Linux";
  return `${width}×${height}`;
}

function pageArea(report: ReportRecord): string | undefined {
  try {
    const pathname = new URL(report.browser.url).pathname;
    return pathname === "/" ? report.browser.title : pathname;
  } catch {
    return report.browser.title || undefined;
  }
}

function errorSignal(report: ReportRecord): string | undefined {
  const failedRequest = report.network.find((event) => (event.status ?? 0) >= 400);
  if (failedRequest) return `${failedRequest.method} ${failedRequest.url} ${failedRequest.status ?? ""}`.trim();
  const consoleError = report.console.find((event) => event.level === "error");
  return consoleError ? `${consoleError.level.toUpperCase()} ${consoleError.message}` : undefined;
}

function attachmentPresentation(asset: ReportRecord["assets"][number], index: number, createdAt: string): AttachmentPresentation {
  const extension = asset.contentType.split("/")[1] ?? "data";
  const title = asset.kind === "replay" ? "session-replay.json" : `${asset.kind}-${index + 1}.${extension}`;
  const kind = asset.kind === "video" ? "video" : asset.kind === "screenshot" ? "image" : "data";
  return {
    id: asset.objectKey,
    title,
    kind,
    meta: asset.size === undefined ? undefined : formatBytes(asset.size),
    time: formatDateTime(createdAt),
    url: asset.url,
  };
}

function activityPresentation(report: ReportRecord, reporter: PersonPresentation): ActivityPresentation[] {
  const activity: ActivityPresentation[] = [{
    label: `Report submitted by ${reporter.name}`,
    detail: "Browser and reproduction evidence captured.",
    time: formatDateTime(report.createdAt),
    kind: "report",
  }];
  if (report.aiTriage) activity.push({
    label: "AI triage generated",
    detail: `${Math.round(report.aiTriage.confidence * 100)}% confidence · ${report.aiTriage.likelyArea}`,
    time: formatDateTime(report.aiTriage.generatedAt),
    kind: "ai",
  });
  if (report.humanReview?.reviewedAt) activity.push({
    label: `Reviewed by ${displayIdentity(report.humanReview.reviewedBy ?? "Reviewer")}`,
    detail: report.humanReview.agentHandoffApproved ? "Engineering handoff approved." : "Kept for manual handling.",
    time: formatDateTime(report.humanReview.reviewedAt),
    kind: "review",
  });
  return activity;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export const dashboardDataSource: DashboardDataSource = {
  mode: "live",
  requiresAuthentication: true,
  apiUrl,
  checkSession,
  login,
  logout,
  fetchReports,
  updateReport,
  addNote,
  sendReply,
  requestGitHubIssue,
  requestEngineeringHandoff,
  updateReporterEmail,
  archiveReport,
  restoreReport,
  emailStatus,
  present,
  savedViews,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listUsers,
  createUser,
  deleteUser,
  githubStatus,
  listGitHubRepos,
  disconnectGitHub,
  githubConnectPath: "/v1/admin/github/connect",
};
