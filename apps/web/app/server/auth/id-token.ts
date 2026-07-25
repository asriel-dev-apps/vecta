import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * ID-token verification for the OIDC authorization-code flow, ported from
 * `apps/web/src/oidc-auth.ts` (same JWKS-factory seam so it is testable without
 * a network). Verification is stricter than the Bearer path: the algorithm is
 * pinned to RS256 (Google's ID-token signing alg), and the request `nonce` must
 * match the `nonce` claim to bind the token to this login attempt.
 */

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  /** Verified email, present only when the provider attests `email_verified`. */
  readonly email?: string;
}

export interface IdTokenVerifyParams {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly nonce: string;
}

export type JwksFactory = (jwksUrl: URL) => JWTVerifyGetKey;

export interface IdTokenVerifier {
  verify(idToken: string, params: IdTokenVerifyParams): Promise<VerifiedIdentity>;
}

/**
 * Build an ID-token verifier. The `jwksFactory` seam defaults to jose's
 * `createRemoteJWKSet` (built lazily on first use and cached per JWKS URL for
 * the life of the isolate, since `env` is not available at module scope). Tests
 * pass a `createLocalJWKSet`-backed factory over generated RS256 keys.
 */
export function createIdTokenVerifier(
  jwksFactory: JwksFactory = (url) => createRemoteJWKSet(url),
): IdTokenVerifier {
  const jwksByUrl = new Map<string, JWTVerifyGetKey>();
  return {
    async verify(idToken, params) {
      const jwksUrl = new URL(params.jwksUrl);
      let jwks = jwksByUrl.get(jwksUrl.href);
      if (jwks === undefined) {
        jwks = jwksFactory(jwksUrl);
        jwksByUrl.set(jwksUrl.href, jwks);
      }
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: params.issuer,
        audience: params.audience,
        algorithms: ["RS256"],
        clockTolerance: 5,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("ID token subject is invalid");
      }
      if (typeof payload.nonce !== "string" || payload.nonce !== params.nonce) {
        throw new Error("ID token nonce mismatch");
      }
      const email =
        payload.email_verified === true &&
        typeof payload.email === "string" &&
        payload.email.length > 0
          ? payload.email.toLowerCase()
          : undefined;
      return {
        issuer: params.issuer,
        subject: payload.sub,
        ...(email === undefined ? {} : { email }),
      };
    },
  };
}
