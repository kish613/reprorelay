import {
  ProjectReportStatusesResponseSchema,
  ReportStatusesResponseSchema,
  type ProjectReportStatus,
  type PublicReportStatus,
} from "@reprorelay/shared";

/**
 * Per-browser record of reports submitted from this device, so customers can
 * check whether they already reported a problem. The receipt token is a
 * capability for the sanitized public status only; full report reads remain
 * admin-gated.
 */
export interface ReportHistoryEntry {
  id: string;
  title: string;
  severity: string;
  createdAt: string;
  hadVideo: boolean;
  hadScreenshot: boolean;
  /** Latest workflow status returned by the API. */
  status: string;
  /** Private receipt issued to this browser at submission time. */
  trackingToken?: string;
  seenAt?: string;
  updatedAt?: string;
}

const MAX_ENTRIES = 20;

export function readReportHistory(projectKey: string): ReportHistoryEntry[] {
  try {
    const raw = storage().getItem(storageKey(projectKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function appendReportHistory(projectKey: string, entry: ReportHistoryEntry): void {
  try {
    const entries = [entry, ...readReportHistory(projectKey)].slice(0, MAX_ENTRIES);
    writeReportHistory(projectKey, entries);
  } catch {
    // Storage may be unavailable (private browsing, quota) — history is best-effort.
  }
}

export async function refreshReportHistory(
  projectKey: string,
  apiUrl: string,
  statusFeedUrl?: string,
): Promise<ReportHistoryEntry[]> {
  const entries = readReportHistory(projectKey);
  if (statusFeedUrl) {
    const response = await fetch(statusFeedUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ReproRelay shared status refresh failed: ${response.status}`);

    const body = ProjectReportStatusesResponseSchema.parse(await response.json());
    const next = mergeProjectReportStatuses(entries, body.reports);
    writeReportHistory(projectKey, next);
    return next;
  }

  const receipts = entries.flatMap((entry) => entry.trackingToken
    ? [{ id: entry.id, trackingToken: entry.trackingToken }]
    : []);
  if (!receipts.length) return entries;

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/report-statuses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey, receipts }),
  });
  if (!response.ok) throw new Error(`ReproRelay status refresh failed: ${response.status}`);

  const body = ReportStatusesResponseSchema.parse(await response.json());
  const next = mergeReportHistoryStatuses(entries, body.reports);
  writeReportHistory(projectKey, next);
  return next;
}

export function mergeProjectReportStatuses(
  entries: ReportHistoryEntry[],
  statuses: ProjectReportStatus[],
): ReportHistoryEntry[] {
  const localById = new Map(entries.map((entry) => [entry.id, entry]));
  return statuses.slice(0, MAX_ENTRIES).map((status) => ({
    id: status.id,
    title: status.title,
    severity: status.severity,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    seenAt: status.seenAt,
    hadVideo: status.hadVideo,
    hadScreenshot: status.hadScreenshot,
    status: status.status,
    trackingToken: localById.get(status.id)?.trackingToken,
  }));
}

export function mergeReportHistoryStatuses(
  entries: ReportHistoryEntry[],
  statuses: PublicReportStatus[],
): ReportHistoryEntry[] {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return entries.map((entry) => {
    const status = byId.get(entry.id);
    return status ? {
      ...entry,
      status: status.status,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
      seenAt: status.seenAt,
      hadVideo: status.hadVideo,
      hadScreenshot: status.hadScreenshot,
    } : entry;
  });
}

function storageKey(projectKey: string): string {
  return `reprorelay.history.${projectKey}.v1`;
}

function writeReportHistory(projectKey: string, entries: ReportHistoryEntry[]): void {
  storage().setItem(storageKey(projectKey), JSON.stringify(entries));
}

/** window.localStorage explicitly — Node exposes a non-functional bare `localStorage` global. */
function storage(): Storage {
  return window.localStorage;
}

function isEntry(value: unknown): value is ReportHistoryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReportHistoryEntry).id === "string" &&
    typeof (value as ReportHistoryEntry).title === "string" &&
    typeof (value as ReportHistoryEntry).createdAt === "string"
  );
}
