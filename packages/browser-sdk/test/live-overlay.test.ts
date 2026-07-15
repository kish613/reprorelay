import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveOverlay } from "../src/live-overlay.js";

function makeOverlay(hitResults: () => Element[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const overlay = new LiveOverlay(root, host, { hitTest: hitResults });
  return { overlay, root, host };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("LiveOverlay", () => {
  it("is inert until a tool is selected", () => {
    const { overlay, root } = makeOverlay(() => []);
    const canvas = root.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(false);

    overlay.setTool("pen");
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(true);
    overlay.setTool(null);
    expect(canvas?.classList.contains("reprorelay-live-active")).toBe(false);
    overlay.destroy();
  });

  it("records drawn shapes and supports undo/clear", () => {
    const { overlay, root } = makeOverlay(() => []);
    const canvas = root.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas")!;
    overlay.setTool("arrow");

    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 120, clientY: 90 }));
    expect(overlay.annotationCount).toBe(1);

    overlay.setTool("ellipse");
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 40, clientY: 40, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 90, clientY: 80 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 90, clientY: 80 }));
    expect(overlay.annotationCount).toBe(2);

    overlay.undo();
    expect(overlay.annotationCount).toBe(1);
    overlay.clear();
    expect(overlay.annotationCount).toBe(0);
    overlay.destroy();
  });

  it("ignores taps too small to be a shape", () => {
    const { overlay, root } = makeOverlay(() => []);
    const canvas = root.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas")!;
    overlay.setTool("ellipse");
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 11, clientY: 11 }));
    expect(overlay.annotationCount).toBe(0);
    overlay.destroy();
  });

  it("picks an element to spotlight and reports a selector", () => {
    const target = document.createElement("button");
    target.id = "export-invoices";
    document.body.appendChild(target);

    const onSpotlightChange = vi.fn();
    const { overlay, root } = makeOverlay(() => [target]);
    overlay.onSpotlightChange = onSpotlightChange;

    overlay.startPicker();
    const canvas = root.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas")!;
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 50, clientY: 50, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 50, clientY: 50 }));

    expect(overlay.spotlight?.selector).toBe("#export-invoices");
    expect(onSpotlightChange).toHaveBeenCalled();
    expect(root.querySelector(".reprorelay-spotlight-ring")).not.toBeNull();

    overlay.clearSpotlight();
    expect(overlay.spotlight).toBeUndefined();
    overlay.destroy();
  });

  it("never spotlights the widget's own host", () => {
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const shadow = holder.attachShadow({ mode: "open" });
    const overlay = new LiveOverlay(shadow, holder, { hitTest: () => [holder] });

    overlay.startPicker();
    const canvas = shadow.querySelector<HTMLCanvasElement>(".reprorelay-live-canvas")!;
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 5, clientY: 5 }));

    expect(overlay.spotlight).toBeUndefined();
    overlay.destroy();
  });
});
