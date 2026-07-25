/**
 * Minimal stand-in for the `cloudflare:email` runtime module (ADR 0012 Step 5b).
 * The `agents` package (imported by the stateless `/mcp` handler) pulls
 * `EmailMessage` from `cloudflare:email` at module load — a specifier vitest's
 * Node loader cannot resolve. The `/mcp` surface never sends email, so this stub
 * only satisfies the module-load reference. The production build uses the real
 * workerd module.
 */
export class EmailMessage {}
