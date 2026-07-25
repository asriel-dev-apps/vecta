import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { middleware } from "~/root";
import { appContext, dbSessionContext } from "~/server/context";
import type { DbSession } from "~/server/db-session.server";
import { fakeEnv } from "./helpers";

const env = fakeEnv({
  DATABASE_URL: "postgres://user:pass@db.example.invalid/vecta",
});
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function middlewareArgs(context: RouterContextProvider) {
  const request = new Request("https://app.example.invalid/");
  return {
    request,
    context,
    params: {},
    url: new URL(request.url),
    pattern: "/",
  };
}

function baseContext(): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, { env, ctx });
  return context;
}

const rootMiddleware = middleware[0]!;

describe("root middleware", () => {
  it("installs the db session for downstream and closes it after next() resolves", async () => {
    const context = baseContext();
    let seen: DbSession | undefined;
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    const expected = new Response("ok");

    const next = vi.fn(async () => {
      // Downstream sees the session on the context.
      const session = context.get(dbSessionContext);
      seen = session;
      closeSpy = vi.spyOn(session, "close");
      return expected;
    });

    const response = await rootMiddleware(middlewareArgs(context), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(seen).toBeDefined();
    expect(response).toBe(expected);
    // The session is closed exactly once, after the response is produced. It was
    // never used, so this close is a no-op, but the middleware must still call it.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("still closes the session when next() throws", async () => {
    const context = baseContext();
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;

    const next = vi.fn(async () => {
      const session = context.get(dbSessionContext);
      closeSpy = vi.spyOn(session, "close");
      throw new Error("downstream boom");
    });

    await expect(
      rootMiddleware(middlewareArgs(context), next),
    ).rejects.toThrow("downstream boom");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
