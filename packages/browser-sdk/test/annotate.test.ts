import { describe, expect, it } from "vitest";
import { isMeaningfulShape, naturalScale, normalizeRect, toNaturalPoint } from "../src/annotate.js";

describe("toNaturalPoint", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  const natural = { width: 800, height: 600 };

  it("maps a pointer position to natural image coordinates using the display scale", () => {
    // Centre of the displayed canvas -> centre of the natural image.
    expect(toNaturalPoint(300, 200, rect, natural)).toEqual({ x: 400, y: 300 });
  });

  it("maps the top-left corner to the image origin", () => {
    expect(toNaturalPoint(100, 50, rect, natural)).toEqual({ x: 0, y: 0 });
  });

  it("clamps points outside the displayed canvas into the image bounds", () => {
    expect(toNaturalPoint(1000, 1000, rect, natural)).toEqual({ x: 800, y: 600 });
    expect(toNaturalPoint(-40, -40, rect, natural)).toEqual({ x: 0, y: 0 });
  });

  it("does not divide by zero for a collapsed rect", () => {
    const point = toNaturalPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, natural);
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});

describe("naturalScale", () => {
  it("returns the ratio of natural to displayed width", () => {
    expect(naturalScale(400, 800)).toBe(2);
  });

  it("falls back to 1 for a zero-width display", () => {
    expect(naturalScale(0, 800)).toBe(1);
  });
});

describe("normalizeRect", () => {
  it("orders corners into a top-left origin plus positive size", () => {
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 15 })).toEqual({ x: 10, y: 15, width: 20, height: 25 });
  });
});

describe("isMeaningfulShape", () => {
  it("rejects a stray click", () => {
    expect(isMeaningfulShape({ x: 5, y: 5 }, { x: 6, y: 6 })).toBe(false);
  });

  it("accepts a deliberate drag", () => {
    expect(isMeaningfulShape({ x: 5, y: 5 }, { x: 40, y: 6 })).toBe(true);
  });
});
