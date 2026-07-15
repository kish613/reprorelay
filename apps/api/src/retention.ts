import type { ReportStore } from "./store.js";
import type { ObjectStorage } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VideoRetentionResult {
  reportsUpdated: number;
  videosDeleted: number;
  failures: number;
}

/**
 * Deletes expired video objects, then removes their report asset references.
 * Object deletion is idempotent, so a failed report update can be retried safely.
 */
export async function deleteExpiredVideos(
  store: ReportStore,
  storage: ObjectStorage,
  options: { now?: Date; retentionDays: number },
): Promise<VideoRetentionResult> {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.retentionDays * DAY_MS;
  let reportsUpdated = 0;
  let videosDeleted = 0;
  let failures = 0;

  for (const report of await store.listReports()) {
    if (report.videoDeletedAt || new Date(report.createdAt).getTime() > cutoff) continue;
    const videos = report.assets.filter((asset) => asset.kind === "video");
    if (videos.length === 0) continue;

    try {
      for (const video of videos) await storage.deleteObject(video.objectKey);
    } catch {
      failures += videos.length;
      continue;
    }
    const updated = await store.updateReport(report.id, {
      assets: report.assets.filter((asset) => asset.kind !== "video"),
      videoDeletedAt: now.toISOString(),
    });
    if (updated) {
      reportsUpdated += 1;
      videosDeleted += videos.length;
    }
  }

  return { reportsUpdated, videosDeleted, failures };
}
