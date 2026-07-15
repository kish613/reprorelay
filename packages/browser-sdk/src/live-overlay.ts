/**
 * On-page drawing and element-spotlight layer shown while a screen recording
 * is running. Everything it renders is real DOM pixels, so annotations and the
 * spotlight appear in the recording whenever the customer records this
 * tab/screen. Reuses the retained-vector annotation model from annotate.ts;
 * coordinates are viewport CSS pixels.
 */

import {
  drawAnnotation,
  drawAnnotations,
  isMeaningfulShape,
  type Annotation,
  type PenAnnotation,
  type ShapeAnnotation,
} from "./annotate.js";

export type LiveTool = "pen" | "ellipse" | "arrow";

export interface SpotlightSelection {
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface LiveOverlayOptions {
  /** Elements under a viewport point, topmost first. Injectable for tests. */
  hitTest?: (x: number, y: number) => Element[];
}

const DEFAULT_COLOR = "#ff4f14";
const STROKE_WIDTH = 4;

export class LiveOverlay {
  onSpotlightChange?: (selection: SpotlightSelection | undefined) => void;
  onAnnotationsChange?: () => void;

  private readonly layer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ring: HTMLDivElement;
  private readonly hover: HTMLDivElement;
  private readonly hitTest: (x: number, y: number) => Element[];
  private readonly annotations: Annotation[] = [];
  private activeTool: LiveTool | null = null;
  private color = DEFAULT_COLOR;
  private picking = false;
  private active?: Annotation;
  private spotlightElement?: Element;
  private spotlightSelection?: SpotlightSelection;
  private trackingFrame?: number;
  private destroyed = false;

  constructor(
    parent: ShadowRoot | HTMLElement,
    private readonly widgetHost: HTMLElement,
    options: LiveOverlayOptions = {},
  ) {
    this.hitTest = options.hitTest ?? ((x, y) => document.elementsFromPoint(x, y));

    this.layer = document.createElement("div");
    this.layer.className = "reprorelay-live-layer";
    this.ring = document.createElement("div");
    this.ring.className = "reprorelay-spotlight-ring";
    this.ring.hidden = true;
    this.hover = document.createElement("div");
    this.hover.className = "reprorelay-spotlight-hover";
    this.hover.hidden = true;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "reprorelay-live-canvas";
    this.layer.append(this.ring, this.hover, this.canvas);
    parent.appendChild(this.layer);

    this.resize();
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("scroll", this.scheduleTrack, { capture: true, passive: true });
    this.bindPointerHandlers();
  }

  get tool(): LiveTool | null {
    return this.activeTool;
  }

  get isPicking(): boolean {
    return this.picking;
  }

  get annotationCount(): number {
    return this.annotations.length;
  }

  get spotlight(): SpotlightSelection | undefined {
    return this.spotlightSelection;
  }

  setTool(tool: LiveTool | null): void {
    this.picking = false;
    this.hover.hidden = true;
    this.activeTool = tool;
    this.syncInteractivity();
  }

  setColor(color: string): void {
    this.color = color;
  }

  startPicker(): void {
    this.activeTool = null;
    this.picking = true;
    this.syncInteractivity();
  }

  cancelPicker(): void {
    this.picking = false;
    this.hover.hidden = true;
    this.syncInteractivity();
  }

  clearSpotlight(): void {
    this.spotlightElement = undefined;
    this.spotlightSelection = undefined;
    this.ring.hidden = true;
    this.onSpotlightChange?.(undefined);
  }

  undo(): void {
    this.annotations.pop();
    this.redraw();
    this.onAnnotationsChange?.();
  }

  clear(): void {
    this.annotations.length = 0;
    this.redraw();
    this.onAnnotationsChange?.();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.trackingFrame !== undefined) cancelAnimationFrame(this.trackingFrame);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("scroll", this.scheduleTrack, { capture: true });
    this.layer.remove();
  }

