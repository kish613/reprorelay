import {
  ClientConfigSchema,
  ReportPayloadSchema,
  defaultCaptureConfig,
  defaultPrivacyConfig,
  type Asset,
  type Breadcrumb,
  type ClientConfig,
  type ReportPayload,
  type ReportRecord,
  type SessionResponse,
  type UploadIntentResponse,
} from "@reprorelay/shared";
import { getBrowserMetadata } from "./browser.js";
import { CaptureController } from "./capture.js";
import { appendReportHistory, readReportHistory, refreshReportHistory } from "./history.js";
import { captureScreenshot, recordScreenForDuration } from "./media.js";
import type { ReproRelayOptions, ReportDraft, UploadAssetInput } from "./types.js";
import { ReportWidget } from "./widget.js";

export class ReproRelayClient {
  private readonly config: ClientConfig;
  private readonly capture: CaptureController;
  private readonly widget: ReportWidget;
  private context: Record<string, unknown>;

  constructor(options: ReproRelayOptions) {
    const { buttonLabel, autoInjectButton, statusFeedUrl, widget, ...clientOptions } = options;
    this.config = ClientConfigSchema.parse(clientOptions);
    this.context = options.context ?? {};
    const captureConfig = { ...defaultCaptureConfig, ...this.config.capture };
    const privacyConfig = { ...defaultPrivacyConfig, ...this.config.privacy };
    this.capture = new CaptureController(privacyConfig);
    this.capture.start(captureConfig);
    this.widget = new ReportWidget(buttonLabel ?? "Report issue", {
      onSubmit: async (draft) => {
        await this.report(draft);
      },
      onDismiss: () => undefined,
      listHistory: () => readReportHistory(this.config.projectKey),
      refreshHistory: () => refreshReportHistory(this.config.projectKey, this.config.apiUrl, statusFeedUrl),
      historyScope: statusFeedUrl ? "project" : "browser",
      getReporterEmail: () => this.config.user?.email,
      captureScreenshot: this.config.capture?.screenshot !== false
        ? () => captureScreenshot(document.body, this.config.privacy)
        : undefined,
    }, widget);

    if (autoInjectButton !== false) this.widget.mount();
  }

  show(): void {
    this.widget.open();
  }

  addBreadcrumb(input: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
    this.capture.addBreadcrumb(input);
  }

