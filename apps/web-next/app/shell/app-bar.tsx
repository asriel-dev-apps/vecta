import { useCallback, useEffect, useState } from "react";
import { Form, NavLink } from "react-router";

// ADR 0012 Step 4c-2 — the per-project tier-1 app bar, ported from the SPA's
// `apps/web/src/AppRoot.tsx` `app-bar` (BrandLockup + Gantt glyph, the three-way
// theme toggle, identity, Sign out, and the editorial nav). Rendered once by the
// `/projects/:id` layout above each screen's own tier-2 `app-header`.
//
// Two faithful adaptations forced by the web-next architecture (both flagged in
// the port notes):
//   • Theme is applied in an effect/handler ONLY. The root `<head>` inline script
//     owns load-time application (before first paint, no flash); re-applying at
//     module load — as the SPA does — would touch `document` during SSR and
//     desync the toggle's initial selected state from the server render.
//   • The nav is real routed navigation (RR `NavLink`), not the SPA's in-memory
//     view-state tabs. The active view's `aria-selected`/underline intent carries
//     to `NavLink`'s active state (`aria-current="page"` + `nav-tab--active`).

/**
 * Theme control — light/dark that actually switches live. The stylesheet's tokens
 * default to `prefers-color-scheme`; an explicit choice is written as a
 * `data-theme` attribute on <html> whose token overrides out-specify the media
 * query, so the flip is instant and persists across visits. "system" clears the
 * attribute and hands control back to the OS.
 */
type ThemePref = "system" | "light" | "dark";
const THEME_STORAGE_KEY = "vecta-theme";

function readThemePref(): ThemePref {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be unavailable (private mode); fall back to the OS default.
  }
  return "system";
}

function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

/**
 * The theme hook, SSR-safe (vs. the SPA's module-load `applyThemePref`). The
 * initial value is a deterministic "system" on BOTH the server and the client's
 * first render, so hydration matches; the stored choice is read in an effect
 * after mount to sync the toggle's SELECTED state (the root inline script already
 * applied the correct `data-theme` before first paint, so this never re-flashes
 * the theme). Choosing applies + persists in the handler — never at module load.
 */
export function useThemePref(): readonly [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => {
    setPref(readThemePref());
  }, []);
  const choose = useCallback((next: ThemePref) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the in-memory choice still applies.
    }
    applyThemePref(next);
    setPref(next);
  }, []);
  return [pref, choose];
}

function SystemThemeIcon() {
  // A half-filled disc — the "follow the system" mark.
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.8a5.2 5.2 0 0 1 0 10.4Z" fill="currentColor" />
    </svg>
  );
}

function LightThemeIcon() {
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="1.4" x2="8" y2="3" />
        <line x1="8" y1="13" x2="8" y2="14.6" />
        <line x1="1.4" y1="8" x2="3" y2="8" />
        <line x1="13" y1="8" x2="14.6" y2="8" />
        <line x1="3.3" y1="3.3" x2="4.5" y2="4.5" />
        <line x1="11.5" y1="11.5" x2="12.7" y2="12.7" />
        <line x1="3.3" y1="12.7" x2="4.5" y2="11.5" />
        <line x1="11.5" y1="4.5" x2="12.7" y2="3.3" />
      </g>
    </svg>
  );
}

function DarkThemeIcon() {
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M13.2 9.9A5.4 5.4 0 1 1 7.1 2.8a4.2 4.2 0 0 0 6.1 7.1Z" fill="currentColor" />
    </svg>
  );
}

const THEME_OPTIONS = [
  { pref: "system", label: "システム設定に合わせる", Icon: SystemThemeIcon },
  { pref: "light", label: "ライトテーマ", Icon: LightThemeIcon },
  { pref: "dark", label: "ダークテーマ", Icon: DarkThemeIcon },
] as const;

/**
 * A quiet, editorial theme switch (システム / ライト / ダーク), reachable from the
 * app bar. A radiogroup so the current mode is announced; choosing one applies
 * instantly via `useThemePref`.
 */
