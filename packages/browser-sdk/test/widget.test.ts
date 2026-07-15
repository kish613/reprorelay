import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPRORELAY_MARK } from "../src/brand.js";
import type { ActiveScreenRecording } from "../src/media.js";
import { ReportWidget } from "../src/widget.js";
import { memoryStorage } from "./memory-storage.js";

vi.mock("../src/media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/media.js")>()),
  startScreenRecording: vi.fn(async (): Promise<ActiveScreenRecording> => ({
    startedAt: Date.now(),
    includesCamera: false,
    includesMicrophone: false,
    finished: new Promise(() => undefined),
    stop: vi.fn(async () => {
      throw new Error("not stopped in this test");
    }),
    discard: vi.fn(),
  })),
}));

// jsdom can't decode blob images or rasterise a canvas, so stub the two
// browser-only helpers the annotation flow depends on. The geometry helpers
// keep their real implementations. vi.hoisted lets the composite blob be
// shared with the hoisted mock factory and the tests below.
const { COMPOSITE_BLOB } = vi.hoisted(() => ({ COMPOSITE_BLOB: new Blob(["composited"], { type: "image/png" }) }));
vi.mock("../src/annotate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/annotate.js")>()),
  loadImage: vi.fn(async () => ({ naturalWidth: 800, naturalHeight: 600, width: 800, height: 600 })),
  compositeScreenshot: vi.fn(async () => COMPOSITE_BLOB),
}));

