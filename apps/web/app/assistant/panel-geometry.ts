/**
 * Where the assistant panel sits and how big it is.
 *
 * The user's requirement was a panel they can freely resize, floating over the
 * screen — not a route, not a modal, not a fixed side rail — so that it can be
 * shrunk to keep the grid visible while a diff is being read. Position and size
 * therefore have to survive a reload, and requirement 8 rules out the database:
 * `localStorage` it is, with no schema change anywhere.
 *
 * The pure functions here are separated from the React hook so the awkward parts —
 * clamping to a viewport that may have shrunk since last time, and refusing
 * corrupt stored values — are testable without a DOM.
 */

export interface PanelGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const STORAGE_KEY = "vecta.assistant.panel";

export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 240;

/**
 * Below this, a diff cannot be read carefully enough to approve it. ADR 0013 makes
 * that a constraint rather than a preference: the barriers in front of a bad
 * proposal all work, and none of them help if the last one — a person looking at
 * the change — happens in a 320-pixel box.
 */
export const REVIEW_MIN_WIDTH = 560;
export const REVIEW_MIN_HEIGHT = 420;

export const DEFAULT_GEOMETRY: PanelGeometry = { x: 0, y: 0, width: 480, height: 560 };

/** Right-aligned with a margin, vertically inset — the default first-open spot. */
export function defaultGeometryFor(viewport: Viewport): PanelGeometry {
  const margin = 24;
  const width = Math.min(DEFAULT_GEOMETRY.width, Math.max(MIN_WIDTH, viewport.width - margin * 2));
  const height = Math.min(
    DEFAULT_GEOMETRY.height,
    Math.max(MIN_HEIGHT, viewport.height - margin * 2),
  );
  return {
    x: Math.max(margin, viewport.width - width - margin),
    y: margin,
    width,
    height,
  };
}

/** Maximised, but still inset — it stays an overlay, it does not become a page. */
export function maximisedGeometryFor(viewport: Viewport): PanelGeometry {
  const margin = 16;
  return {
    x: margin,
    y: margin,
    width: Math.max(MIN_WIDTH, viewport.width - margin * 2),
    height: Math.max(MIN_HEIGHT, viewport.height - margin * 2),
  };
}

/**
 * Keep the panel on screen and above the minimum. Matters because the stored
 * geometry came from whatever window the user had last time: a panel restored at
 * `x: 1800` on a laptop screen would be invisible and unrecoverable without
 * clearing storage.
 */
export function clampGeometry(geometry: PanelGeometry, viewport: Viewport): PanelGeometry {
  const width = Math.min(Math.max(MIN_WIDTH, geometry.width), Math.max(MIN_WIDTH, viewport.width));
  const height = Math.min(
    Math.max(MIN_HEIGHT, geometry.height),
    Math.max(MIN_HEIGHT, viewport.height),
  );
  // At least a strip of the panel — its drag handle — must stay reachable.
  const handleStrip = 48;
  return {
    width,
    height,
    x: Math.min(Math.max(0, geometry.x), Math.max(0, viewport.width - handleStrip)),
    y: Math.min(Math.max(0, geometry.y), Math.max(0, viewport.height - handleStrip)),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse stored geometry, returning `null` for anything unusable. Corrupt storage
 * is not an error worth surfacing — the panel just opens where it would have on a
 * first visit.
 */
export function parseStoredGeometry(raw: string | null): PanelGeometry | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<PanelGeometry>;
  if (
    !isFiniteNumber(candidate.x) ||
    !isFiniteNumber(candidate.y) ||
    !isFiniteNumber(candidate.width) ||
    !isFiniteNumber(candidate.height)
  ) {
    return null;
  }
  return { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height };
}

/**
 * May a diff be approved at this size?
 *
 * The guard exists to stop the specific failure ADR 0013 names — waving a change
 * through in a panel deliberately shrunk to a corner — and NOT to lock small
 * screens out. So it yields once the panel is as large as this window can make it:
 * refusing there would leave a user with no way to approve at all, which is a worse
 * outcome than a cramped review, and no amount of insisting would widen the window.
 */
export function canReview(geometry: PanelGeometry, viewport: Viewport): boolean {
  if (geometry.width >= REVIEW_MIN_WIDTH && geometry.height >= REVIEW_MIN_HEIGHT) return true;
  const best = maximisedGeometryFor(viewport);
  return geometry.width >= best.width && geometry.height >= best.height;
}