  setUser(user: ClientConfig["user"]): void {
    Object.assign(this.config, { user });
  }

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  async report(draft: ReportDraft): Promise<ReportPayload> {
    // Start the legacy capture before the first await so getDisplayMedia still
    // runs inside the caller's user activation. The widget uses draft.recording.
    const legacyVideo = draft.includeVideo && !draft.recording
      ? recordScreenForDuration(10000)
      : undefined;
    const session = await this.createSession();
    const captured = this.capture.snapshot();
    const assets: Asset[] = [];

    // Prefer a screenshot the caller already captured (the widget attaches its
    // annotated composite here). `null` means the caller opted out; `undefined`
    // falls back to capturing the page at submit time.
    const screenshotBlob = draft.screenshot === null
      ? undefined
      : draft.screenshot
        ?? (this.config.capture?.screenshot !== false ? await captureScreenshot(document.body, this.config.privacy) : undefined);
    if (screenshotBlob) {
      const contentType = screenshotBlob.type === "image/jpeg" ? "image/jpeg" : "image/png";
      assets.push(await this.uploadAsset(session, { kind: "screenshot", blob: screenshotBlob, contentType }));
    }

    const replayBlob = new Blob([JSON.stringify(captured.replayEvents)], { type: "application/json" });
    if (replayBlob.size > 2) {
      assets.push(await this.uploadAsset(session, { kind: "replay", blob: replayBlob, contentType: "application/json" }));
    }

    const video = draft.recording?.blob ?? (legacyVideo ? await legacyVideo : undefined);
    if (video) {
      const contentType = draft.recording?.contentType ?? (video.type === "video/mp4" ? "video/mp4" : "video/webm");
      assets.push(await this.uploadAsset(session, { kind: "video", blob: video, contentType }));
    }

    const payload: ReportPayload = ReportPayloadSchema.parse({
      sessionId: session.sessionId,
      projectKey: this.config.projectKey,
      title: draft.title,
      comment: draft.comment,
      severity: draft.severity ?? "medium",
      user: draft.reporterEmail?.trim()
        ? { ...this.config.user, email: draft.reporterEmail.trim() }
        : this.config.user,
      release: this.config.release,
      environment: this.config.environment,
      browser: getBrowserMetadata(this.config.privacy),
      breadcrumbs: captured.breadcrumbs,
      console: captured.consoleEvents,
      network: captured.networkEvents,
      replayEvents: [],
      assets,
      // The spotlighted element rides in the free-form context so it reaches
      // the dashboard and AI triage without any schema change.
      context: draft.spotlight ? { ...this.context, spotlightElement: draft.spotlight } : this.context,
      createdAt: new Date().toISOString(),
    });

    const response = await fetch(`${this.config.apiUrl}/v1/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reprorelay-project": this.config.projectKey,
        "x-reprorelay-upload-token": session.uploadToken,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`ReproRelay report failed: ${response.status} ${await response.text()}`);
    }

    // Remember the submission locally so the widget can show "your previous
    // reports" — best-effort, the report has already been accepted.
    const record = (await response.json().catch(() => undefined)) as ReportRecord | undefined;
    appendReportHistory(this.config.projectKey, {
      id: record?.id ?? payload.sessionId,
      title: payload.title,
      severity: payload.severity,
      createdAt: record?.createdAt ?? payload.createdAt,
      hadVideo: assets.some((asset) => asset.kind === "video"),
      hadScreenshot: assets.some((asset) => asset.kind === "screenshot"),
      status: record?.status ?? "new",
      trackingToken: session.uploadToken,
      seenAt: record?.seenAt,
      updatedAt: record?.updatedAt ?? record?.createdAt ?? payload.createdAt,
    });

    return payload;
  }

  destroy(): void {
    this.capture.stop();
    this.widget.destroy();
  }

  private async createSession(): Promise<SessionResponse> {
    const response = await fetch(`${this.config.apiUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reprorelay-project": this.config.projectKey,
      },
      body: JSON.stringify({
        projectKey: this.config.projectKey,
        release: this.config.release,
        environment: this.config.environment,
      }),
    });

    if (!response.ok) throw new Error(`ReproRelay session failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as SessionResponse;
  }

  private async uploadAsset(session: SessionResponse, input: UploadAssetInput): Promise<Asset> {
    const intentResponse = await fetch(`${this.config.apiUrl}/v1/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reprorelay-project": this.config.projectKey,
        "x-reprorelay-upload-token": session.uploadToken,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        projectKey: this.config.projectKey,
        kind: input.kind,
        contentType: input.contentType,
        contentLength: input.blob.size,
      }),
    });

    if (!intentResponse.ok) throw new Error(`ReproRelay upload intent failed: ${intentResponse.status} ${await intentResponse.text()}`);
    const intent = (await intentResponse.json()) as UploadIntentResponse;

    const uploadResponse = await fetch(intent.uploadUrl, {
      method: intent.method,
      headers: { ...intent.headers, "content-type": input.contentType },
      body: input.blob,
    });

    if (!uploadResponse.ok) throw new Error(`ReproRelay upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);

    return {
      kind: input.kind,
      objectKey: intent.objectKey,
      contentType: input.contentType,
      size: input.blob.size,
      url: intent.publicUrl,
    };
  }
}

let currentClient: ReproRelayClient | undefined;

export function createReproRelayClient(options: ReproRelayOptions): ReproRelayClient {
  return new ReproRelayClient(options);
}

export const ReproRelay = {
  init(options: ReproRelayOptions): ReproRelayClient {
    currentClient?.destroy();
    currentClient = new ReproRelayClient(options);
    return currentClient;
  },
  show(): void {
    currentClient?.show();
  },
  report(draft: ReportDraft): Promise<ReportPayload> {
    if (!currentClient) throw new Error("ReproRelay has not been initialized");
    return currentClient.report(draft);
  },
  addBreadcrumb(input: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
    currentClient?.addBreadcrumb(input);
  },
  setUser(user: ClientConfig["user"]): void {
    currentClient?.setUser(user);
  },
  setContext(context: Record<string, unknown>): void {
    currentClient?.setContext(context);
  },
  destroy(): void {
    currentClient?.destroy();
    currentClient = undefined;
  },
};
