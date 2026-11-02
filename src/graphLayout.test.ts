import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  ROW_H,
  type Badge,
  badgeAt,
  isDrag,
  rowAt,
  sameSubject,
  subjectAt,
} from "./graphLayout";

describe("rowAt", () => {
  it("maps canvas y plus scroll offset to a row index", () => {
    expect(rowAt(0, 0, 10)).toBe(0);
    expect(rowAt(ROW_H - 1, 0, 10)).toBe(0);
    expect(rowAt(ROW_H, 0, 10)).toBe(1);
    expect(rowAt(5, ROW_H * 3, 10)).toBe(3);
  });

  it("returns null above the canvas and past the last row", () => {
    expect(rowAt(-1, 0, 10)).toBeNull();
    expect(rowAt(ROW_H * 10, 0, 10)).toBeNull();
    expect(rowAt(0, 0, 0)).toBeNull();
  });
});

describe("badge and subject hit-testing", () => {
  const badges: Badge[] = [
    { ref: "HEAD", x: 100, w: 40 },
    { ref: "main", x: 146, w: 36 },
  ];

  it("finds the badge under x, including its edges", () => {
    expect(badgeAt(badges, 100)?.ref).toBe("HEAD");
    expect(badgeAt(badges, 182)?.ref).toBe("main");
    expect(badgeAt(badges, 143)).toBeNull(); // the gap between badges
    expect(badgeAt(undefined, 100)).toBeNull();
  });

  it("prefers a badge over its row, and falls back to the commit", () => {
    const byRow = new Map([[2, badges]]);
    const y = ROW_H * 2 + 4;
    expect(subjectAt(150, y, 0, 5, byRow)).toEqual({ kind: "ref", name: "main", row: 2 });
    expect(subjectAt(10, y, 0, 5, byRow)).toEqual({ kind: "commit", row: 2 });
    expect(subjectAt(150, ROW_H * 4 + 4, 0, 5, byRow)).toEqual({ kind: "commit", row: 4 });
    expect(subjectAt(150, ROW_H * 9, 0, 5, byRow)).toBeNull();
  });

  it("accounts for scrolling when resolving the row", () => {
    const byRow = new Map([[7, badges]]);
    expect(subjectAt(150, 4, ROW_H * 7, 20, byRow)).toEqual({ kind: "ref", name: "main", row: 7 });
  });

  it("puts the working-tree row above the commits when an offset is given", () => {
    const byRow = new Map([[0, badges]]);
    expect(subjectAt(10, 4, 0, 5, byRow, 1)).toEqual({ kind: "wip" });
    expect(subjectAt(150, ROW_H + 4, 0, 5, byRow, 1)).toEqual({ kind: "ref", name: "main", row: 0 });
    expect(subjectAt(10, ROW_H * 5 + 4, 0, 5, byRow, 1)).toEqual({ kind: "commit", row: 4 });
    expect(subjectAt(10, ROW_H * 6 + 4, 0, 5, byRow, 1)).toBeNull();
  });
});

describe("drag detection", () => {
  it("needs a few pixels of movement before a press becomes a drag", () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
    expect(isDrag(3, 4)).toBe(true); // 5px diagonal
    expect(isDrag(0, -DRAG_THRESHOLD_PX)).toBe(true);
  });

  it("compares subjects by identity", () => {
    expect(sameSubject({ kind: "commit", row: 1 }, { kind: "commit", row: 1 })).toBe(true);
    expect(sameSubject({ kind: "commit", row: 1 }, { kind: "commit", row: 2 })).toBe(false);
    expect(sameSubject({ kind: "ref", name: "a", row: 1 }, { kind: "ref", name: "b", row: 1 })).toBe(false);
    expect(sameSubject({ kind: "ref", name: "a", row: 1 }, { kind: "commit", row: 1 })).toBe(false);
    expect(sameSubject(null, null)).toBe(true);
    expect(sameSubject(null, { kind: "commit", row: 0 })).toBe(false);
    expect(sameSubject({ kind: "wip" }, { kind: "wip" })).toBe(true);
    expect(sameSubject({ kind: "wip" }, { kind: "commit", row: 0 })).toBe(false);
  });
});
