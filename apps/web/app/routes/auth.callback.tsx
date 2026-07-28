import { data, redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import {
  runCallback,
  type CallbackScreen,
} from "~/server/auth/flow.server";
import { createIdTokenVerifier } from "~/server/auth/id-token";
import { oidcConfigFromEnv } from "~/server/auth/oidc-config";
import { clearOidcTx } from "~/server/auth/oidc-tx.server";
import { createNeonPrincipalDirectory } from "~/server/auth/principal-directory.neon.server";
import { appContext, dbSessionContext } from "~/server/context";
import { writeSecurityEvent } from "~/server/security-log.server";
import { NoticeScreen } from "~/shell/notice-screen";

// Module-scoped so the remote JWKS is fetched and cached per isolate across
// logins (the verifier builds `createRemoteJWKSet` lazily on first `verify`).
const idTokenVerifier = createIdTokenVerifier();

// Error screens must not be served as HTTP 200 (they are failures, not content).
const SCREEN_STATUS: Record<CallbackScreen, number> = {
  provider_error: 400,
  retry: 400,
  forbidden: 403,
  unavailable: 503,
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(appContext);
  try {
    const result = await runCallback({
      env,
      config: oidcConfigFromEnv(env),
      request,
      verifier: idTokenVerifier,
      directory: createNeonPrincipalDirectory(context.get(dbSessionContext)),
    });

    const headers = new Headers();
    for (const cookie of result.setCookies) {
      headers.append("Set-Cookie", cookie);
    }
    if (result.type === "redirect") {
      // The one line that says a sign-in SUCCEEDED. Without it there is no
      // baseline to read a spike of failures against (ASVS scan M3).
      writeSecurityEvent({
        kind: "login_succeeded",
        reason: "session_issued",
        status: 302,
        request,
        principalId: result.principalId,
      });
      return redirect(result.location, { headers });
    }
    // `forbidden` is its own event: the person IS who they say they are — Google
    // verified them — and VECTA has no principal for them. That is a different
    // operational fact from a failed sign-in, and the only one carrying a
    // subject digest.
    writeSecurityEvent({
      kind: result.screen === "forbidden" ? "unknown_principal" : "login_failed",
      reason: result.reason,
      status: SCREEN_STATUS[result.screen],
      request,
      ...(result.subjectDigest === undefined ? {} : { subjectDigest: result.subjectDigest }),
    });
    return data(
      { screen: result.screen },
      { headers, status: SCREEN_STATUS[result.screen] },
    );
  } catch (error) {
    // Last-resort backstop: directory construction (e.g. a missing DATABASE_URL)
    // or any unexpected throw must still clear `oidc_tx` and render a clean
    // screen, never a 500 with a stale transaction cookie left behind.
    writeSecurityEvent({
      kind: "login_failed",
      reason: "unexpected_error",
      status: SCREEN_STATUS.unavailable,
      request,
      error,
    });
    const headers = new Headers();
    headers.append("Set-Cookie", await clearOidcTx(env));
    return data(
      { screen: "unavailable" as const },
      { headers, status: SCREEN_STATUS.unavailable },
    );
  }
}

const SCREENS: Record<CallbackScreen, { title: string; body: string }> = {
  provider_error: {
    title: "サインインできませんでした",
    body: "認証を完了できませんでした。お手数ですが、もう一度サインインしてください。",
  },
  retry: {
    title: "もう一度お試しください",
    body: "サインインの有効期限が切れたか、リンクが無効です。もう一度サインインしてください。",
  },
  forbidden: {
    title: "アクセス権がありません",
    body: "このアカウントには利用権限がありません。管理者にお問い合わせください。",
  },
  unavailable: {
    title: "しばらくしてからお試しください",
    body: "ただいま認証を完了できませんでした。時間をおいて、もう一度サインインしてください。",
  },
};

export default function AuthCallback({ loaderData }: Route.ComponentProps) {
  const screen = SCREENS[loaderData.screen];
  // The same notice surface the error boundary uses, so a refused sign-in looks
  // like part of VECTA rather than an unstyled failure. The status is not shown:
  // these screens are addressed to a person mid-sign-in, and the number would
  // only add noise (it is still on the response).
  return (
    <NoticeScreen
      title={screen.title}
      body={screen.body}
      action={{ href: "/login", label: "サインイン画面へ" }}
    />
  );
}