  private readonly handleResize = (): void => {
    this.resize();
    this.scheduleTrack();
  };

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    this.redraw();
  }

  private syncInteractivity(): void {
    const interactive = this.activeTool !== null || this.picking;
    this.canvas.classList.toggle("reprorelay-live-active", interactive);
    this.canvas.classList.toggle("reprorelay-live-picking", this.picking);
  }

  private bindPointerHandlers(): void {
    const usePointer = typeof window.PointerEvent === "function";
    const downEvent = usePointer ? "pointerdown" : "mousedown";
    const moveEvent = usePointer ? "pointermove" : "mousemove";
    const upEvent = usePointer ? "pointerup" : "mouseup";

    this.canvas.addEventListener(moveEvent, (event) => {
      if (!this.picking) return;
      const point = event as MouseEvent;
      const target = this.elementUnder(point.clientX, point.clientY);
      if (target) this.positionBox(this.hover, target.getBoundingClientRect());
      this.hover.hidden = !target;
    });

    this.canvas.addEventListener(downEvent, (event) => {
      const down = event as MouseEvent;
      if (down.button !== undefined && down.button !== 0) return;

      if (this.picking) {
        const onUp = (): void => {
          window.removeEventListener(upEvent, onUp);
          const target = this.elementUnder(down.clientX, down.clientY);
          this.cancelPicker();
          if (target) this.selectSpotlight(target);
        };
        window.addEventListener(upEvent, onUp);
        event.preventDefault?.();
        return;
      }

      const tool = this.activeTool;
      if (!tool) return;
      event.preventDefault?.();
      const start = { x: down.clientX, y: down.clientY };
      this.active = tool === "pen"
        ? ({ tool: "pen", color: this.color, width: STROKE_WIDTH, points: [start] } satisfies PenAnnotation)
        : ({ tool, color: this.color, width: STROKE_WIDTH, from: start, to: start } satisfies ShapeAnnotation);

      const onMove = (raw: Event): void => {
        const move = raw as MouseEvent;
        if (!this.active) return;
        const point = { x: move.clientX, y: move.clientY };
        if (this.active.tool === "pen") this.active.points.push(point);
        else this.active.to = point;
        this.redraw();
      };
      const onUp = (): void => {
        window.removeEventListener(moveEvent, onMove);
        window.removeEventListener(upEvent, onUp);
        const finished = this.active;
        this.active = undefined;
        if (!finished) return;
        const keep = finished.tool === "pen"
          ? finished.points.length > 1
          : isMeaningfulShape(finished.from, finished.to);
        if (keep) {
          this.annotations.push(finished);
          this.onAnnotationsChange?.();
        }
        this.redraw();
      };
      window.addEventListener(moveEvent, onMove);
      window.addEventListener(upEvent, onUp);
    });
  }

  private elementUnder(x: number, y: number): Element | undefined {
    return this.hitTest(x, y).find((element) =>
      element !== this.widgetHost &&
      !this.widgetHost.contains(element) &&
      element !== document.documentElement &&
      element !== document.body,
    );
  }

  private selectSpotlight(element: Element): void {
    this.spotlightElement = element;
    const rect = element.getBoundingClientRect();
    this.spotlightSelection = {
      selector: buildSelector(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
    this.positionBox(this.ring, rect);
    this.ring.hidden = false;
    this.onSpotlightChange?.(this.spotlightSelection);
  }

  /** Keeps the spotlight ring glued to its element across scroll/resize. */
  private readonly scheduleTrack = (): void => {
    if (this.destroyed || !this.spotlightElement || this.trackingFrame !== undefined) return;
    this.trackingFrame = requestAnimationFrame(() => {
      this.trackingFrame = undefined;
      if (!this.spotlightElement) return;
      this.positionBox(this.ring, this.spotlightElement.getBoundingClientRect());
    });
  };

  private positionBox(box: HTMLDivElement, rect: DOMRect): void {
    box.style.left = `${rect.left - 4}px`;
    box.style.top = `${rect.top - 4}px`;
    box.style.width = `${rect.width + 8}px`;
    box.style.height = `${rect.height + 8}px`;
  }

  private redraw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return; // jsdom / very old browsers — state still tracks correctly.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(dpr, dpr);
    drawAnnotations(ctx, this.annotations);
    if (this.active) drawAnnotation(ctx, this.active);
  }
}

/** Short, privacy-safe selector: id → data-testid → tag.class chain (max 3 levels). No text content. */
function buildSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 3) {
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    const testId = current.getAttribute("data-testid");
    if (testId) {
      parts.unshift(`[data-testid="${testId}"]`);
      break;
    }
    const classes = [...current.classList].slice(0, 2).map((name) => `.${name}`).join("");
    parts.unshift(`${current.tagName.toLowerCase()}${classes}`);
    current = current.parentElement;
  }
  return parts.join(" > ");
}
