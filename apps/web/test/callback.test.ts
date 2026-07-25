import { createLocalJWKSet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  runCallback,
  type CallbackResult,
  type TokenExchanger,
} from "~/server/auth/flow.server";
import { createIdTokenVerifier } from "~/server/auth/id-token";
import type { PrincipalDirectory } from "~/server/auth/principal-directory";
import { serializeOidcTx } from "~/server/auth/oidc-tx.server";
import { readSession } from "~/server/auth/session.server";
import {
  type TestKeys,
  TEST_ISSUER,
  TEST_SUBJECT,
  clearsOidcTx,
  cookiePair,
  fakeEnv,
  generateRs256Keys,
  signIdToken,
  testOidcConfig,
  validIdTokenClaims,
} from "./helpers";

const env = fakeEnv();
const config = testOidcConfig();

const TX = {
  state: "state-xyz",
  nonce: "nonce-xyz",
  codeVerifier: "verifier-xyz",
  returnTo: "/projects/42",
};

const directory: PrincipalDirectory = {
  async findByIssuerSubject(issuer, subject) {
    if (issuer === TEST_ISSUER && subject === TEST_SUBJECT) {
      return {
        id: "principal-1",
        issuer,
        subject,
        displayName: "Test User",
        type: "HUMAN",
      };
    }
    return null;
  },
  async loadPrincipal() {
    return null;
  },
};

let keys: TestKeys;
beforeAll(async () => {
  keys = await generateRs256Keys();
});

function verifier() {
  return createIdTokenVerifier(() => createLocalJWKSet(keys.publicJwks));
}

function exchangerFor(idToken: string): TokenExchanger {
  return async () => ({ id_token: idToken });
}

async function callbackRequest(
  query: string,
  options: { withTx?: boolean } = {},
): Promise<Request> {
  const headers = new Headers();
  if (options.withTx !== false) {
    const setCookie = await serializeOidcTx(env, TX);
    headers.set("Cookie", cookiePair(setCookie));
  }
  return new Request(
    `https://app.example.invalid/auth/callback${query}`,
    { headers },
  );
}

async function run(
  request: Request,
  idToken: string,
  dir: PrincipalDirectory = directory,
): Promise<CallbackResult> {
  return runCallback({
    env,
    config,
    request,
    verifier: verifier(),
    directory: dir,
    exchangeCode: exchangerFor(idToken),
  });
}

describe("runCallback branches", () => {
  it("happy path: issues a session and redirects to the validated returnTo", async () => {
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const request = await callbackRequest("?code=auth-code&state=state-xyz");
    const result = await run(request, idToken);

    expect(result.type).toBe("redirect");
    if (result.type !== "redirect") return;
    expect(result.location).toBe("/projects/42");
    expect(clearsOidcTx(result.setCookies)).toBe(true);

    // The issued session cookie must read back to the resolved principal.
    const sessionCookie = result.setCookies.find((c) =>
      c.startsWith("__Host-vecta_session="),
    );
    expect(sessionCookie).toBeDefined();
    const session = await readSession(
      env,
      new Request("https://app.example.invalid/", {
        headers: { Cookie: cookiePair(sessionCookie ?? "") },
      }),
    );
    expect(session?.principalId).toBe("principal-1");
  });

  it("error query param → provider_error screen, tx cleared", async () => {
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const request = await callbackRequest("?error=access_denied");
    const result = await run(request, idToken);
    expect(result).toMatchObject({ type: "screen", screen: "provider_error" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
  });

  it("missing oidc_tx → retry screen (not a 500), tx cleared", async () => {
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const request = await callbackRequest("?code=auth-code&state=state-xyz", {
      withTx: false,
    });
    const result = await run(request, idToken);
    expect(result).toMatchObject({ type: "screen", screen: "retry" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
  });

  it("state mismatch → retry screen, tx cleared", async () => {
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const request = await callbackRequest("?code=auth-code&state=WRONG");
    const result = await run(request, idToken);
    expect(result).toMatchObject({ type: "screen", screen: "retry" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
  });

  it("nonce mismatch → provider_error screen (verification fails), tx cleared", async () => {
    const idToken = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ nonce: "not-the-tx-nonce" }),
    );
    const request = await callbackRequest("?code=auth-code&state=state-xyz");
    const result = await run(request, idToken);
    expect(result).toMatchObject({ type: "screen", screen: "provider_error" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
  });

  it("unknown principal → forbidden screen, tx cleared, no session issued", async () => {
    const idToken = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ sub: "unknown-subject" }),
    );
    const request = await callbackRequest("?code=auth-code&state=state-xyz");
    const result = await run(request, idToken);
    expect(result).toMatchObject({ type: "screen", screen: "forbidden" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
    expect(
      result.setCookies.some((c) => c.startsWith("__Host-vecta_session=")),
    ).toBe(false);
  });

  it("hostile stored tx.returnTo (//evil.com) is sanitized to / on consume", async () => {
    const setCookie = await serializeOidcTx(env, { ...TX, returnTo: "//evil.com" });
    const request = new Request(
      "https://app.example.invalid/auth/callback?code=auth-code&state=state-xyz",
      { headers: { Cookie: cookiePair(setCookie) } },
    );
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const result = await run(request, idToken);

    expect(result.type).toBe("redirect");
    if (result.type !== "redirect") return;
    expect(result.location).toBe("/");
  });

  it("directory failure → unavailable screen (not a 500), tx cleared", async () => {
    const idToken = await signIdToken(keys.privateKey, validIdTokenClaims());
    const request = await callbackRequest("?code=auth-code&state=state-xyz");
    const failingDirectory: PrincipalDirectory = {
      async findByIssuerSubject() {
        throw new Error("neon unreachable");
      },
      async loadPrincipal() {
        return null;
      },
    };
    const result = await run(request, idToken, failingDirectory);
    expect(result).toMatchObject({ type: "screen", screen: "unavailable" });
    expect(clearsOidcTx(result.setCookies)).toBe(true);
  });
});