export function ThemeToggle({
  value,
  onChange,
  className,
}: {
  readonly value: ThemePref;
  readonly onChange: (pref: ThemePref) => void;
  readonly className?: string;
}) {
  return (
    <div
      className={`theme-toggle${className === undefined ? "" : ` ${className}`}`}
      role="radiogroup"
      aria-label="テーマ"
      data-testid="theme-toggle"
    >
      {THEME_OPTIONS.map(({ pref, label, Icon }) => (
        <button
          key={pref}
          type="button"
          role="radio"
          aria-checked={value === pref}
          aria-label={label}
          title={label}
          className={`theme-toggle__opt${value === pref ? " theme-toggle__opt--active" : ""}`}
          data-testid={`theme-${pref}`}
          onClick={() => onChange(pref)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

/**
 * VECTA's signature glyph: a Gantt/schedule mark — three staggered,
 * decreasing-opacity accent bars, because the product IS a time-phased WBS.
 * `currentColor` picks up the accent from the surface that renders it.
 */
function GanttGlyph({ className }: { readonly className?: string }) {
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

/**
 * The VECTA brand lockup for the app bar: the Gantt glyph set in the accent, next
 * to the wordmark. Quiet, drawn once, and the bar's single signature.
 */
function BrandLockup() {
  return (
    <span className="app-bar__brand">
      <GanttGlyph className="app-bar__mark" />
      <span className="app-bar__wordmark">VECTA</span>
    </span>
  );
}

/** The per-project nav destinations (ADR 0012 Step 4c route set). */
const NAV_ITEMS = [
  { to: "wbs", label: "WBS", testId: "nav-wbs" },
  { to: "masters", label: "マスタ", testId: "nav-masters" },
  { to: "members", label: "メンバー", testId: "nav-members" },
  { to: "templates", label: "テンプレート", testId: "nav-templates" },
  { to: "dashboard", label: "ダッシュボード", testId: "nav-dashboard" },
] as const;

/**
 * The app-bar nav (Design 0003 §E-2): a quiet, editorial tab strip — muted text
 * with an accent underline on the active route. The SPA switched an in-memory
 * `view` on tab buttons; here each item is a routed `NavLink`, so the active
 * state (underline + `aria-current="page"`) is driven by the current URL.
 */
function ProjectNav() {
  return (
    <nav className="nav-tabs" aria-label="画面切り替え" data-testid="nav-tabs">
      {NAV_ITEMS.map(({ to, label, testId }) => (
        <NavLink
          key={to}
          to={to}
          data-testid={testId}
          className={({ isActive }) => `nav-tab${isActive ? " nav-tab--active" : ""}`}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The unified tier-1 app bar: brand lockup · (routed nav) · account cluster
 * (theme toggle, identity, Sign out). The identity shows the cookie-session
 * principal's `displayName` — the SPA showed the JWT email, but the cookie-session
 * principal carries no email, so this is the faithful adaptation forced by the
 * auth redesign. Sign out is a POST to `/logout` (the existing action destroys the
 * session).
 *
 * `nav` toggles the project-scoped tab strip: `/projects/:id/*` renders it (the
 * default), while the `/projects` list — where no project is selected, so WBS /
 * マスタ / … have nothing to point at — passes `nav={false}` for a brand+account
 * bar. Without the nav the brand's trailing divider would dangle, so the flush
 * variant drops it (`.app-bar--flush`).
 */
export function AppBar({
  displayName,
  nav = true,
}: {
  readonly displayName: string;
  readonly nav?: boolean;
}) {
  const [theme, setTheme] = useThemePref();
  return (
    <header className={`app-bar${nav ? "" : " app-bar--flush"}`} data-testid="auth-bar">
      <BrandLockup />
      {nav ? <ProjectNav /> : null}
      <div className="app-bar__account">
        <ThemeToggle value={theme} onChange={setTheme} />
        <span className="auth-identity" data-testid="auth-identity">
          {displayName}
        </span>
        <Form method="post" action="/logout">
          <button
            type="submit"
            className="auth-signout"
            data-testid="google-sign-out"
          >
            Sign out
          </button>
        </Form>
      </div>
    </header>
  );
}
