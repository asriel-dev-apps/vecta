import { redirect, type RouterContextProvider } from "react-router";
import { principalContext } from "../context";
import type { AuthenticatedPrincipal } from "./principal-directory";

/**
 * Read the authenticated principal for a protected-route loader/action. The
 * auth middleware guarantees the session is present and valid before any loader
 * runs, and installs the memoised loader on {@link principalContext}; this
 * awaits it (one DB hit per request). If the principal has since been
 * deleted/disabled, it fails closed by redirecting to `/login`.
 *
 * Project-scoped role authorization is a later step; this only authenticates
 * and surfaces the principal + its memberships.
 */
export async function requirePrincipal(
  context: Readonly<RouterContextProvider>,
): Promise<AuthenticatedPrincipal> {
  const loadPrincipal = context.get(principalContext);
  const principal = await loadPrincipal();
  if (principal === null) {
    throw redirect("/login");
  }
  return principal;
}
