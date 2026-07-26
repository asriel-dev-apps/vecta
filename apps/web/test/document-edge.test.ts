// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  documentPathname,
  isRateLimitedDocumentPath,
  MAX_DOCUMENT_BODY_BYTES,
  withDocumentEdge,
} from "~/server/document-edge.server";
import { MAX_REQUEST_BODY_BYTES } from "~/server/api/edge-security";
import { fakeEnv } from "./helpers";

/**
 * M1 of the 2026-07-27 ASVS L2 scan: the browser write path — the only entrance a
 * real user travels — had neither a body bound nor a rate limit, while `/api` and
 * `/mcp` had both.
 *
 * The limits here are NOT `/api`'s. They were measured against the real command
 * contract, and these tests pin the measurements, because the tempting change a
 * later reader will make is "why are these two numbers different, let's unify
 * them" — which in one direction is an outage and in the other is a widening.
 */

const OK = new Response("<!doctype html><p>ok", {
  headers: { "content-type": "text/html" },
});

function envWith(limitResult: boolean): Env {
  const env = fakeEnv({});
  (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
    limit: vi.fn(async () => ({ success: limitResult })),
  } as unknown as RateLimit;
  return env;
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("document body bound — sized to this surface, not copied from /api", () => {
  it("is 1 MiB, and deliberately NOT /api's 64 KiB", () => {
    // Measured 2026-07-27 against `CommandBatchSchema`: a full 1,000-command
    // sibling reorder serialises to 165 KiB and a realistic 1,000-task bulk add
    // to 620 KiB. At 64 KiB both would 413 — the "hardening" would have been an
    // outage on the app's main gesture.
    expect(MAX_DOCUMENT_BODY_BYTES).toBe(1024 * 1024);
    expect(MAX_REQUEST_BODY_BYTES).toBe(64 * 1024);
    expect(MAX_DOCUMENT_BODY_BYTES).toBeGreaterThan(620 * 1024);
  });

  it("lets a realistic 1,000-command batch through", async () => {
    const batch = JSON.stringify({
      expectedRevision: "12345",
      commands: Array.from({ length: 1000 }, (_, index) => ({
        command: {
          type: "task.update",
          taskId: "018f2c3d-0000-7000-8000-000000000001",
          changes: { sortOrder: index * 100 },
        },
        idempotencyKey: `key-${index}`,
      })),
    });
    // Control: the fixture must actually be the size the decision was made about,
    // or this test passes for the wrong reason.
    expect(batch.length).toBeGreaterThan(100 * 1024);
    expect(batch.length).toBeLessThan(MAX_DOCUMENT_BODY_BYTES);

    const response = await withDocumentEdge(post("/projects/p1/wbs", batch), envWith(true), () =>
      Promise.resolve(OK.clone()),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a body over the bound with a 413 the browser can render", async () => {
    const oversized = "x".repeat(MAX_DOCUMENT_BODY_BYTES + 1);
    const rendered = vi.fn(() => Promise.resolve(OK.clone()));

    const response = await withDocumentEdge(
      post("/projects/p1/wbs", oversized),
      envWith(true),
      rendered,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).not.toContain('{"error"');
    // The point of a body bound is that the payload is never parsed or handled.
    expect(rendered).not.toHaveBeenCalled();
  });

  it("refuses on a lying content-length before reading a single byte", async () => {
    const response = await withDocumentEdge(
      post("/projects/p1/wbs", "{}", { "content-length": String(MAX_DOCUMENT_BODY_BYTES + 1) }),
      envWith(true),
      () => Promise.resolve(OK.clone()),
    );
    expect(response.status).toBe(413);
  });

  it("passes a bodyless GET straight through", async () => {
    const response = await withDocumentEdge(
      new Request("https://app.test/projects/p1/wbs"),
      envWith(true),
      () => Promise.resolve(OK.clone()),
    );
    expect(response.status).toBe(200);
  });
});

describe("document rate limit — applied where the legitimate rate is near zero", () => {
  it("covers the three unauthenticated routes and their single-fetch twins", () => {
    for (const path of ["/login", "/auth/callback", "/logout"]) {
      expect(isRateLimitedDocumentPath(path)).toBe(true);
      // Single fetch asks for `<path>.data`; if that were a different bucket the
      // limit would be doubled by asking for the data request instead.
      expect(isRateLimitedDocumentPath(`${path}.data`)).toBe(true);
    }
  });

  it("does NOT cover the authenticated write path, and that is deliberate", () => {
    // `PRE_AUTH_RATE_LIMIT` keys on `cf-connecting-ip`, and an office is one IP.
    // 120 saves a minute shared across a building, against a save queue that
    // coalesces to one in-flight POST per tab, is a false-429 generator — and a
    // false 429 here rolls the user's optimistic edit back.
    expect(isRateLimitedDocumentPath("/projects/p1/wbs")).toBe(false);
    expect(isRateLimitedDocumentPath("/projects/p1/wbs.data")).toBe(false);
    expect(isRateLimitedDocumentPath("/projects/p1/assistant")).toBe(false);
    expect(isRateLimitedDocumentPath("/")).toBe(false);
  });

  it("answers 429 with Retry-After when the limiter refuses", async () => {
    const rendered = vi.fn(() => Promise.resolve(OK.clone()));
    const response = await withDocumentEdge(post("/auth/callback", "{}"), envWith(false), rendered);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("content-type")).toContain("text/html");
    // A refused callback must not reach the OIDC token exchange — that outbound
    // Google request is the cost the limit exists to stop.
    expect(rendered).not.toHaveBeenCalled();
  });

  it("never calls the limiter for a path outside the set", async () => {
    // The spy is held directly rather than read back off the binding: reaching
    // through `env.PRE_AUTH_RATE_LIMIT.limit` detaches a method from its object,
    // which `@typescript-eslint/unbound-method` rejects under the type-aware
    // config.
    const limit = vi.fn(async () => ({ success: false }));
    const env = fakeEnv({});
    (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
      limit,
    } as unknown as RateLimit;

    const response = await withDocumentEdge(post("/projects/p1/wbs", "{}"), env, () =>
      Promise.resolve(OK.clone()),
    );

    expect(response.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it("strips only a trailing .data, not a path that merely contains it", () => {
    expect(documentPathname("/login.data")).toBe("/login");
    expect(documentPathname("/login")).toBe("/login");
    expect(documentPathname("/.data/login")).toBe("/.data/login");
  });
});

describe("document edge — correlation and failure", () => {
  it("stamps a request id the renderer can read and the client can see", async () => {
    let seen: string | null = null;
    const response = await withDocumentEdge(
      new Request("https://app.test/login"),
      envWith(true),
      (correlated) => {
        seen = correlated.headers.get("x-request-id");
        return Promise.resolve(OK.clone());
      },
    );

    expect(seen).toMatch(/^[0-9a-f-]{36}$/u);
    // The same id on the way out, so a log line and a user's screenshot can be
    // joined up. This is the field `entry.server.tsx`'s `handleError` logs.
    expect(response.headers.get("X-Request-Id")).toBe(seen);
  });

  it("turns an escaped exception into a 500 whose log carries the NAME only", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const secret = "npg_TESTONLYnotarealsecret";

    const response = await withDocumentEdge(
      new Request("https://app.test/projects/p1/wbs"),
      envWith(true),
      () => {
        throw new Error(`Connection string: postgresql://u:${secret}@h/db`);
      },
    );
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(lines.join("\n")).not.toContain(secret);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      event: "document_edge_error",
      status: 500,
      errorName: "Error",
    });
  });

  it("preserves the rendered response's own headers", async () => {
    const response = await withDocumentEdge(
      new Request("https://app.test/login"),
      envWith(true),
      () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "/projects", "set-cookie": "s=1; HttpOnly" },
          }),
        ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/projects");
    expect(response.headers.get("set-cookie")).toBe("s=1; HttpOnly");
  });
});
