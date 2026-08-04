// @vitest-environment node

import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbSession } from "~/server/db-session.server";
import { runCommandAction } from "~/server/project/command-action.server";
import {
  dbSessionContext,
  principalContext,
  projectMembershipContext,
} from "~/server/context.server";
import type { AuthenticatedPrincipal } from "~/server/auth/principal-directory.server";

/**
 * ASVS scan M3: `write_denied` — the one 403 the browser surface produces, and
 * the only place `operations/monitoring-and-alerts.md`'s "changes in 401/403"
 * signal was even nominally available on this surface. It was not being recorded.
 *
 * A VIEWER is refused by `createProjectCommandAuthorizer` BEFORE any command
 * executes (the batch is all-or-none on the authorization gate), so this runs
 * with no database: the fake session's handle is never dereferenced.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

const PRINCIPAL: AuthenticatedPrincipal = {
  principal: {
    id: "principal-1",
    issuer: "https://identity.example.invalid/",
    subject: "subject-1",
    displayName: "Test User",
    type: "HUMAN",
  },
  tenantMemberships: [{ tenantId: TENANT_ID, role: "MEMBER" }],
  projectMemberships: [{ tenantId: TENANT_ID, projectId: PROJECT_ID, role: "VIEWER" }],
};

/**
 * An inert handle. `applyCommands` builds the unit of work — and therefore calls
 * `session.database()` — before it authorizes anything, so this IS reached; what
 * must not happen is a statement being issued, which the fake guarantees by
 * having no query surface at all. `read()` is never touched on the write path.
 */
const fakeSession = () =>
  ({
    database: vi.fn(() => ({})),
    read: () => {
      throw new Error("unexpected read on a write action");
    },
    close: async () => {},
  }) as unknown as DbSession;

function contextFor(projectRole: "VIEWER" | "EDITOR"): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(principalContext, async () => PRINCIPAL);
  context.set(projectMembershipContext, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    projectRole,
    tenantRole: "MEMBER",
  });
  context.set(dbSessionContext, fakeSession());
  return context;
}

function saveRequest(): Request {
  return new Request(`https://vecta.example.com/projects/${PROJECT_ID}/wbs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-write" },
    body: JSON.stringify({
      expectedRevision: "5",
      commands: [
        {
          idempotencyKey: "k-1",
          command: { type: "task.update", taskId: TASK_ID, changes: { sortOrder: 3 } },
        },
      ],
    }),
  });
}

function captureWarn(): { readonly lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCommandAction — write_denied", () => {
  it("records the denial with the role the principal actually held", async () => {
    const captured = captureWarn();
    const result = await runCommandAction(
      { request: saveRequest(), context: contextFor("VIEWER") },
      "wbs-save",
    );
    captured.restore();

    // The response contract is unchanged — the client's save queue still reads a
    // typed 403 and rolls back.
    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ ok: false, code: "FORBIDDEN" });

    expect(captured.lines).toHaveLength(1);
    expect(JSON.parse(captured.lines[0] ?? "")).toEqual({
      event: "security_event",
      kind: "write_denied",
      reason: "insufficient_role",
      requestId: "req-write",
      method: "POST",
      route: "/projects/:id/wbs",
      status: 403,
      principalId: "principal-1",
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      // The interesting field: a VIEWER whose client is issuing writes is a UI
      // defect or an attempted bypass, and the 403 alone cannot say which.
      projectRole: "VIEWER",
    });
  });

  it("CONTROL: a malformed batch is refused WITHOUT a security event", async () => {
    // 422 is unprocessable input, not a denial. If this logged too, a dashboard
    // counting `write_denied` would be counting client bugs.
    const request = new Request(`https://vecta.example.com/projects/${PROJECT_ID}/wbs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: "5", commands: [{ nonsense: true }] }),
    });

    const captured = captureWarn();
    const result = await runCommandAction({ request, context: contextFor("VIEWER") }, "wbs-save");
    captured.restore();

    expect(result.init?.status).toBe(422);
    expect(captured.lines).toEqual([]);
  });
});
