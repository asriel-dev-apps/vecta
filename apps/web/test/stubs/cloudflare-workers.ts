/**
 * Minimal stand-in for the `cloudflare:workers` runtime module (ADR 0012 Step
 * 5b). The `agents` package — imported by the stateless `/mcp` handler — pulls
 * `RpcTarget` + `exports` from `cloudflare:workers` at module load, a specifier
 * vitest's Node loader cannot resolve. Under the production build the real
 * workerd module is used; this stub only satisfies the module-load references so
 * the MCP tests run in Node.
 *
 * The `/mcp` surface is stateless (a fresh `McpServer` + `WorkerTransport` per
 * request, no Durable Object / Agent / Workflow), so these base classes and the
 * `exports` object are never exercised at runtime by any tool path.
 */
export class RpcTarget {}
export class WorkflowEntrypoint {}
export class DurableObject {}
export class WorkerEntrypoint {}
export const exports = {} as Record<string, unknown>;
export const env = {} as Record<string, unknown>;
