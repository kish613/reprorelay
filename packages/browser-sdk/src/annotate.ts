/**
 * Screenshot annotation model and rendering.
 *
 * Annotations are stored as a retained list of vector shapes in the base
 * image's *natural* pixel coordinates. This lets the widget redraw the canvas
 * from scratch after every re-render (the panel rebuilds its innerHTML), makes
 * undo/clear trivial array operations, and keeps the final composite at full
 * screenshot resolution regardless of the on-screen preview size.
 */

export const ANNOTATION_TOOLS = ["pen", "box", "ellipse", "highlight", "redact", "arrow"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

export interface Point {
  x: number;
  y: number;
}

interface BaseAnnotation {
  tool: AnnotationTool;
  color: string;
  /** Stroke/handle width in natural image pixels. */
  width: number;
}

export interface PenAnnotation extends BaseAnnotation {
  tool: "pen";
  points: Point[];
}

export interface ShapeAnnotation extends BaseAnnotation {
  tool: "box" | "ellipse" | "highlight" | "redact" | "arrow";
  from: Point;
  to: Point;
}

export type Annotation = PenAnnotation | ShapeAnnotation;

/** Highlighter fill opacity — translucent so underlying content stays legible. */
const HIGHLIGHT_ALPHA = 0.32;

/**
 * Maps a pointer position (in CSS pixels, relative to the displayed canvas
 * rect) to a point in the base image's natural coordinate space.
 */
export function toNaturalPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): Point {
  const scaleX = rect.width > 0 ? natural.width / rect.width : 1;
  const scaleY = rect.height > 0 ? natural.height / rect.height : 1;
  return {
    x: clamp((clientX - rect.left) * scaleX, 0, natural.width),
    y: clamp((clientY - rect.top) * scaleY, 0, natural.height),
  };
}

/** Ratio between natural image pixels and displayed CSS pixels. */
export function naturalScale(displayWidth: number, naturalWidth: number): number {
  return displayWidth > 0 ? naturalWidth / displayWidth : 1;
}

/** Normalises two corner points into a top-left origin plus size. */
export function normalizeRect(from: Point, to: Point): { x: number; y: number; width: number; height: number } {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/** True when a drag is large enough to be a deliberate shape rather than a stray click. */
export function isMeaningfulShape(from: Point, to: Point, minSize = 3): boolean {
  return Math.abs(to.x - from.x) >= minSize || Math.abs(to.y - from.y) >= minSize;
}

/** Draws every annotation onto a context already positioned in natural coordinates. */
export function drawAnnotations(ctx: CanvasRenderingContext2D, annotations: Iterable<Annotation>): void {
  for (const annotation of annotations) drawAnnotation(ctx, annotation);
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = annotation.width;
  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;

  switch (annotation.tool) {
    case "pen":
      drawPen(ctx, annotation);
      break;
    case "box":
      drawBox(ctx, annotation);
      break;
    case "ellipse":
      drawEllipse(ctx, annotation);
      break;
    case "highlight":
      drawHighlight(ctx, annotation);
      break;
    case "redact":
      drawRedact(ctx, annotation);
      break;
    case "arrow":
      drawArrow(ctx, annotation);
      break;
  }

  ctx.restore();
}

function drawPen(ctx: CanvasRenderingContext2D, annotation: PenAnnotation): void {
  const [first, ...rest] = annotation.points;
  if (!first) return;
  if (rest.length === 0) {
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.arc(first.x, first.y, annotation.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}

function drawBox(ctx: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
  const rect = normalizeRect(annotation.from, annotation.to);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
}

function drawEllipse(ctx: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
  const rect = normalizeRect(annotation.from, annotation.to);
  ctx.beginPath();
  ctx.ellipse(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    Math.max(rect.width / 2, annotation.width / 2),
    Math.max(rect.height / 2, annotation.width / 2),
    0,
    0,
    Math.PI * 2,
  );
  ctx.stroke();
}

function drawHighlight(ctx: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
  const rect = normalizeRect(annotation.from, annotation.to);
  ctx.globalAlpha = HIGHLIGHT_ALPHA;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

function drawRedact(ctx: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
  const rect = normalizeRect(annotation.from, annotation.to);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

function drawArrow(ctx: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
  const { from, to } = annotation;
  const headLength = Math.max(annotation.width * 3.2, 10);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headLength * Math.cos(angle - Math.PI / 6),
    to.y - headLength * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - headLength * Math.cos(angle + Math.PI / 6),
    to.y - headLength * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Flattens the base screenshot and the annotation layer into a single PNG at
 * the screenshot's native resolution.
 */
export async function compositeScreenshot(base: Blob, annotations: readonly Annotation[]): Promise<Blob> {
  const image = await loadImage(base);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to get a 2D context for the annotation composite");

  ctx.drawImage(image, 0, 0, width, height);
  drawAnnotations(ctx, annotations);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Unable to export the annotated screenshot");
  return blob;
}

/** Loads a blob into an HTMLImageElement, resolving once it is decodable. */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to load the screenshot for annotation"));
    };
    image.src = url;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
