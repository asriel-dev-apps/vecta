// @vitest-environment node

import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DbSession } from "~/server/db-session.server";
import {
  MAX_CSV_CHARACTERS,
  runTimesheetAction,
} from "~/server/project/timesheet-action.server";
import {
  dbSessionContext,
  principalContext,
  projectMembershipContext,
} from "~/server/context.server";
import type { AuthenticatedPrincipal } from "~/server/auth/principal-directory.server";

/**
 * The timesheet action's two guards, both added after review (2026-08-06).
 *
 * Neither is about the import's correctness — they are about what the endpoint
 * will agree to DO before it knows anything:
 *
 *   * a VIEWER could run `preview`, which parses a whole file against the
 *     PRIVILEGED state. The role check lived inside `applyCommands`, which only
 *     the `import` intent reaches, so a read-only role could spend the Worker's
 *     budget on demand. Design 0011 §6.1 scopes the feature to OWNER/EDITOR.
 *   * the request body had no ceiling. The 2,000-row cap only fires after the CSV
 *     reader has walked the text character by character, so it is no defence
 *     against one enormous field, and this runs in a Worker with 128 MB.
 *
 * Both are checked BEFORE the workspace is loaded, so the fake session below is
 * never dereferenced — which is also the assertion that the order is right.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

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

/** Any use at all is a failure: both guards must answer before the database. */
const fakeSession = () =>
  ({
    database: vi.fn(() => {
      throw new Error("the action reached the database before its guards");
    }),
    read: () => {
      throw new Error("the action read the workspace before its guards");
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

function request(body: unknown): Request {
  return new Request(`https://vecta.example.com/projects/${PROJECT_ID}/timesheet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CSV = "タスクNo,日付,メンバー,工数(時間)\n1,2026-08-03,Member 01,2\n";

describe("timesheet action guards", () => {
  it("REVIEW 2026-08-06: a VIEWER cannot even preview", async () => {
    const response = await runTimesheetAction({
      request: request({ intent: "preview", csv: CSV }),
      context: contextFor("VIEWER"),
    });
    expect(response.init?.status).toBe(403);
  });

  it("CONTROL (pair): an EDITOR gets past the role check", async () => {
    // Without this, "always 403" would pass the test above. The EDITOR request
    // gets further and dies in the fake session — which is the evidence that the
    // role check was NOT what stopped it.
    await expect(
      runTimesheetAction({
        request: request({ intent: "preview", csv: CSV }),
        context: contextFor("EDITOR"),
      }),
    ).rejects.toThrow();
  });

  it("REVIEW 2026-08-06: refuses a body larger than the ceiling, before parsing it", async () => {
    const huge = `タスクNo,日付,メンバー,工数(時間)\n1,2026-08-03,${"あ".repeat(MAX_CSV_CHARACTERS)},2\n`;
    const response = await runTimesheetAction({
      request: request({ intent: "preview", csv: huge }),
      context: contextFor("EDITOR"),
    });
    // 413, and it never reached the database — the fake would have thrown.
    expect(response.init?.status).toBe(413);
  });

  it("still refuses an unknown intent and an empty body", async () => {
    const badIntent = await runTimesheetAction({
      request: request({ intent: "delete-everything", csv: CSV }),
      context: contextFor("EDITOR"),
    });
    expect(badIntent.init?.status).toBe(422);
    const empty = await runTimesheetAction({
      request: request({ intent: "preview", csv: "   " }),
      context: contextFor("EDITOR"),
    });
    expect(empty.init?.status).toBe(422);
  });
});
