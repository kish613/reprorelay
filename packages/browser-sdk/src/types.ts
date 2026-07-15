import type { Asset, Breadcrumb, ClientConfig, ConsoleEvent, NetworkEvent } from "@reprorelay/shared";
import type { SpotlightSelection } from "./live-overlay.js";
import type { ScreenRecordingResult } from "./media.js";

export interface ReportDraft {
  title: string;
  comment: string;
  severity?: "low" | "medium" | "high" | "critical";
  /** Optional reply address collected by the widget when the host has not identified the user. */
  reporterEmail?: string;
  recording?: ScreenRecordingResult;
  /**
   * A screenshot to attach with the report, already captured (and optionally
   * annotated) by the caller. When a Blob is provided, the client uploads it
   * as-is instead of capturing the page again at submit time (the widget uses
   * this to attach the flattened annotation composite). `null` means the caller
   * deliberately wants no screenshot; `undefined` leaves capture to the config.
   */
  screenshot?: Blob | null;
  /** Element the reporter spotlighted while recording (selector + viewport rect, no text). */
  spotlight?: SpotlightSelection;
  /** @deprecated Use the widget recorder or startScreenRecording() before submission. */
  includeVideo?: boolean;
}

export interface CapturedState {
  breadcrumbs: Breadcrumb[];
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
  replayEvents: unknown[];
}

export interface ReproRelayOptions extends ClientConfig {
  buttonLabel?: string;
  autoInjectButton?: boolean;
  /**
   * Same-origin authenticated endpoint returning the shared project status
   * feed. Use a server proxy so project status credentials never reach the
   * browser. When omitted, status remains private to this browser's receipts.
   */
  statusFeedUrl?: string;
  widget?: ReproRelayWidgetOptions;
}

export interface ReproRelayWidgetOptions {
  position?: "right-center" | "right-bottom" | "left-center" | "left-bottom";
  accentColor?: string;
  logoUrl?: string;
  /** Show host-supplied attribution in the widget header. Defaults to false. */
  showAttribution?: boolean;
  attributionLabel?: string;
  attributionName?: string;
  attributionLogoUrl?: string;
  enableScreenRecording?: boolean;
  enableCameraRecording?: boolean;
  enableMicrophone?: boolean;
  maxRecordingMs?: number;
  /** Show an optional reporter email field when the host app has not supplied user.email. Defaults to true. */
  collectReporterEmail?: boolean;
}

export interface UploadAssetInput {
  kind: Asset["kind"];
  blob: Blob;
  contentType: Asset["contentType"];
}