// Node 24 ships a non-functional bare `localStorage` global that shadows
// jsdom's implementation in vitest — stub a working in-memory Storage.
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  // jsdom doesn't implement object URLs.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ReportWidget", () => {
  it("mounts an isolated logo launcher at the side of the host application", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });

    widget.mount();
    const host = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]");
    const launcher = host?.shadowRoot?.querySelector<HTMLButtonElement>(".reprorelay-launcher");

    expect(host).not.toBeNull();
    expect(host?.getAttribute("data-reprorelay-ignore")).toBe("");
    expect(launcher?.getAttribute("aria-label")).toBe("Report a problem");
    expect(launcher?.querySelector("img")?.src).toBe(DEFAULT_REPRORELAY_MARK);
    widget.destroy();
  });

  it("does not show host attribution by default", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });

    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")?.shadowRoot;
    expect(root?.querySelector(".reprorelay-attribution")).toBeNull();
    widget.destroy();
  });

  it("renders explicitly configured host attribution", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    }, {
      showAttribution: true,
      attributionLabel: "Supported by",
      attributionName: "Example Co",
      attributionLogoUrl: "https://example.com/logo.svg",
    });

    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")?.shadowRoot;
    const attribution = root?.querySelector(".reprorelay-attribution");
    expect(attribution?.getAttribute("aria-label")).toBe("Supported by Example Co");
    expect(attribution?.textContent).toContain("Supported by");
    expect(attribution?.querySelector<HTMLImageElement>("[data-reprorelay-attribution-logo]")?.src).toBe("https://example.com/logo.svg");
    widget.destroy();
  });

  it("lets a user continue without video and submit a report", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const widget = new ReportWidget("Report a problem", {
      onSubmit,
      onDismiss: vi.fn(),
    });
    widget.mount();
    widget.open();

    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-action="skip-recording"]')?.click();

    const form = root?.querySelector<HTMLFormElement>("form");
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const comment = form?.querySelector<HTMLTextAreaElement>('textarea[name="comment"]');
    const reporterEmail = form?.querySelector<HTMLInputElement>('input[name="reporterEmail"]');
    const highPriority = form?.querySelector<HTMLInputElement>('input[name="severity"][value="high"]');
    if (!form || !title || !comment || !reporterEmail || !highPriority) throw new Error("Expected report form");
    title.value = "Checkout froze";
    comment.value = "The payment button stopped responding.";
    reporterEmail.value = "reporter@example.com";
    highPriority.checked = true;
    form.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        title: "Checkout froze",
        comment: "The payment button stopped responding.",
        severity: "high",
        reporterEmail: "reporter@example.com",
        recording: undefined,
      }));
    });
    widget.destroy();
  });

  it("omits the reporter email field when the host app already supplied one", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      getReporterEmail: () => "signed-in@example.com",
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-action="skip-recording"]')?.click();
    expect(root?.querySelector('input[name="reporterEmail"]')).toBeNull();
    widget.destroy();
  });

  it("lets the customer drag the launcher vertically and remembers the spot", () => {
    window.localStorage.clear();
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });
    widget.mount();

    const host = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!;
    const launcher = host.shadowRoot!.querySelector<HTMLButtonElement>(".reprorelay-launcher")!;

    launcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 180 }));
    expect(host.style.getPropertyValue("--rr-shift")).toBe("-120px");
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 180 }));

    // A drag must not open the panel on the click that follows pointer release.
    launcher.click();
    expect(host.shadowRoot!.querySelector(".reprorelay-panel")).toBeNull();

    // A plain click (no movement) still opens it.
    launcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 180 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 181 }));
    launcher.click();
    expect(host.shadowRoot!.querySelector(".reprorelay-panel")).not.toBeNull();

    expect(window.localStorage.getItem("reprorelay.launcher-shift.v1")).toBe("-120");
    widget.destroy();

    // A fresh mount restores the saved spot.
    const widget2 = new ReportWidget("Report a problem", { onSubmit: vi.fn(async () => undefined), onDismiss: vi.fn() });
    widget2.mount();
    const host2 = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!;
    expect(host2.style.getPropertyValue("--rr-shift")).toBe("-120px");
    widget2.destroy();
    window.localStorage.clear();
  });

  it("clamps the drag so the launcher stays on screen", () => {
    window.localStorage.clear();
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });
    widget.mount();
    const host = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!;
    const launcher = host.shadowRoot!.querySelector<HTMLButtonElement>(".reprorelay-launcher")!;

    launcher.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: -10_000 }));
    const shift = Number.parseFloat(host.style.getPropertyValue("--rr-shift"));
    expect(shift).toBeLessThan(0);
    expect(Math.abs(shift)).toBeLessThanOrEqual(window.innerHeight / 2);
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: -10_000 }));
    widget.destroy();
    window.localStorage.clear();
  });

  it("shows a previous-reports view when history entries exist", () => {
    const listHistory = vi.fn(() => [
      { id: "r1", title: "Invoice table does not refresh", severity: "high", createdAt: "2026-07-12T09:00:00.000Z", hadVideo: true, hadScreenshot: true, status: "triaged" },
      { id: "r2", title: "Button misaligned", severity: "low", createdAt: "2026-07-10T09:00:00.000Z", hadVideo: false, hadScreenshot: true, status: "closed" },
    ]);
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory,
    });
    widget.mount();
    widget.open();

    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    const historyButton = root.querySelector<HTMLButtonElement>('[data-action="show-history"]');
    expect(historyButton?.textContent).toContain("Status");
    expect(historyButton?.textContent).toContain("2");
    historyButton?.click();

    let rows = root.querySelectorAll(".reprorelay-history-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Invoice table does not refresh");
    expect(rows[0]?.textContent).toContain("Under review");

    const resolvedToggle = root.querySelector<HTMLButtonElement>('[data-action="toggle-resolved-history"]');
    expect(resolvedToggle?.textContent).toContain("Resolved reports");
    expect(resolvedToggle?.textContent).toContain("1");
    expect(resolvedToggle?.getAttribute("aria-expanded")).toBe("false");
    resolvedToggle?.click();
    rows = root.querySelectorAll(".reprorelay-history-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain("Button misaligned");
    expect(rows[1]?.textContent).toContain("Resolved");
    expect(rows[1]?.querySelector(".reprorelay-history-sev")?.getAttribute("data-status")).toBe("closed");
    expect(root.querySelector('[data-action="toggle-resolved-history"]')?.getAttribute("aria-expanded")).toBe("true");

    root.querySelector<HTMLButtonElement>('[data-action="show-report"]')?.click();
    expect(root.querySelector('[data-recording-mode="screen"]')).not.toBeNull();
    widget.destroy();
  });

  it("shows the submitted date and time while keeping every resolved report at the bottom", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory: () => [
        { id: "resolved-new", title: "Resolved yesterday", severity: "low", createdAt: "2026-07-12T15:45:00.000Z", hadVideo: false, hadScreenshot: true, status: "closed" },
        { id: "open-old", title: "Open from Monday", severity: "high", createdAt: "2026-07-10T09:15:00.000Z", hadVideo: true, hadScreenshot: true, status: "triaged" },
        { id: "resolved-old", title: "Resolved last week", severity: "medium", createdAt: "2026-07-08T11:30:00.000Z", hadVideo: false, hadScreenshot: false, status: "closed" },
        { id: "open-new", title: "Open from today", severity: "critical", createdAt: "2026-07-13T13:47:00.000Z", hadVideo: false, hadScreenshot: true, status: "new" },
      ],
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="show-history"]')?.click();

    let rows = [...root.querySelectorAll<HTMLElement>(".reprorelay-history-row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "Open from today",
      "Open from Monday",
    ]);
    const submitted = rows[0]?.querySelector(".reprorelay-history-meta span")?.textContent ?? "";
    expect(submitted).toContain("Submitted");
    expect(submitted).toContain("2026");
    expect(submitted).toMatch(/\d{2}:\d{2}/);

    root.querySelector<HTMLButtonElement>('[data-action="toggle-resolved-history"]')?.click();
    rows = [...root.querySelectorAll<HTMLElement>(".reprorelay-history-row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "Open from today",
      "Open from Monday",
      "Resolved yesterday",
      "Resolved last week",
    ]);
    widget.destroy();
  });

  it("keeps the Status tab available and explains the empty state", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory: () => [],
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="show-history"]')?.click();
    expect(root.querySelector(".reprorelay-history-empty")?.textContent).toContain("No reports from this browser yet");
    widget.destroy();
  });

  it("labels an authenticated project feed as organisation-wide", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory: () => [],
      historyScope: "project",
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="show-history"]')?.click();
    expect(root.querySelector(".reprorelay-history-empty")?.textContent).toContain("No organisation reports yet");
    expect(root.querySelector(".reprorelay-history-foot")?.textContent).toContain("signed-in members of your organisation");
    widget.destroy();
  });

  it("shows an all-clear state when every report is resolved", () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory: () => [
        { id: "r1", title: "Checkout button fixed", severity: "high", createdAt: "2026-07-12T09:00:00.000Z", hadVideo: true, hadScreenshot: false, status: "closed" },
      ],
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="show-history"]')?.click();

    expect(root.querySelector(".reprorelay-history-cleared")?.textContent).toContain("No open reports");
    expect(root.querySelectorAll(".reprorelay-history-row")).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('[data-action="toggle-resolved-history"]')?.click();
    expect(root.querySelector(".reprorelay-history-row")?.textContent).toContain("Checkout button fixed");
    widget.destroy();
  });

  it("refreshes acknowledgement and fixing progress when the Status tab opens", async () => {
    const base = { id: "r1", title: "Checkout freezes", severity: "high", createdAt: "2026-07-12T09:00:00.000Z", hadVideo: true, hadScreenshot: true, status: "new" };
    const refreshHistory = vi.fn(async () => [{
      ...base,
      status: "agent_handoff",
      trackingToken: "a".repeat(64),
      seenAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-13T10:30:00.000Z",
    }]);
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
      listHistory: () => [base],
      refreshHistory,
    });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="show-history"]')?.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".reprorelay-history-row")?.textContent).toContain("With engineering");
      expect(root.querySelector(".reprorelay-history-row")?.textContent).toContain("Seen by our team");
    });
    expect(refreshHistory).toHaveBeenCalledOnce();
    widget.destroy();
  });

  it("offers drawing tools while recording without rebuilding the dock", async () => {
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });
    widget.mount();
    widget.open();

    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-recording-mode="screen"]')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".reprorelay-recording-dock")).not.toBeNull();
    });

    const dock = root.querySelector(".reprorelay-recording-dock");
    const penButton = root.querySelector<HTMLButtonElement>('[data-live-tool="pen"]');
    const circleButton = root.querySelector<HTMLButtonElement>('[data-live-tool="ellipse"]');
    const arrowButton = root.querySelector<HTMLButtonElement>('[data-live-tool="arrow"]');
    const spotlightButton = root.querySelector<HTMLButtonElement>('[data-action="live-spotlight"]');
    expect(penButton).not.toBeNull();
    expect(circleButton).not.toBeNull();
    expect(arrowButton).not.toBeNull();
    expect(spotlightButton).not.toBeNull();

    const canvas = root.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(false);

    // Selecting a tool arms the overlay and marks the button active in place —
    // the dock node must not be replaced (that replays its entry animation).
    penButton?.click();
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(true);
    expect(penButton?.classList.contains("reprorelay-tool-active")).toBe(true);
    expect(root.querySelector(".reprorelay-recording-dock")).toBe(dock);

    // Tapping the active tool again disarms it.
    penButton?.click();
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(false);
    expect(penButton?.classList.contains("reprorelay-tool-active")).toBe(false);

    widget.destroy();
    // The overlay is torn down with the widget.
    expect(root.querySelector(".reprorelay-live-canvas")).toBeNull();
  });

  it("keeps the recording dock stable while the timer ticks", async () => {
    vi.useFakeTimers();
    const widget = new ReportWidget("Report a problem", {
      onSubmit: vi.fn(async () => undefined),
      onDismiss: vi.fn(),
    });
    widget.mount();
    widget.open();

    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-recording-mode="screen"]')?.click();
    await vi.waitFor(() => {
      expect(root?.querySelector(".reprorelay-recording-dock")).not.toBeNull();
    });

    const dock = root?.querySelector(".reprorelay-recording-dock");
    const stopButton = dock?.querySelector<HTMLButtonElement>('[data-action="stop-recording"]');
    expect(dock?.querySelector("small")?.textContent).toBe("0:00");

    // The per-second timer must update the label in place — replacing the dock
    // replays its entry animation every second (the indicator "flies off").
    await vi.advanceTimersByTimeAsync(3000);
    expect(root?.querySelector(".reprorelay-recording-dock")).toBe(dock);
    expect(dock?.querySelector('[data-action="stop-recording"]')).toBe(stopButton);
    expect(dock?.querySelector("small")?.textContent).toBe("0:03");

    widget.destroy();
  });
});

