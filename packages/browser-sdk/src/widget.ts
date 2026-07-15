import {
  ANNOTATION_TOOLS,
  compositeScreenshot,
  drawAnnotation,
  drawAnnotations,
  isMeaningfulShape,
  loadImage,
  naturalScale,
  toNaturalPoint,
  type Annotation,
  type AnnotationTool,
} from "./annotate.js";
import { DEFAULT_REPRORELAY_MARK } from "./brand.js";
import type { ReportHistoryEntry } from "./history.js";
import { LiveOverlay, type LiveTool, type SpotlightSelection } from "./live-overlay.js";
import { startScreenRecording, type ActiveScreenRecording, type ScreenRecordingResult } from "./media.js";
import type { ReproRelayWidgetOptions, ReportDraft } from "./types.js";

interface WidgetCallbacks {
  onSubmit: (draft: ReportDraft) => Promise<void>;
  onDismiss: () => void;
  /** Reports previously sent from this browser, newest first. */
  listHistory?: () => ReportHistoryEntry[];
  /** Refreshes the sanitized status for receipts owned by this browser. */
  refreshHistory?: () => Promise<ReportHistoryEntry[]>;
  /** Whether report history belongs to this browser or the signed-in project organisation. */
  historyScope?: "browser" | "project";
  /** Current host-provided reporter email, read lazily so setUser() is reflected. */
  getReporterEmail?: () => string | undefined;
  /**
   * Captures a screenshot of the page for the user to preview and annotate.
   * Absent when screenshot capture is disabled for the project.
   */
  captureScreenshot?: () => Promise<Blob>;
}

type WidgetPhase = "choose" | "form" | "success" | "history";
type RecordingMode = "screen" | "camera";

const DEFAULT_MAX_RECORDING_MS = 90_000;
const LAUNCHER_SHIFT_KEY = "reprorelay.launcher-shift.v1";
const DRAG_THRESHOLD_PX = 5;

/** Annotation colour swatches: brand, red (redact), amber (highlight), ink (pen). */
const ANNOTATION_SWATCHES = ["#ff4f14", "#e5484d", "#f5b301", "#1f2937"] as const;
/** Stroke/handle sizes in CSS pixels; scaled to natural image pixels when drawn. */
const STROKE_SIZES: Record<"s" | "l", number> = { s: 3, l: 7 };
const ANNOTATION_TOOL_LABELS: Record<AnnotationTool, string> = {
  pen: "Pen",
  box: "Box",
  ellipse: "Circle",
  highlight: "Highlight",
  redact: "Redact",
  arrow: "Arrow",
};

const LIVE_TOOLS = ["pen", "ellipse", "arrow"] as const;
const LIVE_TOOL_LABELS: Record<LiveTool, string> = {
  pen: "Draw",
  ellipse: "Circle",
  arrow: "Arrow",
};

export class ReportWidget {
  private host?: HTMLDivElement;
  private root?: ShadowRoot;
  private panelOpen = false;
  private phase: WidgetPhase = "choose";
  private recording?: ActiveScreenRecording;
  private recorded?: ScreenRecordingResult;
  private previewUrl?: string;
  private previewOpen = false;
  private startingMode?: RecordingMode;
  private stopping = false;
  private submitting = false;
  private error?: string;
  private historyLoading = false;
  private historyError?: string;
  private historyLastCheckedAt?: string;
  private historySnapshot?: ReportHistoryEntry[];
  private resolvedHistoryOpen = false;
  private timerId?: number;
  private successTimerId?: number;
  private destroyed = false;
  private launcherShift = 0;
  private dragState?: { startY: number; startShift: number; moved: boolean };
  private suppressNextOpen = false;
  private liveOverlay?: LiveOverlay;
  private liveColor: string = ANNOTATION_SWATCHES[0];
  private spotlightMeta?: SpotlightSelection;
  private screenshot?: { blob: Blob; url: string; naturalWidth: number; naturalHeight: number; image?: HTMLImageElement };
  private screenshotCapturing = false;
  private screenshotRemoved = false;
  private annotatedBlob?: Blob;
  private annotatedUrl?: string;
  private annotateOpen = false;
  private annotations: Annotation[] = [];
  private tool: AnnotationTool = "pen";
  private annotationColor: string = ANNOTATION_SWATCHES[0];
  private strokeSize: "s" | "l" = "s";
  private compositing = false;
  private activeAnnotation?: Annotation;
  private drawingPointerId?: number;
  private draft: Pick<ReportDraft, "title" | "comment" | "severity" | "reporterEmail"> = {
    title: "",
    comment: "",
    severity: "medium",
    reporterEmail: "",
  };

  constructor(
    private readonly label: string,
    private readonly callbacks: WidgetCallbacks,
    private readonly options: ReproRelayWidgetOptions = {},
  ) {}

