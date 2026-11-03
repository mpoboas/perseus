import { describe, expect, it } from "vitest";
import { sanitizeZoom, stepZoom } from "./zoom";

describe("zoom", () => {
  it("steps through the browser-like sizes", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(125, 1)).toBe(150);
    expect(stepZoom(67, -1)).toBe(50);
  });

  it("stops at the ends", () => {
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
  });

  it("moves on from a value between two steps", () => {
    expect(stepZoom(105, 1)).toBe(110);
    expect(stepZoom(105, -1)).toBe(100);
  });

  it("repairs a stored value that makes no sense", () => {
    expect(sanitizeZoom(undefined)).toBe(100);
    expect(sanitizeZoom("big")).toBe(100);
    expect(sanitizeZoom(Number.NaN)).toBe(100);
    expect(sanitizeZoom(5000)).toBe(200);
    expect(sanitizeZoom(-3)).toBe(50);
  });
});
