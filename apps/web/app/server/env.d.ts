// Worker secret bindings for auth (ADR 0012 §Decision 4). These are delivered
// as Worker secrets / local `.dev.vars`, not wrangler `vars`, so they are
// declared here by hand rather than generated into `worker-configuration.d.ts`
// (which only reflects `vars`). Declaring them here keeps typecheck reproducible
// without a local `.dev.vars` file present.
declare global {
  interface Env {
    /** OIDC client secret, used only server-side for the code→token exchange. */
    readonly OIDC_CLIENT_SECRET: string;
    /** Current signing secret for the session + oidc_tx cookies. */
    readonly SESSION_SECRET: string;
    /** Optional previous signing secret, accepted during a secret rotation. */
    readonly SESSION_SECRET_PREVIOUS?: string;
    /** Neon serverless Postgres connection string (principal resolution). */
    readonly DATABASE_URL?: string;
    /**
     * Which inference adapter serves the assistant (ADR 0013 Decision 12).
     * Absent = the initial provider the ADR names. A value no adapter implements
     * fails loudly rather than falling back — see `llm/select-model.server.ts`.
     * Declared here rather than as a wrangler `var` so no deployment value lands
     * in a tracked file; production sets it at Environment scope, if at all.
     */
    readonly ASSISTANT_MODEL_PROVIDER?: string;
  }
}

export {};