  mount(): void {
    if (this.host) return;

    const host = document.createElement("div");
    host.setAttribute("data-reprorelay-widget", "");
    host.setAttribute("data-reprorelay-ignore", "");
    host.setAttribute("data-position", this.options.position ?? "right-center");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${WIDGET_STYLES}</style><div class="reprorelay-root"></div>`;

    if (this.options.accentColor && globalThis.CSS?.supports?.("color", this.options.accentColor)) {
      host.style.setProperty("--rr-accent", this.options.accentColor);
    }

    document.body.appendChild(host);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("resize", this.handleWindowResize);
    this.host = host;
    this.root = root;
    this.setLauncherShift(readStoredShift());
    this.render();
  }

  open(): void {
    if (!this.host) this.mount();
    if (this.recording) return;
    this.panelOpen = true;
    this.phase = this.recorded ? "form" : this.phase;
    this.error = undefined;
    this.render();
    if (this.phase === "form") this.ensureScreenshot();
    window.setTimeout(() => this.root?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 0);
  }

  close(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.error = undefined;
    if (this.phase === "history") this.phase = "choose";
    this.render();
    this.callbacks.onDismiss();
    window.setTimeout(() => this.root?.querySelector<HTMLButtonElement>(".reprorelay-launcher")?.focus(), 0);
  }

  destroy(): void {
    this.destroyed = true;
    this.recording?.discard();
    this.stopLiveOverlay(false);
    this.stopTimer();
    if (this.successTimerId !== undefined) window.clearTimeout(this.successTimerId);
    this.revokePreview();
    this.revokeScreenshot();
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("resize", this.handleWindowResize);
    this.host?.remove();
    this.host = undefined;
    this.root = undefined;
  }

  private readonly handleWindowResize = (): void => {
    if (this.annotateOpen) this.redrawAnnotateCanvas();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.liveOverlay && (this.liveOverlay.tool || this.liveOverlay.isPicking)) {
      this.liveOverlay.setTool(null);
      this.liveOverlay.cancelPicker();
      this.syncDockToolbar();
      return;
    }
    if (this.annotateOpen && !this.compositing) {
      this.closeAnnotate();
      return;
    }
    if (this.panelOpen && !this.submitting) this.close();
  };

  private render(): void {
    const container = this.root?.querySelector<HTMLDivElement>(".reprorelay-root");
    if (!container) return;

    if (this.recording) {
      container.innerHTML = this.recordingDockTemplate();
    } else {
      container.innerHTML = `${this.launcherTemplate()}${this.panelOpen ? this.panelTemplate() : ""}`;
      // Annotation editor layers above the panel; appended separately so the
      // panel markup stays untouched.
      if (this.annotateOpen) container.insertAdjacentHTML("beforeend", this.annotateTemplate());
    }

    const logoUrl = safeLogoUrl(this.options.logoUrl) ?? DEFAULT_REPRORELAY_MARK;
    container.querySelectorAll<HTMLImageElement>("[data-reprorelay-logo]").forEach((image) => {
      image.src = logoUrl;
    });
    const attributionLogoUrl = safeLogoUrl(this.options.attributionLogoUrl);
    if (attributionLogoUrl) {
      container.querySelectorAll<HTMLImageElement>("[data-reprorelay-attribution-logo]").forEach((image) => {
        image.src = attributionLogoUrl;
      });
    }

    const launcher = container.querySelector<HTMLButtonElement>('[data-action="open"]');
    launcher?.addEventListener("click", () => {
      // A drag gesture ends in a click event — don't treat it as "open".
      if (this.suppressNextOpen) {
        this.suppressNextOpen = false;
        return;
      }
      this.open();
    });
    if (launcher) this.bindLauncherDrag(launcher);
    container.querySelectorAll<HTMLElement>('[data-action="show-history"]').forEach((element) => {
      element.addEventListener("click", () => this.openHistory());
    });
    container.querySelectorAll<HTMLElement>('[data-action="show-report"]').forEach((element) => {
      element.addEventListener("click", () => {
        this.phase = "choose";
        this.render();
      });
    });
    container.querySelector<HTMLElement>('[data-action="refresh-history"]')?.addEventListener("click", () => {
      void this.refreshHistory();
    });
    container.querySelector<HTMLElement>('[data-action="toggle-resolved-history"]')?.addEventListener("click", () => {
      this.resolvedHistoryOpen = !this.resolvedHistoryOpen;
      this.render();
    });
    container.querySelectorAll<HTMLElement>('[data-action="close"]').forEach((element) => {
      element.addEventListener("click", () => this.close());
    });
    container.querySelectorAll<HTMLButtonElement>("[data-recording-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.recordingMode === "camera" ? "camera" : "screen";
        void this.startRecording(mode);
      });
    });
    container.querySelector<HTMLElement>('[data-action="skip-recording"]')?.addEventListener("click", () => {
      this.enterForm();
    });
    container.querySelector<HTMLElement>('[data-action="add-recording"]')?.addEventListener("click", () => {
      this.phase = "choose";
      this.error = undefined;
      this.render();
    });
    container.querySelectorAll<HTMLButtonElement>("[data-live-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        const tool = button.dataset.liveTool as LiveTool;
        // Toggle in place — re-rendering the dock replays its entry animation.
        this.liveOverlay?.setTool(this.liveOverlay.tool === tool ? null : tool);
        this.syncDockToolbar();
      });
    });
    container.querySelector<HTMLElement>('[data-action="live-spotlight"]')?.addEventListener("click", () => {
      const overlay = this.liveOverlay;
      if (!overlay) return;
      if (overlay.isPicking) overlay.cancelPicker();
      else if (overlay.spotlight) overlay.clearSpotlight();
      else overlay.startPicker();
      this.syncDockToolbar();
    });
    container.querySelector<HTMLButtonElement>('[data-action="live-color"]')?.addEventListener("click", (event) => {
      const nextIndex = (ANNOTATION_SWATCHES.indexOf(this.liveColor as (typeof ANNOTATION_SWATCHES)[number]) + 1) % ANNOTATION_SWATCHES.length;
      this.liveColor = ANNOTATION_SWATCHES[nextIndex] ?? ANNOTATION_SWATCHES[0];
      this.liveOverlay?.setColor(this.liveColor);
      (event.currentTarget as HTMLElement | null)?.style.setProperty("--rr-live-color", this.liveColor);
    });
    container.querySelector<HTMLElement>('[data-action="live-undo"]')?.addEventListener("click", () => {
      this.liveOverlay?.undo();
      this.syncDockToolbar();
    });
    container.querySelector<HTMLElement>('[data-action="live-clear"]')?.addEventListener("click", () => {
      this.liveOverlay?.clear();
      this.liveOverlay?.clearSpotlight();
      this.syncDockToolbar();
    });
    container.querySelector<HTMLElement>('[data-action="stop-recording"]')?.addEventListener("click", () => {
      void this.stopRecording();
    });
    container.querySelector<HTMLElement>('[data-action="toggle-preview"]')?.addEventListener("click", () => {
      this.previewOpen = !this.previewOpen;
      this.render();
    });
    container.querySelector<HTMLElement>('[data-action="remove-recording"]')?.addEventListener("click", () => {
      this.recorded = undefined;
      this.previewOpen = false;
      this.revokePreview();
      this.render();
    });
    container.querySelector<HTMLElement>('[data-action="remove-screenshot"]')?.addEventListener("click", () => {
      this.revokeScreenshot();
      this.screenshotRemoved = true;
      this.render();
    });
    container.querySelector<HTMLElement>('[data-action="add-screenshot"]')?.addEventListener("click", () => {
      this.screenshotRemoved = false;
      this.ensureScreenshot();
    });
    container.querySelector<HTMLElement>('[data-action="annotate"]')?.addEventListener("click", () => {
      this.openAnnotate();
    });

    if (this.annotateOpen) this.bindAnnotateEvents(container);

    const form = container.querySelector<HTMLFormElement>("form");
    form?.addEventListener("input", () => this.readDraft(form));
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.readDraft(form);
      void this.submitReport();
    });

    if (this.previewOpen && this.previewUrl) {
      const video = container.querySelector<HTMLVideoElement>("[data-recording-preview]");
      if (video) video.src = this.previewUrl;
    }

    if (this.panelOpen) this.applyPanelShift();
  }

  /** Follows the launcher's dragged position, clamped so the panel stays on screen. */
  private applyPanelShift(): void {
    if (!this.host) return;
    const panel = this.root?.querySelector<HTMLElement>(".reprorelay-panel");
    const half = window.innerHeight / 2;
    const panelHalf = (panel?.offsetHeight ?? 0) / 2;
    const max = Math.max(0, half - panelHalf - 12);
    const clamped = Math.max(-max, Math.min(max, this.launcherShift));
    this.host.style.setProperty("--rr-panel-shift", `${Math.round(clamped)}px`);
  }

  private setLauncherShift(value: number): void {
    if (!this.host) return;
    const anchoredBottom = (this.options.position ?? "right-center").endsWith("bottom");
    const limit = anchoredBottom
      ? Math.max(0, window.innerHeight - 110)
      : Math.max(0, window.innerHeight / 2 - 40);
    // Bottom-anchored launchers only travel upwards (negative shift).
    const clamped = anchoredBottom
      ? Math.max(-limit, Math.min(0, value))
      : Math.max(-limit, Math.min(limit, value));
    this.launcherShift = Math.round(clamped);
    this.host.style.setProperty("--rr-shift", `${this.launcherShift}px`);
  }

  private bindLauncherDrag(launcher: HTMLElement): void {
    const usePointer = typeof window.PointerEvent === "function";
    const downEvent = usePointer ? "pointerdown" : "mousedown";
    const moveEvent = usePointer ? "pointermove" : "mousemove";
    const upEvent = usePointer ? "pointerup" : "mouseup";

    launcher.addEventListener(downEvent, (event) => {
      const down = event as MouseEvent;
      if (down.button !== undefined && down.button !== 0) return;
      this.dragState = { startY: down.clientY, startShift: this.launcherShift, moved: false };

      const onMove = (raw: Event): void => {
        if (!this.dragState) return;
        const delta = (raw as MouseEvent).clientY - this.dragState.startY;
        if (!this.dragState.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
        this.dragState.moved = true;
        this.host?.classList.add("reprorelay-dragging");
        this.setLauncherShift(this.dragState.startShift + delta);
        raw.preventDefault?.();
      };
      const onUp = (): void => {
        window.removeEventListener(moveEvent, onMove);
        window.removeEventListener(upEvent, onUp);
        this.host?.classList.remove("reprorelay-dragging");
        if (this.dragState?.moved) {
          this.suppressNextOpen = true;
          persistShift(this.launcherShift);
        }
        this.dragState = undefined;
      };

      window.addEventListener(moveEvent, onMove);
      window.addEventListener(upEvent, onUp);
    });
  }

  private launcherTemplate(): string {
    return `
      <button
        type="button"
        class="reprorelay-launcher"
        data-action="open"
        aria-label="${escapeHtml(this.label)}"
        aria-expanded="${this.panelOpen}"
        title="${escapeHtml(this.label)}"
      >
        <img data-reprorelay-logo alt="" />
        <span>${escapeHtml(this.label)}</span>
      </button>
    `;
  }

  private panelTemplate(): string {
    if (this.phase === "success") return this.successTemplate();

    const attributionName = this.options.attributionName ?? "ReproRelay";
    const attributionLogoUrl = safeLogoUrl(this.options.attributionLogoUrl);

    return `
      <section class="reprorelay-panel" role="dialog" aria-label="Report a problem">
        <header class="reprorelay-header">
          <div class="reprorelay-brand">
            <img data-reprorelay-logo alt="" />
            <div><strong>ReproRelay</strong><span>Report a problem</span></div>
          </div>
          <div class="reprorelay-header-tools">
            ${this.options.showAttribution === true ? `
              <div class="reprorelay-attribution" aria-label="${escapeHtml(this.options.attributionLabel ?? "By")} ${escapeHtml(attributionName)}">
                <span>${escapeHtml(this.options.attributionLabel ?? "By")}</span>
                ${attributionLogoUrl ? `<span class="reprorelay-attribution-mark"><img data-reprorelay-attribution-logo alt="${escapeHtml(attributionName)}" /></span>` : `<strong>${escapeHtml(attributionName)}</strong>`}
              </div>
            ` : ""}
            <button type="button" class="reprorelay-icon-button" data-action="close" aria-label="Close report widget">
              ${closeIcon()}
            </button>
          </div>
        </header>
        ${this.phase === "choose" || this.phase === "history" ? this.panelTabsTemplate() : ""}
        ${this.phase === "history" ? this.historyTemplate() : this.phase === "choose" ? this.captureChoiceTemplate() : this.reportFormTemplate()}
      </section>
    `;
  }

  private panelTabsTemplate(): string {
    const count = this.historyEntries().length;
    return `
      <nav class="reprorelay-tabs" aria-label="Report widget sections">
        <button type="button" role="tab" data-action="show-report" aria-selected="${this.phase === "choose"}" class="${this.phase === "choose" ? "reprorelay-tab-active" : ""}">Report problem</button>
        <button type="button" role="tab" data-action="show-history" aria-selected="${this.phase === "history"}" class="${this.phase === "history" ? "reprorelay-tab-active" : ""}">
          Status${count ? `<span>${count}</span>` : ""}
        </button>
      </nav>
    `;
  }

  private captureChoiceTemplate(): string {
    const screenEnabled = this.options.enableScreenRecording !== false;
    const cameraEnabled = screenEnabled && this.options.enableCameraRecording !== false;
    const microphoneEnabled = this.options.enableMicrophone !== false;
    const maxDuration = formatDuration(this.maxRecordingMs);
    const starting = Boolean(this.startingMode);

    return `
      <div class="reprorelay-body">
        <div class="reprorelay-intro">
          <h2>Show us what happened</h2>
          <p>Start a recording, reproduce the problem, then stop when you’re done.</p>
        </div>
        ${this.errorTemplate()}
        <div class="reprorelay-capture-options">
          ${screenEnabled ? `
            <button type="button" class="reprorelay-capture-option" data-recording-mode="screen" ${starting ? "disabled" : ""}>
              <span class="reprorelay-option-icon">${screenIcon()}</span>
              <span><strong>${microphoneEnabled ? "Screen + voice" : "Record the screen"}</strong><small>${microphoneEnabled ? "Explain the issue while you navigate" : "Capture what you do on screen"}</small></span>
              ${chevronIcon()}
            </button>
          ` : ""}
          ${cameraEnabled ? `
            <button type="button" class="reprorelay-capture-option" data-recording-mode="camera" ${starting ? "disabled" : ""}>
              <span class="reprorelay-option-icon">${cameraIcon()}</span>
              <span><strong>Screen + camera</strong><small>${microphoneEnabled ? "Include your face and voice" : "Include your face as you navigate"}</small></span>
              ${chevronIcon()}
            </button>
          ` : ""}
        </div>
        ${starting ? `<div class="reprorelay-permission"><span class="reprorelay-spinner"></span>Waiting for browser permission…</div>` : ""}
        <button type="button" class="reprorelay-text-button" data-action="skip-recording" ${starting ? "disabled" : ""}>
          Continue without recording
        </button>
        <div class="reprorelay-privacy">
          ${lockIcon()}
          <span>You choose what to share. Recording stops automatically after ${maxDuration}.</span>
        </div>
      </div>
    `;
  }

  private reportFormTemplate(): string {
    const collectReporterEmail = this.options.collectReporterEmail !== false && !this.callbacks.getReporterEmail?.();
    return `
      <form class="reprorelay-form">
        <div class="reprorelay-body reprorelay-form-body">
          <div class="reprorelay-intro reprorelay-form-intro">
            <h2>What went wrong?</h2>
            <p>Add a short description so the recording has useful context.</p>
          </div>
          ${this.errorTemplate()}
          ${this.recordingSummaryTemplate()}
          ${this.screenshotSummaryTemplate()}
          <label class="reprorelay-field">
            <span>Short title</span>
            <input data-autofocus name="title" required minlength="3" maxlength="160" placeholder="e.g. Checkout button did nothing" value="${escapeHtml(this.draft.title)}" ${this.submitting ? "disabled" : ""} />
          </label>
          <label class="reprorelay-field">
            <span>What happened?</span>
            <textarea name="comment" required maxlength="8000" rows="4" placeholder="Tell us what you expected and what happened instead." ${this.submitting ? "disabled" : ""}>${escapeHtml(this.draft.comment)}</textarea>
          </label>
          ${collectReporterEmail ? `
            <label class="reprorelay-field">
              <span>Your email <small>(optional)</small></span>
              <input name="reporterEmail" type="email" autocomplete="email" maxlength="320" placeholder="So we can reply about this report" value="${escapeHtml(this.draft.reporterEmail ?? "")}" ${this.submitting ? "disabled" : ""} />
            </label>
          ` : ""}
          <fieldset class="reprorelay-priority" ${this.submitting ? "disabled" : ""}>
            <legend>Priority</legend>
            <span class="reprorelay-priority-help">How important is this issue to you?</span>
            <div class="reprorelay-priority-options">
              ${priorityOption("low", "Low", this.draft.severity)}
              ${priorityOption("medium", "Normal", this.draft.severity)}
              ${priorityOption("high", "High", this.draft.severity)}
              ${priorityOption("critical", "Urgent", this.draft.severity)}
            </div>
          </fieldset>
          <div class="reprorelay-evidence-note">
            ${paperclipIcon()}
            <span>Screenshot, session replay, browser details and technical context will also be attached.</span>
          </div>
        </div>
        <footer class="reprorelay-footer">
          <button type="button" class="reprorelay-secondary" data-action="close" ${this.submitting ? "disabled" : ""}>Cancel</button>
          <button type="submit" class="reprorelay-primary" ${this.submitting ? "disabled" : ""}>
            ${this.submitting ? `<span class="reprorelay-spinner reprorelay-spinner-light"></span>Sending…` : `${sendIcon()} Send report`}
          </button>
        </footer>
      </form>
    `;
  }

  private recordingSummaryTemplate(): string {
    if (!this.recorded) {
      if (this.options.enableScreenRecording === false) return "";
      return `
        <button type="button" class="reprorelay-add-recording" data-action="add-recording" ${this.submitting ? "disabled" : ""}>
          ${videoIcon()} Add a screen recording
        </button>
      `;
    }

    const labels = [
      "Screen",
      ...(this.recorded.includesCamera ? ["camera"] : []),
      ...(this.recorded.includesMicrophone ? ["voice"] : []),
    ];

    return `
      <div class="reprorelay-recording-card">
        <div class="reprorelay-recording-meta">
          <span class="reprorelay-recording-check">${checkIcon()}</span>
          <div><strong>Recording ready</strong><small>${labels.join(" + ")} · ${formatDuration(this.recorded.durationMs)}</small></div>
        </div>
        <div class="reprorelay-recording-actions">
          <button type="button" data-action="toggle-preview" ${this.submitting ? "disabled" : ""}>${this.previewOpen ? "Hide" : "Preview"}</button>
          <button type="button" data-action="remove-recording" ${this.submitting ? "disabled" : ""}>Remove</button>
        </div>
        ${this.previewOpen ? `<video class="reprorelay-preview" data-recording-preview controls playsinline></video>` : ""}
      </div>
    `;
  }

  private screenshotSummaryTemplate(): string {
    // No card when screenshot capture is disabled for the project.
    if (!this.callbacks.captureScreenshot) return "";

    if (this.screenshotRemoved || (!this.screenshot && !this.screenshotCapturing)) {
      return `
        <button type="button" class="reprorelay-add-recording" data-action="add-screenshot" ${this.submitting ? "disabled" : ""}>
          ${imageIcon()} Add a screenshot
        </button>
      `;
    }

    if (this.screenshotCapturing || !this.screenshot) {
      return `
        <div class="reprorelay-shot-card reprorelay-shot-loading">
          <span class="reprorelay-spinner"></span>
          <span>Capturing screenshot…</span>
        </div>
      `;
    }

    const annotated = Boolean(this.annotatedBlob);
    const thumbUrl = (annotated ? this.annotatedUrl : this.screenshot.url) ?? "";
    return `
      <div class="reprorelay-shot-card">
        <div class="reprorelay-shot-preview">
          <img src="${escapeHtml(thumbUrl)}" alt="Screenshot preview" />
          ${annotated ? `<span class="reprorelay-shot-badge">${penIcon()} Annotated</span>` : ""}
        </div>
        <div class="reprorelay-shot-body">
          <div class="reprorelay-shot-copy">
            <strong>Screenshot ready</strong>
            <small>${annotated ? "Your markup will be sent with the report." : "Draw on it to point out the problem."}</small>
          </div>
          <div class="reprorelay-shot-actions">
            <button type="button" class="reprorelay-shot-annotate" data-action="annotate" ${this.submitting ? "disabled" : ""}>
              ${penIcon()} ${annotated ? "Edit markup" : "Annotate"}
            </button>
            <button type="button" data-action="remove-screenshot" ${this.submitting ? "disabled" : ""}>Remove</button>
          </div>
        </div>
      </div>
    `;
  }

  private annotateTemplate(): string {
    const hasAnnotations = this.annotations.length > 0;
    const busy = this.compositing;

    const tools = ANNOTATION_TOOLS.map((tool) => `
      <button
        type="button"
        class="reprorelay-tool ${this.tool === tool ? "reprorelay-tool-active" : ""}"
        data-annotate-tool="${tool}"
        aria-pressed="${this.tool === tool}"
        aria-label="${ANNOTATION_TOOL_LABELS[tool]}"
        title="${ANNOTATION_TOOL_LABELS[tool]}"
        ${busy ? "disabled" : ""}
      >${annotationToolIcon(tool)}</button>
    `).join("");

    const swatches = ANNOTATION_SWATCHES.map((color) => `
      <button
        type="button"
        class="reprorelay-swatch ${this.annotationColor === color ? "reprorelay-swatch-active" : ""}"
        data-annotate-color="${color}"
        aria-pressed="${this.annotationColor === color}"
        aria-label="Colour ${color}"
        title="${color}"
        style="--rr-swatch: ${color}"
        ${busy ? "disabled" : ""}
      ></button>
    `).join("");

    const widths = (["s", "l"] as const).map((size) => `
      <button
        type="button"
        class="reprorelay-width reprorelay-width-${size} ${this.strokeSize === size ? "reprorelay-width-active" : ""}"
        data-annotate-width="${size}"
        aria-pressed="${this.strokeSize === size}"
        aria-label="${size === "s" ? "Thin stroke" : "Thick stroke"}"
        title="${size === "s" ? "Thin" : "Thick"}"
        ${busy ? "disabled" : ""}
      ><span></span></button>
    `).join("");

    return `
      <div class="reprorelay-annotate" role="dialog" aria-modal="true" aria-label="Annotate screenshot">
        <div class="reprorelay-annotate-card">
          <header class="reprorelay-annotate-head">
            <strong>Mark up the screenshot</strong>
            <button type="button" class="reprorelay-icon-button" data-action="annotate-close" aria-label="Close annotation editor" ${busy ? "disabled" : ""}>${closeIcon()}</button>
          </header>
          <div class="reprorelay-annotate-stage" data-annotate-stage>
            <canvas class="reprorelay-annotate-canvas" data-annotate-canvas></canvas>
          </div>
          <div class="reprorelay-annotate-toolbar">
            <div class="reprorelay-tool-group" role="group" aria-label="Tools">${tools}</div>
            <div class="reprorelay-tool-group" role="group" aria-label="Colour">${swatches}</div>
            <div class="reprorelay-tool-group" role="group" aria-label="Stroke width">${widths}</div>
            <span class="reprorelay-tool-spacer"></span>
            <div class="reprorelay-tool-group">
              <button type="button" class="reprorelay-tool-text" data-action="annotate-undo" ${hasAnnotations && !busy ? "" : "disabled"}>${undoIcon()} Undo</button>
              <button type="button" class="reprorelay-tool-text" data-action="annotate-clear" ${hasAnnotations && !busy ? "" : "disabled"}>Clear</button>
            </div>
            <button type="button" class="reprorelay-annotate-done" data-action="annotate-done" ${busy ? "disabled" : ""}>
              ${busy ? `<span class="reprorelay-spinner reprorelay-spinner-light"></span>Saving…` : `${checkIcon()} Done`}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private recordingDockTemplate(): string {
    const liveTool = this.liveOverlay?.tool;
    const tools = LIVE_TOOLS.map((tool) => `
      <button
        type="button"
        data-live-tool="${tool}"
        class="${liveTool === tool ? "reprorelay-tool-active" : ""}"
        aria-pressed="${liveTool === tool}"
        aria-label="${LIVE_TOOL_LABELS[tool]}"
        title="${LIVE_TOOL_LABELS[tool]}"
      >${annotationToolIcon(tool === "ellipse" ? "ellipse" : tool)}</button>
    `).join("");

    return `
      <div class="reprorelay-recording-dock" role="status" aria-live="polite">
        <div class="reprorelay-dock-row">
          <span class="reprorelay-live-dot"></span>
          <span class="reprorelay-recording-label"><strong>Recording</strong><small>${formatDuration(Date.now() - this.recording!.startedAt)}</small></span>
          <button type="button" data-action="stop-recording" ${this.stopping ? "disabled" : ""}>
            <span class="reprorelay-stop-square"></span>${this.stopping ? "Finishing…" : "Stop"}
          </button>
        </div>
        <div class="reprorelay-dock-tools" role="toolbar" aria-label="Point things out while recording">
          ${tools}
          <button type="button" data-action="live-spotlight" class="${this.liveOverlay?.isPicking || this.liveOverlay?.spotlight ? "reprorelay-tool-active" : ""}" aria-label="Spotlight an element" title="Spotlight an element">${targetIcon()}</button>
          <span class="reprorelay-dock-sep"></span>
          <button type="button" data-action="live-color" class="reprorelay-dock-color" aria-label="Change drawing colour" title="Change colour" style="--rr-live-color: ${this.liveColor}"><span></span></button>
          <span class="reprorelay-dock-sep"></span>
          <button type="button" data-action="live-undo" aria-label="Undo last drawing" title="Undo" ${this.liveOverlay?.annotationCount ? "" : "disabled"}>${undoIcon()}</button>
          <button type="button" data-action="live-clear" aria-label="Clear drawings" title="Clear" ${this.liveOverlay?.annotationCount || this.liveOverlay?.spotlight ? "" : "disabled"}>${closeIcon()}</button>
        </div>
      </div>
    `;
  }

  /** Syncs toolbar button states in place — never re-renders the dock. */
  private syncDockToolbar(): void {
    const container = this.root?.querySelector<HTMLDivElement>(".reprorelay-root");
    const overlay = this.liveOverlay;
    if (!container || !overlay) return;
    container.querySelectorAll<HTMLButtonElement>("[data-live-tool]").forEach((button) => {
      const active = overlay.tool === button.dataset.liveTool;
      button.classList.toggle("reprorelay-tool-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const spotlightButton = container.querySelector<HTMLButtonElement>('[data-action="live-spotlight"]');
    spotlightButton?.classList.toggle("reprorelay-tool-active", overlay.isPicking || Boolean(overlay.spotlight));
    const undoButton = container.querySelector<HTMLButtonElement>('[data-action="live-undo"]');
    if (undoButton) undoButton.disabled = overlay.annotationCount === 0;
    const clearButton = container.querySelector<HTMLButtonElement>('[data-action="live-clear"]');
    if (clearButton) clearButton.disabled = overlay.annotationCount === 0 && !overlay.spotlight;
  }

  private historyEntries(): ReportHistoryEntry[] {
    if (this.historySnapshot) return this.historySnapshot;
    try {
      return this.callbacks.listHistory?.() ?? [];
    } catch {
      return [];
    }
  }

  private openHistory(): void {
    this.phase = "history";
    this.historySnapshot = undefined;
    this.historyError = undefined;
    this.resolvedHistoryOpen = false;
    this.render();
    if (this.callbacks.refreshHistory) void this.refreshHistory();
  }

  private async refreshHistory(): Promise<void> {
    if (this.historyLoading || !this.callbacks.refreshHistory) return;
    this.historyLoading = true;
    this.historyError = undefined;
    this.render();
    try {
      this.historySnapshot = await this.callbacks.refreshHistory();
      this.historyLastCheckedAt = new Date().toISOString();
    } catch {
      this.historyError = "Couldn’t refresh just now. Showing the last status saved on this browser.";
    } finally {
      this.historyLoading = false;
      if (!this.destroyed && this.phase === "history") this.render();
    }
  }

  private historyTemplate(): string {
    const entries = sortHistoryBySubmission(this.historyEntries());
    const activeEntries = entries.filter((entry) => entry.status !== "closed");
    const resolvedEntries = entries.filter((entry) => entry.status === "closed");
    const shared = this.callbacks.historyScope === "project";
    const scopeLabel = shared ? "for your organisation" : "from this browser";
    const emptySummary = shared
      ? "Live progress for problems reported by your organisation."
      : "Live progress for problems sent from this browser.";
    const summary = entries.length
      ? `Live progress ${scopeLabel} · ${activeEntries.length} open · ${resolvedEntries.length} resolved.`
      : emptySummary;
    return `
      <div class="reprorelay-body reprorelay-history">
        <div class="reprorelay-history-head">
          <div class="reprorelay-intro">
            <h2>Your reports</h2>
            <p>${summary}</p>
          </div>
          ${this.callbacks.refreshHistory ? `
            <button type="button" class="reprorelay-refresh" data-action="refresh-history" ${this.historyLoading ? "disabled" : ""} aria-label="Refresh report statuses">
              ${refreshIcon()}<span>${this.historyLoading ? "Refreshing" : "Refresh"}</span>
            </button>
          ` : ""}
        </div>
        ${this.historyError ? `<div class="reprorelay-history-warning" role="status">${warningIcon()}<span>${escapeHtml(this.historyError)}</span></div>` : ""}
        ${entries.length ? `
          ${activeEntries.length ? `
            <div class="reprorelay-history-group-label"><span>Open reports</span><span>${activeEntries.length}</span></div>
            ${this.historyListTemplate(activeEntries)}
          ` : `
            <div class="reprorelay-history-cleared">
              <span>${checkIcon()}</span>
              <div><strong>No open reports</strong><p>${shared ? "Everything reported by your organisation has been resolved." : "Everything sent from this browser has been resolved."}</p></div>
            </div>
          `}
          ${resolvedEntries.length ? `
            <section class="reprorelay-resolved-section">
              <button
                type="button"
                class="reprorelay-resolved-toggle"
                data-action="toggle-resolved-history"
                aria-expanded="${this.resolvedHistoryOpen}"
                aria-controls="reprorelay-resolved-list"
              >
                <span>${checkIcon()} Resolved reports</span>
                <strong>${resolvedEntries.length}</strong>
                ${chevronIcon()}
              </button>
              ${this.resolvedHistoryOpen ? `<div id="reprorelay-resolved-list" class="reprorelay-resolved-list">${this.historyListTemplate(resolvedEntries)}</div>` : ""}
            </section>
          ` : ""}
        ` : `
          <div class="reprorelay-history-empty">
            <span>${historyIcon()}</span>
            <strong>${shared ? "No organisation reports yet" : "No reports from this browser yet"}</strong>
            <p>${shared ? "Problems your team sends will appear here with their latest progress." : "Problems you send will appear here with their latest progress."}</p>
            <button type="button" data-action="show-report">Report a problem</button>
          </div>
        `}
        <div class="reprorelay-history-foot">${lockIcon()} ${shared ? "Status is shared with signed-in members of your organisation." : "Status receipts stay private to this browser."}${this.historyLastCheckedAt ? ` Last checked ${formatHistoryDate(this.historyLastCheckedAt)}.` : ""}</div>
      </div>
    `;
  }

  private historyListTemplate(entries: ReportHistoryEntry[]): string {
    return `
      <ul class="reprorelay-history-list">
        ${entries.map((entry) => `
          <li class="reprorelay-history-row">
            <div class="reprorelay-history-title">
              <span class="reprorelay-history-sev" data-severity="${escapeHtml(entry.severity)}" data-status="${escapeHtml(entry.status)}"></span>
              <strong>${escapeHtml(entry.title)}</strong>
              <span class="reprorelay-history-status" data-status="${escapeHtml(entry.status)}">${historyStatusLabel(entry)}</span>
            </div>
            <div class="reprorelay-history-meta">
              <span>Submitted ${formatSubmissionDate(entry.createdAt)}</span>
              ${entry.hadVideo ? `<span>${videoIcon()} Screen recording</span>` : ""}
              ${entry.hadScreenshot ? `<span>${imageIcon()} Screenshot</span>` : ""}
            </div>
            ${historyProgressTemplate(entry)}
            <div class="reprorelay-history-update">
              <span class="${entry.seenAt ? "reprorelay-seen" : ""}">${entry.seenAt ? `${checkIcon()} Seen by our team ${formatHistoryDate(entry.seenAt)}` : "Waiting for our team to review it"}</span>
              <small>${entry.trackingToken ? `Updated ${formatHistoryDate(entry.updatedAt ?? entry.createdAt)}` : "Last known status"}</small>
            </div>
          </li>
        `).join("")}
      </ul>
    `;
  }

  private successTemplate(): string {
    return `
      <section class="reprorelay-panel reprorelay-success" role="status" aria-live="polite">
        <div class="reprorelay-success-mark">${checkIcon()}</div>
        <h2>Report sent</h2>
        <p>Thanks — your recording and technical context are on their way.</p>
      </section>
    `;
  }

  private errorTemplate(): string {
    return this.error ? `<div class="reprorelay-error" role="alert">${warningIcon()}<span>${escapeHtml(this.error)}</span></div>` : "";
  }

  private async startRecording(mode: RecordingMode): Promise<void> {
    if (this.recording || this.startingMode) return;
    this.startingMode = mode;
    this.error = undefined;
    this.render();

    try {
      const recording = await startScreenRecording({
        includeCamera: mode === "camera",
        includeMicrophone: this.options.enableMicrophone !== false,
        maxDurationMs: this.maxRecordingMs,
      });
      if (this.destroyed) {
        recording.discard();
        return;
      }

      this.recording = recording;
      this.startingMode = undefined;
      this.panelOpen = false;
      this.stopping = false;
      this.startLiveOverlay();
      this.startTimer();
      this.render();
      void recording.finished.then(
        (result) => this.acceptRecording(recording, result),
        (error: unknown) => this.failRecording(recording, error),
      );
    } catch (error) {
      this.startingMode = undefined;
      this.error = friendlyMediaError(error);
      this.render();
    }
  }

  private async stopRecording(): Promise<void> {
    const recording = this.recording;
    if (!recording || this.stopping) return;
    this.stopping = true;
    this.render();
    try {
      await recording.stop();
    } catch (error) {
      this.failRecording(recording, error);
    }
  }

  private startLiveOverlay(): void {
    if (!this.root || !this.host) return;
    this.stopLiveOverlay(false);
    this.liveOverlay = new LiveOverlay(this.root, this.host);
    this.liveOverlay.setColor(this.liveColor);
    this.liveOverlay.onSpotlightChange = (selection) => {
      this.spotlightMeta = selection;
      this.syncDockToolbar();
    };
    this.liveOverlay.onAnnotationsChange = () => this.syncDockToolbar();
  }

  /** Removes the drawing/spotlight layer; optionally keeps spotlight metadata for the report. */
  private stopLiveOverlay(keepSpotlightMeta = true): void {
    this.liveOverlay?.destroy();
    this.liveOverlay = undefined;
    if (!keepSpotlightMeta) this.spotlightMeta = undefined;
  }

  private acceptRecording(recording: ActiveScreenRecording, result: ScreenRecordingResult): void {
    if (this.destroyed || this.recording !== recording) return;
    this.recording = undefined;
    this.recorded = result;
    this.stopping = false;
    this.stopTimer();
    this.stopLiveOverlay();
    this.revokePreview();
    this.previewUrl = URL.createObjectURL(result.blob);
    this.panelOpen = true;
    this.enterForm();
  }

  private failRecording(recording: ActiveScreenRecording, error: unknown): void {
    if (this.destroyed || this.recording !== recording) return;
    this.recording = undefined;
    this.stopping = false;
    this.stopTimer();
    this.stopLiveOverlay(false);
    this.panelOpen = true;
    this.phase = "choose";
    this.error = friendlyMediaError(error);
    this.render();
  }

  private readDraft(form: HTMLFormElement): void {
    const formData = new FormData(form);
    this.draft = {
      title: String(formData.get("title") ?? ""),
      comment: String(formData.get("comment") ?? ""),
      severity: String(formData.get("severity") ?? "medium") as ReportDraft["severity"],
      reporterEmail: String(formData.get("reporterEmail") ?? this.draft.reporterEmail ?? ""),
    };
  }

  private async submitReport(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.error = undefined;
    this.render();

    try {
      await this.callbacks.onSubmit({
        title: this.draft.title,
        comment: this.draft.comment,
        severity: this.draft.severity,
        reporterEmail: this.draft.reporterEmail || undefined,
        recording: this.recorded,
        screenshot: this.resolveScreenshot(),
        spotlight: this.spotlightMeta,
      });
      this.submitting = false;
      this.recorded = undefined;
      this.spotlightMeta = undefined;
      this.previewOpen = false;
      this.revokePreview();
      this.resetScreenshot();
      this.draft = { title: "", comment: "", severity: "medium", reporterEmail: "" };
      this.phase = "success";
      this.render();
      this.successTimerId = window.setTimeout(() => {
        this.panelOpen = false;
        this.phase = "choose";
        this.render();
      }, 1800);
    } catch (error) {
      this.submitting = false;
      this.error = error instanceof Error ? error.message : "The report could not be sent. Please try again.";
      this.render();
    }
  }

  private startTimer(): void {
    this.stopTimer();
    // Update the elapsed-time label in place. Re-rendering the dock would
    // recreate its DOM every second, replaying the entry animation — the
    // indicator visibly "flies in" once per second.
    this.timerId = window.setInterval(() => this.updateRecordingTimer(), 1000);
  }

  private updateRecordingTimer(): void {
    if (!this.recording) return;
    const label = this.root?.querySelector<HTMLElement>(".reprorelay-recording-dock .reprorelay-recording-label small");
    if (label) label.textContent = formatDuration(Date.now() - this.recording.startedAt);
  }

  private stopTimer(): void {
    if (this.timerId !== undefined) window.clearInterval(this.timerId);
    this.timerId = undefined;
  }

  private revokePreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = undefined;
  }

  /** Enters the report form, kicking off a screenshot capture for annotation. */
  private enterForm(): void {
    this.phase = "form";
    this.error = undefined;
    this.render();
    this.ensureScreenshot();
    window.setTimeout(() => this.root?.querySelector<HTMLInputElement>('input[name="title"]')?.focus(), 0);
  }

  /** Captures the page once so the user can preview and annotate it. Best-effort. */
  private ensureScreenshot(): void {
    if (!this.callbacks.captureScreenshot || this.screenshotRemoved) return;
    if (this.screenshot || this.screenshotCapturing) return;

    this.screenshotCapturing = true;
    this.render();
    void this.callbacks.captureScreenshot().then(
      async (blob) => {
        if (this.destroyed) return;
        let image: HTMLImageElement | undefined;
        try {
          image = await loadImage(blob);
        } catch {
          // Keep the blob even if it can't be decoded here; the annotate view
          // re-derives dimensions from its own <img>.
        }
        if (this.destroyed) return;
        this.setScreenshot(blob, image);
        this.screenshotCapturing = false;
        this.render();
      },
      () => {
        if (this.destroyed) return;
        // Capture is best-effort — the report can still be sent without it.
        this.screenshotCapturing = false;
        this.render();
      },
    );
  }

  private setScreenshot(blob: Blob, image?: HTMLImageElement): void {
    this.revokeScreenshot();
    this.screenshot = {
      blob,
      url: URL.createObjectURL(blob),
      naturalWidth: image ? image.naturalWidth || image.width : 0,
      naturalHeight: image ? image.naturalHeight || image.height : 0,
      image,
    };
  }

  private revokeScreenshot(): void {
    if (this.screenshot) URL.revokeObjectURL(this.screenshot.url);
    this.screenshot = undefined;
    this.annotations = [];
    this.activeAnnotation = undefined;
    this.revokeAnnotated();
  }

  private revokeAnnotated(): void {
    if (this.annotatedUrl) URL.revokeObjectURL(this.annotatedUrl);
    this.annotatedUrl = undefined;
    this.annotatedBlob = undefined;
  }

  private resetScreenshot(): void {
    this.revokeScreenshot();
    this.screenshotCapturing = false;
    this.screenshotRemoved = false;
  }

  private openAnnotate(): void {
    if (!this.screenshot) return;
    this.annotateOpen = true;
    this.render();
    window.setTimeout(() => this.root?.querySelector<HTMLElement>('[data-action="annotate-close"]')?.focus(), 0);
  }

  private focusAnnotateButton(): void {
    window.setTimeout(() => this.root?.querySelector<HTMLElement>('[data-action="annotate"]')?.focus(), 0);
  }

  private bindAnnotateEvents(container: HTMLDivElement): void {
    container.querySelector<HTMLElement>('[data-action="annotate-close"]')?.addEventListener("click", () => this.closeAnnotate());
    container.querySelector<HTMLElement>('[data-action="annotate-done"]')?.addEventListener("click", () => {
      void this.finishAnnotate();
    });
    container.querySelector<HTMLElement>('[data-action="annotate-undo"]')?.addEventListener("click", () => {
      this.annotations.pop();
      this.render();
    });
    container.querySelector<HTMLElement>('[data-action="annotate-clear"]')?.addEventListener("click", () => {
      this.annotations = [];
      this.render();
    });

    container.querySelectorAll<HTMLElement>("[data-annotate-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        const tool = button.dataset.annotateTool;
        if (tool && (ANNOTATION_TOOLS as readonly string[]).includes(tool)) {
          this.tool = tool as AnnotationTool;
          this.render();
        }
      });
    });
    container.querySelectorAll<HTMLElement>("[data-annotate-color]").forEach((button) => {
      button.addEventListener("click", () => {
        const color = button.dataset.annotateColor;
        if (color) {
          this.annotationColor = color;
          this.render();
        }
      });
    });
    container.querySelectorAll<HTMLElement>("[data-annotate-width]").forEach((button) => {
      button.addEventListener("click", () => {
        this.strokeSize = button.dataset.annotateWidth === "l" ? "l" : "s";
        this.render();
      });
    });

    const canvas = container.querySelector<HTMLCanvasElement>("[data-annotate-canvas]");
    if (canvas) this.bindCanvasDrawing(canvas);

    // Redraw once layout has settled so the stage has real dimensions.
    window.requestAnimationFrame(() => {
      if (this.annotateOpen) this.redrawAnnotateCanvas();
    });
    this.redrawAnnotateCanvas();
  }

