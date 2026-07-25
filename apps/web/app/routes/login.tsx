import type { LinksFunction } from "react-router";
import { redirect } from "react-router";
import type { Route } from "./+types/login";
import { runLogin } from "~/server/auth/flow.server";
import { oidcConfigFromEnv } from "~/server/auth/oidc-config";
import { safeReturnTo } from "~/server/auth/redirect";
import { readSession } from "~/server/auth/session.server";
import { appContext } from "~/server/context";
import styles from "~/wbs/styles.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

// Public route (outside the protected layout). ADR 0012 bug fix: `/login` used to
// be a redirect-only loader that 302'd straight to Google. That works on a full
// document GET, but logout is a client-side RR navigation to `/login` — and RR
// does not hard-navigate on the loader's EXTERNAL redirect, so the route rendered
// nothing (blank white screen). `/login` now RENDERS a sign-in page; the OIDC
// authorization-code flow (PKCE + state + nonce + `oidc_tx`) is triggered by a
// full-document POST behind the button, where an external 302 works document-side.

/**
 * GET `/login`: an already-authenticated principal never sees the sign-in page
 * (bounce to `/projects`); otherwise render it, carrying a validated `returnTo`
 * so the eventual callback lands where the user was headed.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(appContext);
  const session = await readSession(env, request);
  if (session !== null) {
    return redirect("/projects");
  }
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  return { returnTo };
}

/**
 * POST `/login`: begin the server-side OIDC authorization-code flow. This is the
 * exact `runLogin` used before — PKCE(S256) + state + nonce, the `oidc_tx` cookie,
 * and a 302 to the provider — only now reached by a full-document form submission
 * so the external redirect is a real browser navigation. `returnTo` rides in on
 * the POST URL's query string (the button's form action), and `runLogin` reads +
 * sanitizes it exactly as before.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(appContext);
  return runLogin({ env, config: oidcConfigFromEnv(env), request });
}

/**
 * VECTA's signature glyph: a Gantt/schedule mark — three staggered,
 * decreasing-opacity accent bars (mirrors the app bar's lockup). Inlined here so
 * the public sign-in page stays self-contained (no import from the protected
 * app-bar chrome).
 */
function GanttGlyph() {
  return (
    <svg
      className="login-lockup__mark"
      viewBox="0 0 18 18"
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
 * The sign-in stage: the product's own signature, drawn once and large — a
 * time-phased WBS (schedule bars with finish-to-start dependency links and phase
 * milestones) with the earned-value curve cutting across and ending in a vector
 * arrowhead: the direction and momentum the name is drawn from. Purely
 * illustrative (no live data), so it is hidden from assistive tech. Ported from
 * the SPA's `ScheduleMotif`; every stroke resolves from the shared `.login-schedule*`
 * tokens, so it holds in both themes.
 */
function ScheduleMotif() {
  // [rowTop, start, planEnd, doneEnd, opacity] — bars cascade right, progress
  // meeting the "now" line (x=256); rows fade down, echoing the glyph.
  const rows: readonly (readonly [number, number, number, number, number])[] = [
    [66, 40, 160, 160, 1],
    [96, 112, 256, 240, 0.9],
    [126, 112, 220, 220, 0.8],
    [156, 184, 340, 256, 0.68],
    [186, 220, 360, 256, 0.56],
    [216, 268, 400, 268, 0.44],
    [246, 300, 400, 300, 0.34],
  ];
  const gridlines = [40, 112, 184, 256, 328, 400];
  // Finish-to-start dependency links, each an elbow ending in an arrowhead.
  const deps: readonly { readonly d: string; readonly arrow: string }[] = [
    { d: "M160 72 H176 V162 H180", arrow: "180,158.5 185,162 180,165.5" },
    { d: "M220 132 V186", arrow: "216.5,186 220,191.5 223.5,186" },
  ];
  const milestones = ["340,156 345.5,162 340,168 334.5,162", "400,216 405.5,222 400,228 394.5,222"];
  return (
    <svg className="login-schedule" viewBox="0 0 440 320" focusable="false">
      <line className="login-schedule__axis" x1={40} y1={46} x2={400} y2={46} />
      {gridlines.map((x) => (
        <g key={x}>
          <line className="login-schedule__grid" x1={x} y1={46} x2={x} y2={288} />
          <line className="login-schedule__tick" x1={x} y1={46} x2={x} y2={52} />
        </g>
      ))}
      <line className="login-schedule__now" x1={256} y1={38} x2={256} y2={296} />
      <circle className="login-schedule__now-dot" cx={256} cy={38} r={3} />
      {rows.map(([y, start, planEnd, doneEnd, opacity]) => (
        <g key={y} opacity={opacity}>
          <rect className="login-schedule__plan" x={start} y={y} width={planEnd - start} height={12} rx={5} />
          {doneEnd > start ? (
            <rect className="login-schedule__done" x={start} y={y} width={doneEnd - start} height={12} rx={5} />
          ) : null}
        </g>
      ))}
      {deps.map((dep) => (
        <g key={dep.d}>
          <path className="login-schedule__dep" d={dep.d} />
          <polygon className="login-schedule__dep-arrow" points={dep.arrow} />
        </g>
      ))}
      {milestones.map((points) => (
        <polygon key={points} className="login-schedule__milestone" points={points} />
      ))}
      <g className="login-schedule__evm">
        <path d="M40 284 C120 281 168 250 214 204 C262 156 320 120 404 98" />
        <polygon points="407.9,97 401,102.4 399.2,95.6" />
      </g>
    </svg>
  );
}

/**
 * The sign-in page: the established asymmetric hero (cohesive with the app bar) —
 * an action side (brand lockup · descriptor · the name's origin · Google sign-in)
 * beside a quiet stage rendering the product's own signature schedule. The stage
 * drops on narrow screens where the action is all that matters.
 *
 * The sign-in control is a NATIVE `<form>` (not RR's `<Form>`) so its POST is a
 * real full-document navigation — RR only enhances its own `<Form>`, so this
 * bypasses client-side routing and lets the action's external 302 to Google run
 * document-side. The action mechanism is unchanged; only the presentation is.
 */
export default function Login({ loaderData }: Route.ComponentProps) {
  const { returnTo } = loaderData;
  const action =
    returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <main className="login-screen" data-testid="login-screen">
      <section className="login-aside">
        <div className="login-intro">
          <span className="login-lockup">
            <GanttGlyph />
            <h1 className="login-wordmark">VECTA</h1>
          </span>
          <p className="login-descriptor">Earned Value, Cost &amp; Timeline Analytics</p>
          <p className="login-origin">
            名前は <span className="login-origin__term">vector</span> に由来します。アーンドバリュー・コスト・スケジュールの実データから、プロジェクトが今どちらへ、どれだけの勢いで進んでいるかを読み取ります。
          </p>
        </div>
        <div className="login-action">
          <form method="post" action={action} data-testid="login-form">
            <button type="submit" className="login-button" data-testid="google-sign-in">
              Google でサインイン
            </button>
          </form>
          <p className="login-meta">Google アカウントで続行します。</p>
        </div>
      </section>
      <aside className="login-stage" aria-hidden="true">
        <ScheduleMotif />
      </aside>
    </main>
  );
}
