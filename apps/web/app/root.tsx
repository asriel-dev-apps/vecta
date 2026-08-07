import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  type LinksFunction,
} from "react-router";
import type { Route } from "./+types/root";
import { appContext, dbSessionContext } from "~/server/context.server";
import { createDbSession } from "~/server/db-session.server";
import { appTitle } from "~/shell/document-title";
import { NoticeScreen } from "~/shell/notice-screen";
import appStyles from "~/wbs/styles.css?url";

// Linked from the ROOT, not just from each screen, so the error boundary is
// styled no matter which route failed — an error thrown before a leaf route's
// own `links` are applied used to leave an unstyled white page. React Router
// dedupes the identical href against the screens that also link it.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: appStyles }];

// The fallback title. `<Meta />` renders the deepest route that exports `meta`,
// so this is what a route without one gets — including the error boundary.
export function meta() {
  return [{ title: appTitle("プロジェクト管理") }];
}

/**
 * Root middleware (ADR 0012 §4-pre): install a per-request database session and
 * close it deterministically after the response. It runs for EVERY request —
 * public and protected — but the session opens its Neon connection lazily, so a
 * DB-free request (`/login`, `/logout`) pays nothing. Loaders/actions await
 * their reads and return before render, so closing in the `finally` after
 * `next()` is safe (no reader holds the connection past this point).
 */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ context }, next) => {
    const { env } = context.get(appContext);
    const session = createDbSession(env);
    context.set(dbSessionContext, session);
    const startedAt = Date.now();
    try {
      const response = await next();
      // `Server-Timing` — the only way to get the REAL Tokyo→Singapore number
      // rather than an arithmetic estimate from round-trip counts. Attached here
      // because this middleware already owns the session, so by the time `next()`
      // returns every loader and action has awaited its reads.
      //
      // COUNTS AND MILLISECONDS ONLY. No statement, no parameter, no row, no
      // table name: this is a response header on a public app, and anything
      // richer would make a measurement cost something.
      //
      // The counts matter as much as the durations. A count that rises with the
      // size of a project is the shape of a per-row write path, and a total alone
      // would hide it behind "the network was slow" — which is exactly how the
      // per-task loop stayed invisible for as long as it did. Now that the write
      // path is batched, `dbw` count staying flat as a project grows is the
      // property this header exists to keep honest.
      const { readCount, readMs, writeCount, writeMs } = session.timings();
      response.headers.append(
        "Server-Timing",
        [
          `app;dur=${Date.now() - startedAt}`,
          `db;desc="read ${readCount}";dur=${readMs}`,
          `dbw;desc="write ${writeCount}";dur=${writeMs}`,
        ].join(", "),
      );
      return response;
    } finally {
      await session.close();
    }
  },
];

// Apply the stored theme choice on <html> before first paint, so an explicit
// light/dark pick never flashes the OS theme under SSR (ADR 0012 Step 4a). Mirrors
// `apps/web`'s AppRoot: "system"/absent leaves the attribute off (the stylesheet's
// `prefers-color-scheme` governs), an explicit pick sets `data-theme`. Runs inline
// in <head> before the body renders; the served markup is identical on both sides.
const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem('vecta-theme');" +
  "if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Last-resort backstop: any unhandled throw (loader/render) renders inside
 * `Layout` instead of a blank document.
 *
 * The copy is split by what the user can actually do about it. A 404 is
 * routine — the project link is stale, or it is not theirs (the access gate
 * returns 404 rather than 403 on purpose, so a denial and a nonexistent project
 * are indistinguishable). A 5xx or an unexpected throw is ours, and the only
 * useful advice is to try again. Nothing here reveals which of those a 404 was,
 * and no error detail reaches the page.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const routeError = isRouteErrorResponse(error) ? error : null;
  const notice =
    routeError?.status === 404
      ? {
          title: "ページが見つかりません",
          body: "リンクが古いか、このアカウントからは開けないプロジェクトです。プロジェクト一覧からお探しください。",
          action: { href: "/projects", label: "プロジェクト一覧へ" },
        }
      : routeError !== null
        ? {
            title: "表示できませんでした",
            body: "このページを開けませんでした。時間をおいて、もう一度お試しください。",
            action: { href: "/projects", label: "プロジェクト一覧へ" },
          }
        : {
            title: "予期しないエラーが発生しました",
            body: "処理を完了できませんでした。時間をおいて、もう一度お試しください。",
            action: { href: "/", label: "最初から開き直す" },
          };
  return (
    <NoticeScreen
      title={notice.title}
      body={notice.body}
      action={notice.action}
      {...(routeError === null ? {} : { status: routeError.status })}
    />
  );
}