  /** Wires pointer drawing (mouse, touch, pen) onto the editor canvas. */
  private bindCanvasDrawing(canvas: HTMLCanvasElement): void {
    const shot = this.screenshot;
    if (!shot) return;

    const usePointer = typeof window.PointerEvent === "function";
    const moveEvent = usePointer ? "pointermove" : "mousemove";
    const upEvent = usePointer ? "pointerup" : "mouseup";
    const downEvent = usePointer ? "pointerdown" : "mousedown";

    canvas.addEventListener(downEvent, (event) => {
      const down = event as PointerEvent;
      if (down.button !== undefined && down.button !== 0) return;
      if (this.activeAnnotation) return; // ignore a second finger mid-stroke
      const naturalWidth = shot.naturalWidth || shot.image?.naturalWidth || 0;
      const naturalHeight = shot.naturalHeight || shot.image?.naturalHeight || 0;
      if (!naturalWidth || !naturalHeight) return;

      down.preventDefault();
      const natural = { width: naturalWidth, height: naturalHeight };
      const rect = canvas.getBoundingClientRect();
      const width = STROKE_SIZES[this.strokeSize] * naturalScale(rect.width, naturalWidth);
      const start = toNaturalPoint(down.clientX, down.clientY, rect, natural);
      this.activeAnnotation = this.tool === "pen"
        ? { tool: "pen", color: this.annotationColor, width, points: [start] }
        : { tool: this.tool, color: this.annotationColor, width, from: start, to: start };
      this.drawingPointerId = down.pointerId;

      const onMove = (raw: Event): void => {
        const active = this.activeAnnotation;
        if (!active) return;
        const move = raw as PointerEvent;
        const point = toNaturalPoint(move.clientX, move.clientY, canvas.getBoundingClientRect(), natural);
        if (active.tool === "pen") active.points.push(point);
        else active.to = point;
        this.redrawAnnotateCanvas();
      };
      const onUp = (): void => {
        window.removeEventListener(moveEvent, onMove);
        window.removeEventListener(upEvent, onUp);
        const active = this.activeAnnotation;
        this.activeAnnotation = undefined;
        this.drawingPointerId = undefined;
        if (active) this.commitAnnotation(active);
        this.render();
      };

      window.addEventListener(moveEvent, onMove);
      window.addEventListener(upEvent, onUp);
      this.redrawAnnotateCanvas();
    });
  }

