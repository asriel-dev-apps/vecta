import {
  principals,
  projectMemberships,
  tenantMemberships,
  type NeonHttpReadDatabase,
} from "@vecta/persistence";
import { describe, expect, it } from "vitest";
import { createNeonPrincipalDirectory } from "~/server/auth/principal-directory.neon.server";
import type { DbSession } from "~/server/db-session.server";

// The principal is resolved on EVERY authenticated request, so `loadPrincipal`
// sends its three reads as one `db.batch(...)`. These tests pin the two things
// that batching can get wrong and that no type would catch: that it really is
// ONE round trip over the three expected tables, and that the results are
// destructured back in the order they were issued.

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

const PRINCIPAL_ROW = {
  id: PRINCIPAL_ID,
  issuer: "https://accounts.example.invalid",
  subject: "sub-1",
  displayName: "Member 01",
  type: "HUMAN" as const,
};
const TENANT_ROWS = [{ tenantId: TENANT_ID, role: "ADMIN" as const }];
const PROJECT_ROWS = [
  { tenantId: TENANT_ID, projectId: PROJECT_ID, role: "EDITOR" as const },
];

/** A query stub that records the table it was built against. */
function queryStub() {
  const node = {
    table: undefined as unknown,
    from(table: unknown) {
      node.table = table;
      return node;
    },
    where: () => node,
    limit: () => node,
  };
  return node;
}

function fakeReadSession(batchResults: readonly unknown[]) {
  const batches: (readonly { table: unknown }[])[] = [];
  const database = {
    select: () => queryStub(),
    batch(queries: readonly { table: unknown }[]) {
      batches.push(queries);
      return Promise.resolve(batchResults);
    },
  };
  const session = {
    read: () => database as unknown as NeonHttpReadDatabase,
    database: () => {
      throw new Error("the read path must never open the write pool");
    },
    close: async () => undefined,
    timings: () => ({ readCount: 0, readMs: 0, writeCount: 0, writeMs: 0 }),
  } satisfies DbSession;
  return { session, batches };
}

describe("createNeonPrincipalDirectory.loadPrincipal", () => {
  it("reads the principal and both memberships in ONE batch, in table order", async () => {
    const { session, batches } = fakeReadSession([
      [PRINCIPAL_ROW],
      TENANT_ROWS,
      PROJECT_ROWS,
    ]);

    const resolved = await createNeonPrincipalDirectory(session).loadPrincipal(
      PRINCIPAL_ID,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((query) => query.table)).toEqual([
      principals,
      tenantMemberships,
      projectMemberships,
    ]);
    // The destructure must line up with the order the queries went out in.
    expect(resolved).toEqual({
      principal: PRINCIPAL_ROW,
      tenantMemberships: TENANT_ROWS,
      projectMemberships: PROJECT_ROWS,
    });
  });

  it("resolves null when the principal row is absent, membership rows notwithstanding", async () => {
    const { session } = fakeReadSession([[], TENANT_ROWS, PROJECT_ROWS]);

    await expect(
      createNeonPrincipalDirectory(session).loadPrincipal(PRINCIPAL_ID),
    ).resolves.toBeNull();
  });
});
