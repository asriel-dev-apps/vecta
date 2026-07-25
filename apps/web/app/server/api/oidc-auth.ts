import type { AuthenticatedIdentity } from "@vecta/application";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

/**
 * Framework-free OIDC Bearer verification for the token `/api` surface (ADR 0012
 * Step 5). Ported verbatim from `apps/web/src/oidc-auth.ts`: jose verifies the
 * access token against the provider JWKS and returns the verified
 * {@link AuthenticatedIdentity} (issuer, subject, scopes, verified email). The
 * `OidcJwksFactory` seam lets tests inject a local key set so verification runs
 * with no network. This module is React-Router-import-free.
 */

export interface OidcRuntimeConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface OidcTokenVerifier {
  verify(token: string, config: OidcRuntimeConfig): Promise<AuthenticatedIdentity>;
}

export interface OidcBearerAuthenticator {
  authenticate(request: Request, config: OidcRuntimeConfig): Promise<AuthenticatedIdentity>;
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication is required");
    this.name = "AuthenticationRequiredError";
  }
}

export type OidcJwksFactory = (url: URL) => JWTVerifyGetKey;

function validateOidcConfig(config: OidcRuntimeConfig): URL {
  const issuer = new URL(config.issuer);
  const jwksUrl = new URL(config.jwksUrl);
  const isLoopback = (url: URL) =>
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    config.audience.trim().length === 0 ||
    (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && isLoopback(issuer))) ||
    (jwksUrl.protocol !== "https:" && !(jwksUrl.protocol === "http:" && isLoopback(jwksUrl)))
  ) {
    throw new Error("OIDC configuration is invalid");
  }
  return jwksUrl;
}

export function createJoseOidcTokenVerifier(
  jwksFactory: OidcJwksFactory = (url) => createRemoteJWKSet(url),
): OidcTokenVerifier {
  const jwksByUrl = new Map<string, JWTVerifyGetKey>();
  return {
    async verify(token, config) {
      const jwksUrl = validateOidcConfig(config);
      let jwks = jwksByUrl.get(jwksUrl.href);
      if (jwks === undefined) {
        jwks = jwksFactory(jwksUrl);
        jwksByUrl.set(jwksUrl.href, jwks);
      }
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        // The issuer (Google) signs access tokens with RS256 only; pin to that one
        // algorithm to minimise the accepted-signature surface (ADR 0012 Step 5a).
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp"],
      });
      const exactAudience =
        payload.aud === config.audience ||
        (Array.isArray(payload.aud) &&
          payload.aud.length === 1 &&
          payload.aud[0] === config.audience);
      if (
        !exactAudience ||
        typeof payload.sub !== "string" ||
        payload.sub.length === 0 ||
        (typeof payload.scope !== "string" && payload.scope !== undefined)
      ) {
        throw new Error("OIDC access token claims are invalid");
      }
      const scopes =
        payload.scope === undefined
          ? []
          : [...new Set(payload.scope.split(" ").filter((scope) => scope.length > 0))];
      const email =
        payload.email_verified === true &&
        typeof payload.email === "string" &&
        payload.email.length > 0
          ? payload.email.toLowerCase()
          : undefined;
      return {
        issuer: config.issuer,
        subject: payload.sub,
        scopes,
        ...(email === undefined ? {} : { email }),
      };
    },
  };
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  const token = authorization?.slice("Bearer ".length) ?? "";
  if (
    authorization === null ||
    !authorization.startsWith("Bearer ") ||
    token.length > 16_384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new AuthenticationRequiredError();
  }
  return token;
}

export function createOidcBearerAuthenticator(
  verifier: OidcTokenVerifier,
): OidcBearerAuthenticator {
  return {
    async authenticate(request, config) {
      const token = bearerToken(request);
      try {
        return await verifier.verify(token, config);
      } catch {
        throw new AuthenticationRequiredError();
      }
    },
  };
}