  /** Keeps a finished stroke, discarding accidental taps for the shape tools. */
  private commitAnnotation(annotation: Annotation): void {
    if (annotation.tool === "pen") {
      if (annotation.points.length > 0) this.annotations.push(annotation);
    } else if (isMeaningfulShape(annotation.from, annotation.to)) {
      this.annotations.push(annotation);
    }
  }

  private closeAnnotate(): void {
    this.annotateOpen = false;
    this.activeAnnotation = undefined;
    this.render();
    this.focusAnnotateButton();
  }

  /** Flattens the annotations onto the screenshot and returns to the form. */
  private async finishAnnotate(): Promise<void> {
    const shot = this.screenshot;
    if (!shot || this.compositing) {
      this.closeAnnotate();
      return;
    }
    if (this.annotations.length === 0) {
      // Nothing drawn (or everything cleared) — drop any earlier composite.
      this.revokeAnnotated();
      this.closeAnnotate();
      return;
    }

    this.compositing = true;
    this.render();
    try {
      const blob = await compositeScreenshot(shot.blob, this.annotations);
      if (this.destroyed) return;
      this.revokeAnnotated();
      this.annotatedBlob = blob;
      this.annotatedUrl = URL.createObjectURL(blob);
    } catch {
      // Keep the plain screenshot if flattening fails; the markup is still
      // held in memory so the user can retry from the editor.
    } finally {
      if (!this.destroyed) {
        this.compositing = false;
        this.annotateOpen = false;
        this.activeAnnotation = undefined;
        this.render();
        this.focusAnnotateButton();
      }
    }
  }

