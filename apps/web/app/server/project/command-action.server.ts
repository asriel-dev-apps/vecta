import { data, type RouterContextProvider } from "react-router";
import { applyCommands } from "./apply-commands.server";
import { requireProjectMembership } from "./project-access";
import { requirePrincipal } from "../auth/require-principal";
import { dbSessionContext } from "../context";
import { writeSecurityEvent } from "../security-log.server";
import { CommandBatchSchema, toCommand } from "~/wbs/project-command-contract";

/**
 * ADR 0012 Step 4c — the ONE command-action body, shared by the WBS route and
 * every master route. The batch pipeline (parse the JSON body → validate against
 * the command contract → authorize the session principal → execute with
 * optimistic concurrency → map the outcome to a status) is command-agnostic
 * (`applyCommands` is), so factoring it out of `project.wbs.tsx` lets masters,
 * members, and templates reuse it verbatim. The ONLY per-route difference is the
 * success `kind` discriminant, so `shouldRevalidate` can suppress the
 * no-re-settle re-read for THIS route's own save without a sibling's `{ ok: true }`
 * ever masking it.
 *
 * Conflicts and denials are RETURNED (not thrown) so the client's optimistic
 * pipeline can react: `VERSION_CONFLICT` (409) triggers the resync/adopt path, an
 * authz failure (403) surfaces as a rollback. bigint revisions cross the boundary
 * as strings. The action never logs the token or the command payloads.
 */

/** The self-save success discriminants (also the `shouldRevalidate` skip set). */
export type SaveKind = "wbs-save" | "masters-save" | "members-save" | "templates-save";

export interface CommandActionArgs {
  readonly request: Request;
  readonly context: Readonly<RouterContextProvider>;
}

export async function runCommandAction<K extends SaveKind>(
  { request, context }: CommandActionArgs,
  kind: K,
) {
  const principal = await requirePrincipal(context);
  // Only the membership is needed to authorize and scope the batch, and the gate
  // already resolved it from the memoised principal — so the write path reads it
  // synchronously and never fetches the project row it would only discard.
  const membership = requireProjectMembership(context);
  const session = context.get(dbSessionContext);

  // A malformed JSON body must not 500: JSON syntax errors → 400 (the request is
  // not even parseable), a well-formed body that violates the command contract
  // (shape, caps, or a duplicate idempotency key) → 422 (unprocessable entity).
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return data(
      { ok: false as const, code: "INVALID" as const, message: "Request body is not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = CommandBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return data(
      { ok: false as const, code: "INVALID" as const, message: "Command batch is malformed" },
      { status: 422 },
    );
  }

  const result = await applyCommands({
    session,
    actor: {
      principalId: principal.principal.id,
      principalType: principal.principal.type,
    },
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    projectRole: membership.projectRole,
    commands: parsed.data.commands.map((entry) => ({
      command: toCommand(entry.command),
      idempotencyKey: entry.idempotencyKey,
    })),
    expectedRevision: BigInt(parsed.data.expectedRevision),
  });

  if (result.ok) {
    // The `kind` discriminant is what `shouldRevalidate` keys the no-re-settle
    // skip on, so a sibling action's own `{ ok: true }` can't suppress this
    // loader's revalidation. Default status 200 ⇒ a successful self-save skips the
    // re-read.
    return data({ ok: true as const, kind, revision: result.revision.toString() });
  }
  if (result.code === "VERSION_CONFLICT") {
    // 409 forces `shouldRevalidate` to re-run the loader so the client adopts the
    // server's current state, never rolls back (also the partial-commit resync).
    return data(
      {
        ok: false as const,
        code: "VERSION_CONFLICT" as const,
        actualRevision: result.actualRevision.toString(),
      },
      { status: 409 },
    );
  }
  if (result.code === "FORBIDDEN") {
    // ASVS scan M3: the one 403 on the browser surface. Recorded with the role
    // the principal actually held, because the interesting case is a VIEWER
    // whose client is issuing writes — a UI defect and an attempted bypass look
    // identical from the response alone.
    writeSecurityEvent({
      kind: "write_denied",
      reason: "insufficient_role",
      status: 403,
      request,
      params: { id: membership.projectId },
      principalId: principal.principal.id,
      tenantId: membership.tenantId,
      projectId: membership.projectId,
      projectRole: membership.projectRole,
    });
    return data({ ok: false as const, code: "FORBIDDEN" as const }, { status: 403 });
  }
  if (result.code === "NOT_FOUND") {
    return data({ ok: false as const, code: "NOT_FOUND" as const }, { status: 404 });
  }
  return data(
    { ok: false as const, code: "INVALID" as const, message: result.message },
    { status: 422 },
  );
}
