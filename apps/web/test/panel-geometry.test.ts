// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  REVIEW_MIN_HEIGHT,
  REVIEW_MIN_WIDTH,
  canReview,
  clampGeometry,
  defaultGeometryFor,
  maximisedGeometryFor,
  parseStoredGeometry,
} from "~/assistant/panel-geometry";

const laptop = { width: 1440, height: 900 };

describe("panel geometry — a restored panel must never be unreachable", () => {
  it("pulls a panel stored off a bigger monitor back on screen", () => {
    // The realistic failure: geometry saved at the right edge of a 3440-wide
    // display, restored on a laptop, invisible and impossible to drag back.
    const clamped = clampGeometry({ x: 3200, y: 1400, width: 480, height: 560 }, laptop);
    expect(clamped.x).toBeLessThan(laptop.width);
    expect(clamped.y).toBeLessThan(laptop.height);
  });

  it("keeps a grabbable strip on screen even at the extreme", () => {
    const clamped = clampGeometry({ x: 99_999, y: 99_999, width: 480, height: 560 }, laptop);
    expect(laptop.width - clamped.x).toBeGreaterThanOrEqual(48);
    expect(laptop.height - clamped.y).toBeGreaterThanOrEqual(48);
  });

  it("never allows a panel smaller than its own minimum", () => {
    const clamped = clampGeometry({ x: 0, y: 0, width: 10, height: 10 }, laptop);
    expect(clamped.width).toBe(MIN_WIDTH);
    expect(clamped.height).toBe(MIN_HEIGHT);
  });

  it("never allows a panel larger than the window", () => {
    const clamped = clampGeometry({ x: 0, y: 0, width: 5_000, height: 5_000 }, laptop);
    expect(clamped.width).toBeLessThanOrEqual(laptop.width);
    expect(clamped.height).toBeLessThanOrEqual(laptop.height);
  });

  it("fits its default and maximised sizes inside a small window", () => {
    const tiny = { width: 360, height: 300 };
    for (const geometry of [defaultGeometryFor(tiny), maximisedGeometryFor(tiny)]) {
      expect(geometry.width).toBeGreaterThanOrEqual(MIN_WIDTH);
      expect(geometry.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }
  });
});

describe("panel geometry — corrupt storage opens where a first visit would", () => {
  it.each([
    ["null", null],
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["missing a field", '{"x":1,"y":2,"width":300}'],
    ["a string where a number belongs", '{"x":"1","y":2,"width":300,"height":300}'],
    ["NaN", '{"x":null,"y":2,"width":300,"height":300}'],
  ])("returns null for %s", (_label, raw) => {
    expect(parseStoredGeometry(raw)).toBeNull();
  });

  it("round-trips a valid record", () => {
    const geometry = { x: 12, y: 34, width: 500, height: 600 };
    expect(parseStoredGeometry(JSON.stringify(geometry))).toEqual(geometry);
  });
});

describe("review guard — blocks a shrunk panel, never a small screen", () => {
  it("allows a panel at or above the review size", () => {
    expect(
      canReview({ x: 0, y: 0, width: REVIEW_MIN_WIDTH, height: REVIEW_MIN_HEIGHT }, laptop),
    ).toBe(true);
  });

  it("blocks a panel the user shrank below it while more room was available", () => {
    expect(canReview({ x: 0, y: 0, width: 400, height: 300 }, laptop)).toBe(false);
  });

  // Refusing here would leave no way to approve at all, and no amount of insisting
  // would make the window wider. A cramped review beats an impossible one.
  it("allows a maximised panel on a window too small for the review size", () => {
    const small = { width: 480, height: 380 };
    expect(canReview(maximisedGeometryFor(small), small)).toBe(true);
  });

  it("still blocks a shrunk panel on that same small window", () => {
    const small = { width: 480, height: 380 };
    expect(canReview({ x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT }, small)).toBe(false);
  });
});
