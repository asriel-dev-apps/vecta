/**
 * OIDC runtime configuration, read straight from the Worker environment — no
 * discovery fetch (ADR 0012 §Decision 4). The public endpoints/ids arrive as
 * wrangler `vars`; `OIDC_CLIENT_SECRET` arrives as a Worker secret.
 *
 * The token audience is the client id (`OIDC_CLIENT_ID`); there is deliberately
 * no separate `OIDC_AUDIENCE` var on this surface.
 */
export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly jwksUrl: string;
  readonly redirectUri: string;
  readonly authEndpoint: string;
  readonly tokenEndpoint: string;
}

export function oidcConfigFromEnv(env: Env): OidcConfig {
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    jwksUrl: env.OIDC_JWKS_URL,
    redirectUri: env.OIDC_REDIRECT_URI,
    authEndpoint: env.OIDC_AUTH_ENDPOINT,
    tokenEndpoint: env.OIDC_TOKEN_ENDPOINT,
  };
}
