import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";
import type { Route } from "./+types/root";
import { appContext, dbSessionContext } from "~/server/context";
import { createDbSession } from "~/server/db-session.server";

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
    try {
      return await next();
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

// Last-resort backstop: any unhandled throw (loader/render) renders this clean
// page inside `Layout` instead of a blank document. Kept intentionally minimal.
export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? "お探しのページを表示できませんでした。"
    : "予期しないエラーが発生しました。時間をおいて、もう一度お試しください。";
  return (
    <main>
      <h1>エラーが発生しました</h1>
      <p>{message}</p>
      <a href="/">トップへ戻る</a>
    </main>
  );
}