describe("ReportWidget screenshot annotation", () => {
  const shotBlob = new Blob(["shot"], { type: "image/png" });

  function setup() {
    const onSubmit = vi.fn(async () => undefined);
    const captureScreenshot = vi.fn(async () => shotBlob);
    const widget = new ReportWidget("Report a problem", { onSubmit, onDismiss: vi.fn(), captureScreenshot });
    widget.mount();
    widget.open();
    const root = document.querySelector<HTMLDivElement>("[data-reprorelay-widget]")!.shadowRoot!;
    return { widget, onSubmit, captureScreenshot, root };
  }

  async function reachFormWithScreenshot(root: ShadowRoot): Promise<void> {
    root.querySelector<HTMLButtonElement>('[data-action="skip-recording"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-action="annotate"]')).not.toBeNull());
  }

  function openEditor(root: ShadowRoot): void {
    root.querySelector<HTMLButtonElement>('[data-action="annotate"]')!.click();
  }

  function drawBox(root: ShadowRoot): void {
    root.querySelector<HTMLButtonElement>('[data-annotate-tool="box"]')!.click();
    const canvas = root.querySelector<HTMLCanvasElement>("[data-annotate-canvas]")!;
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 120, clientY: 90 }));
  }

  function fillAndSubmit(root: ShadowRoot): void {
    const form = root.querySelector<HTMLFormElement>("form")!;
    form.querySelector<HTMLInputElement>('input[name="title"]')!.value = "Broken layout";
    form.querySelector<HTMLTextAreaElement>('textarea[name="comment"]')!.value = "The header overlaps the nav.";
    form.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("captures a screenshot when the report form opens", async () => {
    const { widget, captureScreenshot, root } = setup();
    root.querySelector<HTMLButtonElement>('[data-action="skip-recording"]')!.click();
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(root.querySelector(".reprorelay-shot-preview img")).not.toBeNull());
    widget.destroy();
  });

  it("opens the editor with six tools, four colours and two widths", async () => {
    const { widget, root } = setup();
    await reachFormWithScreenshot(root);
    openEditor(root);
    const overlay = root.querySelector(".reprorelay-annotate");
    expect(overlay).not.toBeNull();
    // pen, box, ellipse (circle), highlight, redact, arrow
    expect(overlay!.querySelectorAll("[data-annotate-tool]")).toHaveLength(6);
    expect(overlay!.querySelectorAll("[data-annotate-color]")).toHaveLength(4);
    expect(overlay!.querySelectorAll("[data-annotate-width]")).toHaveLength(2);
    widget.destroy();
  });

  it("marks the selected tool as pressed", async () => {
    const { widget, root } = setup();
    await reachFormWithScreenshot(root);
    openEditor(root);
    root.querySelector<HTMLButtonElement>('[data-annotate-tool="box"]')!.click();
    expect(root.querySelector('[data-annotate-tool="box"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-annotate-tool="pen"]')!.getAttribute("aria-pressed")).toBe("false");
    widget.destroy();
  });

  it("draws a shape, enables undo, then clears back to none", async () => {
    const { widget, root } = setup();
    await reachFormWithScreenshot(root);
    openEditor(root);
    expect(root.querySelector<HTMLButtonElement>('[data-action="annotate-undo"]')!.disabled).toBe(true);

    drawBox(root);
    expect(root.querySelector<HTMLButtonElement>('[data-action="annotate-undo"]')!.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-action="annotate-undo"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-action="annotate-undo"]')!.disabled).toBe(true);
    widget.destroy();
  });

  it("composites annotations into the submitted screenshot", async () => {
    const { widget, onSubmit, root } = setup();
    await reachFormWithScreenshot(root);
    openEditor(root);
    drawBox(root);
    root.querySelector<HTMLButtonElement>('[data-action="annotate-done"]')!.click();

    await vi.waitFor(() => expect(root.querySelector(".reprorelay-shot-badge")).not.toBeNull());
    expect(root.querySelector(".reprorelay-annotate")).toBeNull();

    fillAndSubmit(root);
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ screenshot: COMPOSITE_BLOB }));
    });
    widget.destroy();
  });

  it("submits the plain screenshot when nothing is annotated", async () => {
    const { widget, onSubmit, root } = setup();
    await reachFormWithScreenshot(root);
    fillAndSubmit(root);
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ screenshot: shotBlob }));
    });
    widget.destroy();
  });

  it("submits no screenshot after the user removes it", async () => {
    const { widget, onSubmit, root } = setup();
    await reachFormWithScreenshot(root);
    root.querySelector<HTMLButtonElement>('[data-action="remove-screenshot"]')!.click();
    fillAndSubmit(root);
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ screenshot: null }));
    });
    widget.destroy();
  });
});
