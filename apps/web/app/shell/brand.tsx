/**
 * VECTA's signature glyph: a Gantt/schedule mark — three staggered,
 * decreasing-opacity accent bars, because the product IS a time-phased WBS.
 * `currentColor` picks up the accent from the surface that renders it.
 *
 * It lives in its own module rather than in `app-bar.tsx` because the error and
 * sign-in notice screens draw it too, and they must not pull the app bar (and
 * its router imports) into their chunk — the root error boundary in particular
 * should depend on as little as possible.
 */
export function GanttGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 18 18"
      width="18"
      height="18"
      role="img"
      aria-label="VECTA"
      focusable="false"
    >
      <rect x="1" y="3.5" width="12" height="3" rx="1.5" fill="currentColor" />
      <rect x="4" y="7.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
      <rect x="7" y="11.5" width="9" height="3" rx="1.5" fill="currentColor" opacity="0.46" />
    </svg>
  );
}