  /** Draws the base screenshot plus every committed annotation onto the editor canvas. */
  private redrawAnnotateCanvas(): void {
    const canvas = this.root?.querySelector<HTMLCanvasElement>("[data-annotate-canvas]");
    const stage = this.root?.querySelector<HTMLElement>("[data-annotate-stage]");
    const shot = this.screenshot;
    if (!canvas || !stage || !shot) return;

    const image = shot.image;
    const naturalWidth = shot.naturalWidth || image?.naturalWidth || 0;
    const naturalHeight = shot.naturalHeight || image?.naturalHeight || 0;
    if (!image || naturalWidth === 0 || naturalHeight === 0) {
      // Base not decoded yet — decode then redraw.
      if (!image) void this.decodeBaseImage();
      return;
    }

    // Fit the image within the stage while preserving aspect ratio.
    const stageRect = stage.getBoundingClientRect();
    const maxWidth = stageRect.width || naturalWidth;
    const maxHeight = stageRect.height || naturalHeight;
    const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1) || 1;
    const displayWidth = Math.max(1, Math.round(naturalWidth * scale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * scale));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Map natural image coordinates onto the backing store.
    const s = canvas.width / naturalWidth;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, naturalWidth, naturalHeight);
    ctx.drawImage(image, 0, 0, naturalWidth, naturalHeight);
    drawAnnotations(ctx, this.annotations);
    if (this.activeAnnotation) drawAnnotation(ctx, this.activeAnnotation);
  }

  private async decodeBaseImage(): Promise<void> {
    const shot = this.screenshot;
    if (!shot || shot.image) return;
    try {
      const image = await loadImage(shot.blob);
      if (this.destroyed || this.screenshot !== shot) return;
      shot.image = image;
      shot.naturalWidth = image.naturalWidth || image.width;
      shot.naturalHeight = image.naturalHeight || image.height;
      if (this.annotateOpen) this.redrawAnnotateCanvas();
    } catch {
      // Leave the editor showing an empty stage; the report still sends.
    }
  }

  /** The screenshot to submit: annotated composite, plain capture, or none. */
  private resolveScreenshot(): Blob | null | undefined {
    if (this.annotatedBlob) return this.annotatedBlob;
    if (this.screenshot) return this.screenshot.blob;
    if (this.screenshotRemoved) return null;
    // Capture may still be running (or disabled) — let the client decide.
    return undefined;
  }

  private get maxRecordingMs(): number {
    return Math.max(5_000, this.options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS);
  }
}

function priorityOption(value: NonNullable<ReportDraft["severity"]>, label: string, selected?: ReportDraft["severity"]): string {
  return `
    <label class="reprorelay-priority-choice reprorelay-priority-${value}">
      <input type="radio" name="severity" value="${value}" ${value === selected ? "checked" : ""} />
      <span class="reprorelay-priority-option"><span class="reprorelay-priority-dot"></span>${label}</span>
    </label>
  `;
}

function safeLogoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("data:image/") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return value;
  try {
    const parsed = new URL(value, window.location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function friendlyMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Permission was not granted. Choose a screen and allow camera or microphone access to record.";
    if (error.name === "NotFoundError") return "No matching screen, camera, or microphone was found.";
    if (error.name === "NotReadableError") return "That screen or device is already in use, or the operating system blocked access.";
  }
  return error instanceof Error ? error.message : "Recording could not be started in this browser.";
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function readStoredShift(): number {
  try {
    // window.localStorage explicitly — Node exposes a non-functional bare global.
    const raw = window.localStorage.getItem(LAUNCHER_SHIFT_KEY);
    const parsed = Number(raw);
    return raw !== null && Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function persistShift(value: number): void {
  try {
    window.localStorage.setItem(LAUNCHER_SHIFT_KEY, String(Math.round(value)));
  } catch {
    // Best-effort persistence; the widget still works without it.
  }
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatSubmissionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sortHistoryBySubmission(entries: ReportHistoryEntry[]): ReportHistoryEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return right.createdAt.localeCompare(left.createdAt);
    return rightTime - leftTime;
  });
}

function historyStatusLabel(entry: ReportHistoryEntry): string {
  switch (entry.status) {
    case "triaged":
      return "Under review";
    case "github_created":
      return "Fix planned";
    case "agent_handoff":
      return "With engineering";
    case "closed":
      return "Resolved";
    default:
      return entry.seenAt ? "Seen" : "Received";
  }
}

function historyProgressTemplate(entry: ReportHistoryEntry): string {
  const labels = ["Received", "Seen", "Engineering", "Resolved"];
  const stage = reportProgressStage(entry);
  return `
    <div class="reprorelay-progress" aria-label="Progress: ${escapeHtml(historyStatusLabel(entry))}">
      ${labels.map((label, index) => `
        <span data-state="${index < stage ? "done" : index === stage ? "current" : "upcoming"}">
          <i>${index < stage ? checkIcon() : ""}</i><small>${label}</small>
        </span>
      `).join("")}
    </div>
  `;
}

function reportProgressStage(entry: ReportHistoryEntry): number {
  if (entry.status === "closed") return 3;
  if (entry.status === "github_created" || entry.status === "agent_handoff") return 2;
  if (entry.status === "triaged" || entry.seenAt) return 1;
  return 0;
}

function escapeHtml(value?: string): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(path: string, viewBox = "0 0 24 24"): string {
  return `<svg aria-hidden="true" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${path}</svg>`;
}

function closeIcon(): string {
  return icon('<path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
}

function screenIcon(): string {
  return icon('<rect x="3" y="4" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 21h7M12 17v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>');
}

function cameraIcon(): string {
  return icon('<rect x="3" y="6" width="13" height="12" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="m16 10 4.4-2.2c.3-.2.6.1.6.5v7.4c0 .4-.3.7-.6.5L16 14" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="9.5" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/>');
}

function videoIcon(): string {
  return icon('<rect x="3" y="6" width="13" height="12" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="m16 10 4.4-2.2c.3-.2.6.1.6.5v7.4c0 .4-.3.7-.6.5L16 14" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>');
}

function imageIcon(): string {
  return icon('<rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.6" stroke="currentColor" stroke-width="1.5"/><path d="m4 17 4.5-4.2a1.6 1.6 0 0 1 2.2 0L15 17m-1.5-2.6 1.6-1.5a1.6 1.6 0 0 1 2.2 0L20 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');
}

function penIcon(): string {
  return icon('<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2 4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m14 8 2.8 2.8" stroke="currentColor" stroke-width="1.6"/>');
}

function boxIcon(): string {
  return icon('<rect x="4.5" y="6" width="15" height="12" rx="1.5" stroke="currentColor" stroke-width="1.7"/>');
}

function highlightIcon(): string {
  return icon('<path d="M4 20h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M8 16.5 15.5 9l3 3-7.5 7.5H8v-3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m14 6.5 3 3" stroke="currentColor" stroke-width="1.6"/>');
}

function redactIcon(): string {
  return icon('<rect x="4" y="8.5" width="16" height="7" rx="1" fill="currentColor"/>');
}

function arrowIcon(): string {
  return icon('<path d="M5 19 19 5m0 0h-7m7 0v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
}

function undoIcon(): string {
  return icon('<path d="M9 8H6.5A3.5 3.5 0 0 0 3 11.5v0A3.5 3.5 0 0 0 6.5 15H12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m6.5 5-3 3 3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>', "0 0 20 20");
}

function annotationToolIcon(tool: AnnotationTool): string {
  switch (tool) {
    case "pen":
      return penIcon();
    case "box":
      return boxIcon();
    case "ellipse":
      return ellipseIcon();
    case "highlight":
      return highlightIcon();
    case "redact":
      return redactIcon();
    case "arrow":
      return arrowIcon();
  }
}

function ellipseIcon(): string {
  return icon('<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke="currentColor" stroke-width="1.8"/>');
}

function targetIcon(): string {
  return icon('<circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>');
}

function chevronIcon(): string {
  return icon('<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
}

function lockIcon(): string {
  return icon('<rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" stroke="currentColor" stroke-width="1.7"/>');
}

function historyIcon(): string {
  return icon('<path d="M12 8v4l2.5 2.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3M4.5 12H2m2.5 0 1.6 2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>');
}

function refreshIcon(): string {
  return icon('<path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.1 8.2A7 7 0 0 1 18.4 7L20 9M4 15l1.6 2A7 7 0 0 0 17.9 15.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>');
}

function paperclipIcon(): string {
  return icon('<path d="m8.5 12.5 5.9-5.9a3 3 0 0 1 4.2 4.2L11 18.4a5 5 0 0 1-7.1-7.1l7.4-7.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m7.1 14 7.1-7.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>');
}

function checkIcon(): string {
  return icon('<path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
}

function sendIcon(): string {
  return icon('<path d="m4 4 17 8-17 8 3-8-3-8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 12h14" stroke="currentColor" stroke-width="1.7"/>');
}

function warningIcon(): string {
  return icon('<path d="M12 3.5 21 20H3L12 3.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 9v5M12 17.2v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>');
}

const WIDGET_STYLES = `
  :host {
    --rr-accent: #ff4f14;
    --rr-accent-dark: #d83c08;
    --rr-ink: #171a18;
    --rr-muted: #677068;
    --rr-border: #e3e6e1;
    --rr-surface: #ffffff;
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    pointer-events: none;
    color-scheme: light;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, textarea, select { font: inherit; }
  button { -webkit-tap-highlight-color: transparent; }
  svg { display: block; width: 20px; height: 20px; }
  .reprorelay-root {
    color: var(--rr-ink);
    font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .reprorelay-launcher {
    position: fixed;
    right: 0;
    top: calc(50% + var(--rr-shift, 0px));
    width: 60px;
    height: 62px;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    border: 1px solid var(--rr-border);
    border-right: 0;
    border-radius: 18px 0 0 18px;
    background: #fff;
    box-shadow: 0 14px 38px rgba(20, 28, 22, .18);
    cursor: pointer;
    pointer-events: auto;
    transition: width .18s ease, box-shadow .18s ease, transform .18s ease;
    overflow: hidden;
  }
  .reprorelay-launcher:hover {
    width: 64px;
    box-shadow: 0 16px 44px rgba(20, 28, 22, .24);
  }
  .reprorelay-launcher[aria-expanded="true"] {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
  }
  .reprorelay-launcher:focus-visible,
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--rr-accent) 28%, transparent);
    outline-offset: 2px;
  }
  .reprorelay-launcher img { width: 48px; height: 48px; object-fit: contain; }
  .reprorelay-launcher span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  :host([data-position^="left"]) .reprorelay-launcher {
    right: auto;
    left: 0;
    border-right: 1px solid var(--rr-border);
    border-left: 0;
    border-radius: 0 18px 18px 0;
  }
  :host([data-position$="bottom"]) .reprorelay-launcher {
    top: auto;
    bottom: calc(18px - var(--rr-shift, 0px));
    transform: none;
  }
  .reprorelay-launcher { touch-action: none; }
  :host(.reprorelay-dragging) .reprorelay-launcher {
    transition: none;
    cursor: grabbing;
  }
  .reprorelay-panel {
    position: fixed;
    right: 18px;
    top: calc(50% + var(--rr-panel-shift, 0px));
    width: min(400px, calc(100vw - 28px));
    max-height: calc(100vh - 36px);
    transform: translateY(-50%);
    overflow: auto;
    border: 1px solid var(--rr-border);
    border-radius: 18px;
    background: var(--rr-surface);
    box-shadow: 0 24px 80px rgba(17, 24, 19, .22);
    pointer-events: auto;
    animation: reprorelay-enter .18s ease-out;
  }
  :host([data-position^="left"]) .reprorelay-panel { right: auto; left: 18px; }
  :host([data-position$="bottom"]) .reprorelay-panel { top: auto; bottom: 92px; transform: none; }
  .reprorelay-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 68px;
    padding: 12px 14px 12px 18px;
    border-bottom: 1px solid var(--rr-border);
    background: rgba(255, 255, 255, .96);
    backdrop-filter: blur(12px);
  }
  .reprorelay-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .reprorelay-brand img { width: 38px; height: 38px; object-fit: contain; flex: none; }
  .reprorelay-brand div { display: grid; gap: 1px; }
  .reprorelay-brand strong { font-size: 14px; line-height: 1.2; letter-spacing: -.01em; }
  .reprorelay-brand span { color: var(--rr-muted); font-size: 11px; }
  .reprorelay-header-tools { display: flex; align-items: center; gap: 8px; flex: none; }
  .reprorelay-attribution { display: flex; align-items: center; gap: 6px; color: #7a827b; font-size: 9px; font-weight: 700; letter-spacing: .02em; }
  .reprorelay-attribution-mark {
    width: 52px;
    height: 34px;
    display: grid;
    place-items: center;
    overflow: hidden;
    border: 1px solid #303630;
    border-radius: 9px;
    background: #171b18;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
  }
  .reprorelay-attribution-mark img { width: 42px; height: 32px; display: block; object-fit: contain; }
  .reprorelay-icon-button {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: #5f6861;
    cursor: pointer;
  }
  .reprorelay-icon-button:hover { background: #f4f5f3; color: var(--rr-ink); }
  .reprorelay-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0 18px;
    border-bottom: 1px solid var(--rr-border);
    background: #fff;
  }
  .reprorelay-tabs button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 45px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: #737b74;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .reprorelay-tabs button::after { content: ""; position: absolute; right: 10px; bottom: -1px; left: 10px; height: 2px; border-radius: 2px 2px 0 0; background: transparent; }
  .reprorelay-tabs button:hover { color: var(--rr-ink); }
  .reprorelay-tabs .reprorelay-tab-active { color: var(--rr-ink); }
  .reprorelay-tabs .reprorelay-tab-active::after { background: var(--rr-accent); }
  .reprorelay-tabs button span { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #f0f2ef; color: #505951; font-size: 10px; }
  .reprorelay-body { padding: 22px; }
  .reprorelay-intro { margin-bottom: 20px; }
  .reprorelay-intro h2,
  .reprorelay-success h2 { margin: 0; color: var(--rr-ink); font-size: 22px; line-height: 1.2; letter-spacing: -.025em; }
  .reprorelay-intro p,
  .reprorelay-success p { margin: 7px 0 0; color: var(--rr-muted); font-size: 13px; line-height: 1.55; }
  .reprorelay-capture-options { display: grid; gap: 10px; }
  .reprorelay-capture-option {
    width: 100%;
    display: grid;
    grid-template-columns: 42px 1fr 20px;
    align-items: center;
    gap: 12px;
    min-height: 72px;
    padding: 13px;
    border: 1px solid var(--rr-border);
    border-radius: 13px;
    background: #fff;
    color: var(--rr-ink);
    text-align: left;
    cursor: pointer;
    transition: border-color .16s ease, background .16s ease, transform .16s ease;
  }
  .reprorelay-capture-option:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--rr-accent) 55%, var(--rr-border));
    background: color-mix(in srgb, var(--rr-accent) 4%, white);
    transform: translateY(-1px);
  }
  .reprorelay-capture-option:disabled { cursor: wait; opacity: .58; }
  .reprorelay-capture-option > span:nth-child(2) { display: grid; gap: 2px; }
  .reprorelay-capture-option strong { font-size: 14px; line-height: 1.25; }
  .reprorelay-capture-option small { color: var(--rr-muted); font-size: 12px; line-height: 1.35; }
  .reprorelay-capture-option > svg { width: 18px; color: #909891; }
  .reprorelay-option-icon {
    display: grid !important;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--rr-accent) 10%, white);
    color: var(--rr-accent-dark);
  }
  .reprorelay-text-button,
  .reprorelay-add-recording {
    width: 100%;
    border: 0;
    background: transparent;
    color: #505950;
    cursor: pointer;
  }
  .reprorelay-text-button { margin-top: 14px; padding: 9px; font-size: 12px; font-weight: 650; }
  .reprorelay-history { padding: 20px; background: #fafbf9; }
  .reprorelay-history-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  .reprorelay-history-head .reprorelay-intro { margin: 0; }
  .reprorelay-history-head .reprorelay-intro h2 { font-size: 20px; }
  .reprorelay-refresh { display: inline-flex; align-items: center; gap: 5px; min-height: 32px; padding: 0 9px; border: 1px solid var(--rr-border); border-radius: 9px; background: #fff; color: #5d665f; font-size: 11px; font-weight: 700; cursor: pointer; }
  .reprorelay-refresh:hover:not(:disabled) { border-color: #cbd0ca; color: var(--rr-ink); }
  .reprorelay-refresh:disabled { opacity: .62; cursor: wait; }
  .reprorelay-refresh svg { width: 14px; height: 14px; }
  .reprorelay-refresh:disabled svg { animation: reprorelay-spin .7s linear infinite; }
  .reprorelay-history-warning { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 12px; padding: 10px 11px; border: 1px solid #f0d7b7; border-radius: 10px; background: #fff9ef; color: #815925; font-size: 11px; line-height: 1.4; }
  .reprorelay-history-warning svg { width: 15px; height: 15px; flex: none; margin-top: 1px; }
  .reprorelay-history-group-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 2px 8px; color: #646d66; font-size: 10px; font-weight: 760; letter-spacing: .02em; text-transform: uppercase; }
  .reprorelay-history-group-label span:last-child { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: #e9ece8; color: #626b64; font-size: 10px; letter-spacing: 0; }
  .reprorelay-history-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .reprorelay-history-row { display: grid; gap: 11px; padding: 14px; border: 1px solid var(--rr-border); border-radius: 13px; background: #fff; box-shadow: 0 3px 12px rgba(31, 42, 34, .035); }
  .reprorelay-history-title { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; }
  .reprorelay-history-title strong { display: -webkit-box; overflow: hidden; color: var(--rr-ink); font-size: 13px; font-weight: 730; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .reprorelay-history-sev { width: 8px; height: 8px; border-radius: 50%; background: #b08a2e; }
  .reprorelay-history-sev[data-severity="critical"] { background: #c8324a; }
  .reprorelay-history-sev[data-severity="high"] { background: #cc6a1c; }
  .reprorelay-history-sev[data-severity="low"] { background: #4b8f63; }
  .reprorelay-history-sev[data-status="closed"] { background: #3f8a50; }
  .reprorelay-history-status { flex: none; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--rr-border); background: #f6f7f5; color: var(--rr-muted); font-size: 10px; font-weight: 720; white-space: nowrap; }
  .reprorelay-history-status[data-status="closed"] { border-color: #bfdcc4; background: #e9f5e9; color: #27752e; }
  .reprorelay-history-status[data-status="github_created"],
  .reprorelay-history-status[data-status="agent_handoff"] { border-color: #c7d8ea; background: #eef4fb; color: #33638f; }
  .reprorelay-history-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; color: #7a827b; font-size: 10.5px; }
  .reprorelay-history-meta span { display: inline-flex; align-items: center; gap: 4px; }
  .reprorelay-history-meta svg { width: 12px; height: 12px; }
  .reprorelay-progress { display: grid; grid-template-columns: repeat(4, 1fr); padding: 2px 0 0; }
  .reprorelay-progress > span { position: relative; display: grid; justify-items: center; gap: 4px; min-width: 0; color: #9ba19c; }
  .reprorelay-progress > span::before { content: ""; position: absolute; z-index: 0; top: 6px; right: 50%; left: -50%; height: 1px; background: #e0e4df; }
  .reprorelay-progress > span:first-child::before { display: none; }
  .reprorelay-progress i { position: relative; z-index: 1; display: grid; place-items: center; width: 13px; height: 13px; border: 2px solid #d7dcd6; border-radius: 50%; background: #fff; }
  .reprorelay-progress i svg { width: 8px; height: 8px; }
  .reprorelay-progress small { overflow: hidden; max-width: 100%; font-size: 8.5px; font-style: normal; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .reprorelay-progress > span[data-state="done"]::before,
  .reprorelay-progress > span[data-state="current"]::before { background: color-mix(in srgb, var(--rr-accent) 48%, #dfe3de); }
  .reprorelay-progress > span[data-state="done"] { color: #657068; }
  .reprorelay-progress > span[data-state="done"] i { border-color: var(--rr-accent); background: var(--rr-accent); color: #fff; }
  .reprorelay-progress > span[data-state="current"] { color: var(--rr-ink); }
  .reprorelay-progress > span[data-state="current"] i { border-color: var(--rr-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rr-accent) 12%, transparent); }
  .reprorelay-history-update { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 10px; border-top: 1px solid #edf0ec; color: #8a918b; font-size: 10px; }
  .reprorelay-history-update > span { display: inline-flex; align-items: center; gap: 4px; }
  .reprorelay-history-update > span svg { width: 12px; height: 12px; }
  .reprorelay-history-update .reprorelay-seen { color: #397348; font-weight: 680; }
  .reprorelay-history-update small { flex: none; font-size: 9.5px; }
  .reprorelay-history-cleared { display: flex; align-items: center; gap: 11px; padding: 13px 14px; border: 1px solid #cfe2d1; border-radius: 12px; background: #f2f8f2; color: #397348; }
  .reprorelay-history-cleared > span { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 50%; background: #dfeee0; }
  .reprorelay-history-cleared > span svg { width: 15px; height: 15px; }
  .reprorelay-history-cleared strong { display: block; color: #285f36; font-size: 12px; }
  .reprorelay-history-cleared p { margin: 2px 0 0; color: #5f7664; font-size: 10px; line-height: 1.35; }
  .reprorelay-resolved-section { margin-top: 12px; }
  .reprorelay-resolved-toggle { display: grid; grid-template-columns: minmax(0, 1fr) auto 15px; align-items: center; gap: 9px; width: 100%; min-height: 42px; padding: 0 12px; border: 1px solid #dfe3de; border-radius: 11px; background: #fff; color: #5d675f; cursor: pointer; text-align: left; }
  .reprorelay-resolved-toggle:hover { border-color: #cbd2ca; color: var(--rr-ink); }
  .reprorelay-resolved-toggle > span { display: inline-flex; align-items: center; gap: 7px; min-width: 0; font-size: 11px; font-weight: 720; }
  .reprorelay-resolved-toggle > span svg { width: 14px; height: 14px; color: #397348; }
  .reprorelay-resolved-toggle > strong { display: grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: #edf1ec; color: #657068; font-size: 10px; }
  .reprorelay-resolved-toggle > svg { width: 15px; height: 15px; transition: transform .16s ease; }
  .reprorelay-resolved-toggle[aria-expanded="true"] > svg { transform: rotate(90deg); }
  .reprorelay-resolved-list { margin-top: 10px; }
  .reprorelay-history-empty { display: grid; justify-items: center; padding: 30px 16px 26px; border: 1px dashed #d7dbd6; border-radius: 13px; background: #fff; text-align: center; }
  .reprorelay-history-empty > span { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 12px; border-radius: 50%; background: #f1f3f0; color: #707971; }
  .reprorelay-history-empty > span svg { width: 21px; height: 21px; }
  .reprorelay-history-empty strong { font-size: 13px; }
  .reprorelay-history-empty p { max-width: 250px; margin: 5px 0 14px; color: var(--rr-muted); font-size: 11px; line-height: 1.45; }
  .reprorelay-history-empty button { border: 0; border-radius: 9px; background: var(--rr-accent); color: #fff; min-height: 34px; padding: 0 13px; font-size: 11px; font-weight: 720; cursor: pointer; }
  .reprorelay-history-foot { display: flex; align-items: flex-start; gap: 6px; margin-top: 13px; color: #858d86; font-size: 9.5px; line-height: 1.4; }
  .reprorelay-history-foot svg { width: 12px; height: 12px; flex: none; margin-top: 1px; }
  .reprorelay-text-button:hover { color: var(--rr-accent-dark); }
  .reprorelay-privacy,
  .reprorelay-evidence-note {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    color: #747c75;
    font-size: 11px;
    line-height: 1.45;
  }
  .reprorelay-privacy { margin-top: 15px; padding-top: 15px; border-top: 1px solid #eef0ed; }
  .reprorelay-privacy svg,
  .reprorelay-evidence-note svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
  .reprorelay-permission,
  .reprorelay-error {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin: 12px 0;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 12px;
  }
  .reprorelay-permission { justify-content: center; color: #5e675f; background: #f5f6f4; }
  .reprorelay-error { border: 1px solid #f0c8b8; background: #fff6f1; color: #9d3513; }
  .reprorelay-error svg { width: 17px; height: 17px; flex: none; }
  .reprorelay-form { display: block; }
  .reprorelay-form-body { display: grid; gap: 15px; }
  .reprorelay-form-intro { margin-bottom: 1px; }
  .reprorelay-field { display: grid; gap: 6px; color: #4c554e; font-size: 12px; font-weight: 680; }
  .reprorelay-field input,
  .reprorelay-field textarea,
  .reprorelay-field select {
    width: 100%;
    border: 1px solid #d5dad4;
    border-radius: 10px;
    background: #fff;
    color: var(--rr-ink);
    font-size: 14px;
    font-weight: 450;
    line-height: 1.45;
    padding: 10px 11px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .reprorelay-field input,
  .reprorelay-field select { min-height: 42px; }
  .reprorelay-field textarea { resize: vertical; min-height: 104px; }
  .reprorelay-field input:focus,
  .reprorelay-field textarea:focus,
  .reprorelay-field select:focus {
    border-color: var(--rr-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--rr-accent) 12%, transparent);
    outline: 0;
  }
  .reprorelay-field input::placeholder,
  .reprorelay-field textarea::placeholder { color: #9ba19c; }
  .reprorelay-priority { min-width: 0; margin: 0; padding: 0; border: 0; }
  .reprorelay-priority legend { padding: 0; color: #4c554e; font-size: 12px; font-weight: 680; }
  .reprorelay-priority-help { display: block; margin-top: 2px; color: #7b837d; font-size: 10.5px; font-weight: 500; }
  .reprorelay-priority-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
  .reprorelay-priority-choice { position: relative; display: block; min-width: 0; --rr-priority: #6b7280; }
  .reprorelay-priority-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .reprorelay-priority-option {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 6px;
    border: 1px solid #dfe3de;
    border-radius: 9px;
    background: #fff;
    color: #5c645e;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: border-color .15s ease, background .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  .reprorelay-priority-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--rr-priority); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rr-priority) 12%, transparent); }
  .reprorelay-priority-low { --rr-priority: #6b7280; }
  .reprorelay-priority-medium { --rr-priority: #3975d4; }
  .reprorelay-priority-high { --rr-priority: #d97706; }
  .reprorelay-priority-critical { --rr-priority: #d43838; }
  .reprorelay-priority-choice input:checked + .reprorelay-priority-option {
    border-color: var(--rr-priority);
    background: color-mix(in srgb, var(--rr-priority) 8%, white);
    color: color-mix(in srgb, var(--rr-priority) 78%, #111);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--rr-priority) 10%, transparent);
  }
  .reprorelay-priority-choice input:focus-visible + .reprorelay-priority-option { outline: 3px solid color-mix(in srgb, var(--rr-priority) 22%, transparent); outline-offset: 2px; }
  .reprorelay-priority-choice:hover .reprorelay-priority-option { transform: translateY(-1px); border-color: var(--rr-priority); }
  .reprorelay-add-recording {
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px dashed #cdd3cc;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 680;
  }
  .reprorelay-add-recording:hover { border-color: var(--rr-accent); color: var(--rr-accent-dark); background: #fff9f6; }
  .reprorelay-add-recording svg { width: 17px; height: 17px; }
  .reprorelay-recording-card { padding: 12px; border: 1px solid #dfe5dc; border-radius: 12px; background: #f8faf7; }
  .reprorelay-recording-meta { display: flex; align-items: center; gap: 10px; }
  .reprorelay-recording-meta > div { display: grid; gap: 1px; min-width: 0; }
  .reprorelay-recording-meta strong { font-size: 13px; }
  .reprorelay-recording-meta small { color: var(--rr-muted); font-size: 11px; text-transform: capitalize; }
  .reprorelay-recording-check { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #e9f5e9; color: #27752e; }
  .reprorelay-recording-check svg { width: 16px; height: 16px; }
  .reprorelay-recording-actions { display: flex; gap: 14px; margin: 10px 0 0 40px; }
  .reprorelay-recording-actions button { padding: 0; border: 0; background: transparent; color: #5a635b; font-size: 11px; font-weight: 680; cursor: pointer; }
  .reprorelay-recording-actions button:hover { color: var(--rr-accent-dark); }
  .reprorelay-preview { width: 100%; display: block; margin-top: 12px; border-radius: 9px; background: #161816; aspect-ratio: 16/9; }
  .reprorelay-shot-card { display: flex; gap: 12px; padding: 10px; border: 1px solid #dfe5dc; border-radius: 12px; background: #f8faf7; }
  .reprorelay-shot-loading { align-items: center; justify-content: center; min-height: 64px; color: var(--rr-muted); font-size: 12px; font-weight: 600; }
  .reprorelay-shot-preview { position: relative; flex: none; width: 92px; height: 66px; border-radius: 8px; overflow: hidden; border: 1px solid var(--rr-border); background: #161816; }
  .reprorelay-shot-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .reprorelay-shot-badge { position: absolute; left: 4px; bottom: 4px; display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 999px; background: rgba(23,26,24,.82); color: #fff; font-size: 9.5px; font-weight: 700; }
  .reprorelay-shot-badge svg { width: 11px; height: 11px; }
  .reprorelay-shot-body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
  .reprorelay-shot-copy { display: grid; gap: 2px; }
  .reprorelay-shot-copy strong { font-size: 13px; }
  .reprorelay-shot-copy small { color: var(--rr-muted); font-size: 11.5px; line-height: 1.4; }
  .reprorelay-shot-actions { display: flex; gap: 8px; }
  .reprorelay-shot-actions button { min-height: 32px; padding: 0 12px; border: 1px solid #d8ddd7; border-radius: 8px; background: #fff; color: #4d554f; font-size: 12px; font-weight: 680; cursor: pointer; }
  .reprorelay-shot-actions button:hover:not(:disabled) { border-color: var(--rr-accent); color: var(--rr-accent-dark); background: #fff9f6; }
  .reprorelay-shot-annotate { border-color: var(--rr-accent) !important; background: var(--rr-accent) !important; color: #fff !important; }
  .reprorelay-shot-annotate:hover:not(:disabled) { background: var(--rr-accent-dark) !important; }
  .reprorelay-shot-annotate svg { width: 14px; height: 14px; }
  .reprorelay-annotate {
    position: fixed;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(12, 15, 12, .58);
    backdrop-filter: blur(4px);
    pointer-events: auto;
    animation: reprorelay-fade .16s ease-out;
  }
  .reprorelay-annotate-card {
    display: flex;
    flex-direction: column;
    width: min(940px, 100%);
    max-height: calc(100vh - 32px);
    overflow: hidden;
    border-radius: 16px;
    background: var(--rr-surface);
    box-shadow: 0 30px 90px rgba(8, 12, 9, .5);
  }
  .reprorelay-annotate-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 12px 18px;
    border-bottom: 1px solid var(--rr-border);
  }
  .reprorelay-annotate-head strong { font-size: 14px; letter-spacing: -.01em; }
  .reprorelay-annotate-stage {
    flex: 1;
    min-height: 200px;
    display: grid;
    place-items: center;
    padding: 16px;
    overflow: auto;
    background: repeating-conic-gradient(#eef0ec 0% 25%, #f7f8f5 0% 50%) 50% / 20px 20px;
  }
  .reprorelay-annotate-canvas {
    display: block;
    max-width: 100%;
    border-radius: 6px;
    box-shadow: 0 6px 22px rgba(10, 15, 11, .28);
    touch-action: none;
    cursor: crosshair;
  }
  .reprorelay-annotate-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid var(--rr-border);
    background: #fbfcfa;
  }
  .reprorelay-tool-group { display: flex; align-items: center; gap: 5px; padding: 4px; border: 1px solid var(--rr-border); border-radius: 11px; background: #fff; }
  .reprorelay-tool {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #4c554e;
    cursor: pointer;
    transition: background .14s ease, color .14s ease, border-color .14s ease;
  }
  .reprorelay-tool svg { width: 18px; height: 18px; }
  .reprorelay-tool:hover:not(:disabled) { background: #f2f4f1; color: var(--rr-ink); }
  .reprorelay-tool-active,
  .reprorelay-tool-active:hover:not(:disabled) {
    border-color: var(--rr-accent);
    background: color-mix(in srgb, var(--rr-accent) 12%, white);
    color: var(--rr-accent-dark);
  }
  .reprorelay-swatch {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--rr-swatch);
    box-shadow: 0 0 0 1px var(--rr-border);
    cursor: pointer;
  }
  .reprorelay-swatch-active { box-shadow: 0 0 0 2px var(--rr-swatch); }
  .reprorelay-width {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
  }
  .reprorelay-width span { display: block; border-radius: 50%; background: #3a423c; }
  .reprorelay-width-s span { width: 6px; height: 6px; }
  .reprorelay-width-l span { width: 12px; height: 12px; }
  .reprorelay-width:hover:not(:disabled) { background: #f2f4f1; }
  .reprorelay-width-active { border-color: var(--rr-accent); background: color-mix(in srgb, var(--rr-accent) 12%, white); }
  .reprorelay-tool-spacer { flex: 1 1 auto; }
  .reprorelay-tool-text {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--rr-border);
    border-radius: 9px;
    background: #fff;
    color: #4d554f;
    font-size: 12px;
    font-weight: 680;
    cursor: pointer;
  }
  .reprorelay-tool-text svg { width: 15px; height: 15px; }
  .reprorelay-tool-text:hover:not(:disabled) { border-color: var(--rr-accent); color: var(--rr-accent-dark); }
  .reprorelay-annotate-done {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    padding: 0 16px;
    border: 1px solid var(--rr-accent);
    border-radius: 10px;
    background: var(--rr-accent);
    color: #fff;
    font-size: 13px;
    font-weight: 720;
    cursor: pointer;
    box-shadow: 0 5px 14px color-mix(in srgb, var(--rr-accent) 22%, transparent);
  }
  .reprorelay-annotate-done svg { width: 16px; height: 16px; }
  .reprorelay-annotate-done:hover:not(:disabled) { background: var(--rr-accent-dark); border-color: var(--rr-accent-dark); }
  .reprorelay-evidence-note { padding: 10px 11px; border-radius: 9px; background: #f6f7f5; }
  .reprorelay-footer {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 22px;
    border-top: 1px solid var(--rr-border);
    background: #fbfcfa;
  }
  .reprorelay-primary,
  .reprorelay-secondary {
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-radius: 10px;
    padding: 0 14px;
    font-size: 13px;
    font-weight: 720;
    cursor: pointer;
  }
  .reprorelay-primary { border: 1px solid var(--rr-accent); background: var(--rr-accent); color: #fff; box-shadow: 0 5px 14px color-mix(in srgb, var(--rr-accent) 22%, transparent); }
  .reprorelay-primary:hover:not(:disabled) { background: var(--rr-accent-dark); border-color: var(--rr-accent-dark); }
  .reprorelay-primary svg { width: 16px; height: 16px; }
  .reprorelay-secondary { border: 1px solid #d8ddd7; background: #fff; color: #4d554f; }
  .reprorelay-secondary:hover:not(:disabled) { background: #f3f5f2; color: var(--rr-ink); }
  button:disabled, input:disabled, textarea:disabled, select:disabled { cursor: wait; opacity: .62; }
  .reprorelay-recording-dock {
    position: fixed;
    right: 16px;
    top: calc(50% + var(--rr-shift, 0px));
    transform: translateY(-50%);
    min-width: 238px;
    display: grid;
    gap: 9px;
    padding: 10px 10px 10px 15px;
    border: 1px solid #e0e3df;
    border-radius: 15px;
    background: #fff;
    box-shadow: 0 16px 50px rgba(15, 22, 17, .22);
    pointer-events: auto;
    z-index: 2;
    animation: reprorelay-enter .18s ease-out;
  }
  :host([data-position^="left"]) .reprorelay-recording-dock { right: auto; left: 16px; }
  :host([data-position$="bottom"]) .reprorelay-recording-dock { top: auto; bottom: 18px; transform: none; }
  .reprorelay-dock-row { min-height: 38px; display: grid; grid-template-columns: 12px 1fr auto; align-items: center; gap: 11px; }
  .reprorelay-live-dot { width: 10px; height: 10px; border-radius: 50%; background: #e13232; box-shadow: 0 0 0 5px rgba(225, 50, 50, .12); animation: reprorelay-pulse 1.5s ease-in-out infinite; }
  .reprorelay-recording-label { display: grid; gap: 1px; }
  .reprorelay-recording-label strong { font-size: 12px; }
  .reprorelay-recording-label small { color: var(--rr-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .reprorelay-dock-row button { min-height: 36px; display: inline-flex; align-items: center; gap: 7px; padding: 0 11px; border: 1px solid #e1a7a7; border-radius: 9px; background: #fff5f5; color: #a62424; font-size: 12px; font-weight: 720; cursor: pointer; }
  .reprorelay-stop-square { width: 9px; height: 9px; border-radius: 2px; background: #d52d2d; }
  .reprorelay-dock-tools { display: flex; align-items: center; gap: 5px; padding-top: 9px; border-top: 1px solid #edf0ec; }
  .reprorelay-dock-tools button { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #5a625c; cursor: pointer; }
  .reprorelay-dock-tools button:hover { background: #f3f5f2; color: var(--rr-ink); }
  .reprorelay-dock-tools button svg { width: 16px; height: 16px; }
  .reprorelay-dock-tools button.reprorelay-tool-active { border-color: var(--rr-accent); background: color-mix(in srgb, var(--rr-accent) 10%, #fff); color: var(--rr-accent); }
  .reprorelay-dock-tools button:disabled { opacity: .4; cursor: default; }
  .reprorelay-dock-sep { width: 1px; height: 18px; margin: 0 3px; background: #e4e7e2; }
  .reprorelay-dock-color span { width: 14px; height: 14px; border-radius: 50%; background: var(--rr-live-color, #ff4f14); box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
  /* Below the dock (z-index 2) so toolbar buttons stay clickable while a tool is armed. */
  .reprorelay-live-layer { position: fixed; inset: 0; pointer-events: none; z-index: 1; }
  .reprorelay-live-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; }
  .reprorelay-live-canvas.reprorelay-live-active { pointer-events: auto; cursor: crosshair; }
  .reprorelay-live-canvas.reprorelay-live-picking { cursor: pointer; }
  .reprorelay-spotlight-hover { position: fixed; border: 2px dashed var(--rr-accent); border-radius: 6px; pointer-events: none; }
  .reprorelay-spotlight-ring {
    position: fixed;
    border: 3px solid var(--rr-accent);
    border-radius: 8px;
    box-shadow: 0 0 0 9999px rgba(15, 20, 16, .40), 0 0 0 5px color-mix(in srgb, var(--rr-accent) 35%, transparent);
    pointer-events: none;
  }
  .reprorelay-success { min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 28px; text-align: center; }
  .reprorelay-success-mark { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 16px; border-radius: 50%; background: #e9f5e9; color: #27752e; }
  .reprorelay-success-mark svg { width: 28px; height: 28px; }
  .reprorelay-spinner { width: 15px; height: 15px; flex: none; border: 2px solid #cfd4ce; border-top-color: var(--rr-accent); border-radius: 50%; animation: reprorelay-spin .7s linear infinite; }
  .reprorelay-spinner-light { border-color: rgba(255,255,255,.42); border-top-color: #fff; }
  @keyframes reprorelay-enter { from { opacity: 0; transform: translateY(calc(-50% + 8px)) scale(.985); } to { opacity: 1; transform: translateY(-50%) scale(1); } }
  @keyframes reprorelay-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes reprorelay-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  @keyframes reprorelay-spin { to { transform: rotate(360deg); } }
  @media (max-width: 520px) {
    .reprorelay-launcher,
    :host([data-position^="left"]) .reprorelay-launcher { top: auto; right: 0; bottom: calc(22% - var(--rr-shift, 0px)); left: auto; transform: none; }
    .reprorelay-panel,
    :host([data-position^="left"]) .reprorelay-panel,
    :host([data-position$="bottom"]) .reprorelay-panel {
      top: auto;
      right: 8px;
      bottom: 8px;
      left: 8px;
      width: auto;
      max-height: calc(100vh - 16px);
      transform: none;
      border-radius: 18px;
    }
    .reprorelay-recording-dock,
    :host([data-position^="left"]) .reprorelay-recording-dock,
    :host([data-position$="bottom"]) .reprorelay-recording-dock {
      top: auto;
      right: 10px;
      bottom: 10px;
      left: 10px;
      transform: none;
    }
    .reprorelay-body { padding: 18px; }
    .reprorelay-footer { padding: 13px 18px; }
    .reprorelay-annotate { padding: 0; }
    .reprorelay-annotate-card { width: 100%; height: 100%; max-height: 100vh; border-radius: 0; }
    .reprorelay-annotate-toolbar { gap: 8px; padding: 10px 12px; }
    .reprorelay-tool-spacer { flex-basis: 100%; height: 0; }
    .reprorelay-annotate-done { flex: 1; justify-content: center; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
  }
`;
