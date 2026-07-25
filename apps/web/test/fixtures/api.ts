import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import type {
  AuthenticatedIdentity,
  ProjectAccessGrant,
  ProjectAccessGrantRequest,
  ProjectAccessGrantResolver,
  ProjectCommandUnitOfWork,
  ProjectState,
} from "@vecta/application";
import type { AccessibleProject, PersistenceDatabase } from "@vecta/persistence";
import {
  createApiApp,
  type ApiDeps,
  type ApiPersistence,
  type ApiProjectListReader,
  type ApiWorkspaceLoader,
} from "~/server/api/app";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "~/server/api/oidc-auth";
import type { DbSession } from "~/server/db-session.server";
import { fakeEnv } from "../helpers";

/**
 * Test scaffolding for the token `/api` surface (ADR 0012 Step 5a). A local
 * RS256 key + JWKS so Bearer verification runs with `createLocalJWKSet` (no
 * network), an access-token signer, and in-memory persistence fakes so the whole
 * surface is exercised with no Neon connection.
 */

// Match the wrangler `vars`: the `/api` audience is OIDC_CLIENT_ID.
export const API_ISSUER = "https://accounts.google.example.invalid";
export const API_AUDIENCE = "vecta-web-local.apps.googleusercontent.invalid";
export const API_JWKS_URL = "https://www.googleapis.example.invalid/oauth2/v3/certs";

export const TENANT_ID = "11111111-1111-4111-8111-111111111111";

export interface ApiTestKeys {
  readonly privateKey: CryptoKey;
  readonly publicJwks: { keys: Array<Record<string, unknown>> };
}

export async function generateApiKeys(kid = "test-rs256"): Promise<ApiTestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwks: { keys: [{ ...jwk, alg: "RS256", use: "sig", kid }] } };
}

export interface AccessTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  scope?: string;
  email?: string;
  email_verified?: boolean;
  /** Epoch seconds. */
  exp?: number;
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: AccessTokenClaims = {},
  options: { alg?: string; kid?: string } = {},
): Promise<string> {
  const { alg = "RS256", kid = "test-rs256" } = options;
  const { exp, ...rest } = {
    iss: API_ISSUER,
    aud: API_AUDIENCE,
    sub: "agent-or-human-sub",
    ...claims,
  };
  const signer = new SignJWT(rest as Record<string, unknown>)
    .setProtectedHeader({ alg, kid })
    .setIssuedAt();
  signer.setExpirationTime(exp ?? Math.floor(Date.now() / 1000) + 3600);
  return signer.sign(privateKey);
}

/** A production-shaped `authenticate` dep: jose Bearer verify over a local JWKS. */
export function realAuthenticate(keys: ApiTestKeys): ApiDeps["authenticate"] {
  const authenticator = createOidcBearerAuthenticator(
    createJoseOidcTokenVerifier(() => createLocalJWKSet(keys.publicJwks)),
  );
  return (request) =>
    authenticator.authenticate(request, {
      issuer: API_ISSUER,
      audience: API_AUDIENCE,
      jwksUrl: API_JWKS_URL,
    });
}

/** An `authenticate` dep that returns a fixed identity (skips token verification). */
export function fixedAuthenticate(identity: AuthenticatedIdentity): ApiDeps["authenticate"] {
  return () => Promise.resolve(identity);
}

export function fakeSession(overrides: Partial<DbSession> = {}): DbSession {
  return {
    read: () => ({}) as never,
    database: () => ({}) as never,
    close: async () => undefined,
    ...overrides,
  };
}

/** A grant resolver returning `grant` for any request, recording the last identity. */
export function fakeGrantResolver(
  grant: ProjectAccessGrant | null,
): ProjectAccessGrantResolver & { lastRequest?: ProjectAccessGrantRequest } {
  const resolver: ProjectAccessGrantResolver & { lastRequest?: ProjectAccessGrantRequest } = {
    async resolve(request) {
      resolver.lastRequest = request;
      return grant;
    },
  };
  return resolver;
}

export function fakeWorkspaceLoader(
  workspace: { readonly revision: bigint; readonly current: ProjectState } | null,
): ApiWorkspaceLoader {
  return { load: async () => workspace };
}

/** An identity-keyed list reader over a fixed set, recording the last identity. */
export function fakeListReader(
  projects: readonly AccessibleProject[],
): ApiProjectListReader & { lastIdentity?: AuthenticatedIdentity } {
  const reader: ApiProjectListReader & { lastIdentity?: AuthenticatedIdentity } = {
    async listForIdentity(identity) {
      reader.lastIdentity = identity;
      return projects;
    },
  };
  return reader;
}

export interface ApiDepsOverrides {
  authenticate?: ApiDeps["authenticate"];
  grantResolver?: ProjectAccessGrantResolver;
  workspace?: ApiWorkspaceLoader;
  projects?: readonly AccessibleProject[];
  unitOfWorkFor?: (database: PersistenceDatabase) => ProjectCommandUnitOfWork;
  createSession?: (env: Env) => DbSession;
}

/**
 * Build the injectable {@link ApiDeps} + the fakes a test can assert on, wiring
 * the given overrides. Shared by both the `/api` app and the `/mcp` handler
 * fixtures so the two mouths are exercised against the SAME persistence/auth/
 * session seams (ADR 0012 Step 5).
 */
export function buildApiDeps(overrides: ApiDepsOverrides = {}) {
  const session = fakeSession();
  const grantResolver = overrides.grantResolver ?? fakeGrantResolver(null);
  const workspace = overrides.workspace ?? fakeWorkspaceLoader(null);
  const listReader = fakeListReader(overrides.projects ?? []);
  const persistence: ApiPersistence = {
    grantResolver: () => grantResolver,
    workspace: () => workspace,
    listReader: () => listReader,
    ...(overrides.unitOfWorkFor === undefined
      ? {}
      : { unitOfWorkFor: overrides.unitOfWorkFor }),
  };
  const deps: ApiDeps = {
    authenticate:
      overrides.authenticate ??
      fixedAuthenticate({ issuer: API_ISSUER, subject: "sub-1", scopes: [] }),
    createSession: overrides.createSession ?? (() => session),
    persistence,
  };
  return { deps, session, grantResolver, listReader };
}

/** Build an app + deps for a test, wiring the given fakes. */
export function buildApiApp(overrides: ApiDepsOverrides = {}) {
  const built = buildApiDeps(overrides);
  return { app: createApiApp(built.deps), ...built };
}

export function apiEnv(): Env {
  return fakeEnv({
    OIDC_ISSUER: API_ISSUER,
    OIDC_CLIENT_ID: API_AUDIENCE,
    OIDC_JWKS_URL: API_JWKS_URL,
    DATABASE_URL: "postgres://user:pass@db.example.invalid/vecta",
  });
}
