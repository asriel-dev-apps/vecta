import { randomUUID } from "node:crypto";
import type { Client } from "pg";

/**
 * Run `work` in a transaction that records a real WBS revision.
 *
 * Migration 0014 commits a content write only when the marker `<w>:<r>` is the
 * WBS's revision and this transaction inserted `wbs_change` at r. The passed
 * revision is ignored: the next revision is one past the row's current value,
 * so a caller that used to pass `0` still writes a record instead of a bare marker.
 */
/** An empty format-1 record. Enough for migration 0014; not a diff of the statement. */
export async function insertEmptyWbsChange(
  client: Client,
  tenantId: string,
  wbsId: string,
  revision: number | bigint | string,
): Promise<void> {
  await client.query(
    `insert into wbs_change
       (tenant_id, wbs_id, revision, operation_id, actor_type, actor_id, format, change)
     values ($1, $2, $3, $4, 'SYSTEM', 'wbs-write-marker', 1, '{"format":1,"changes":[]}'::jsonb)`,
    [tenantId, wbsId, revision.toString(), `marker-${randomUUID()}`],
  );
}

export async function withWbsWriteMarker<T>(
  client: Client,
  wbsId: string,
  revision: number | bigint | string,
  work: () => Promise<T>,
): Promise<T> {
  void revision;
  await client.query("begin");
  try {
    const current = await client.query<{ tenant_id: string; revision: string }>(
      "select tenant_id, revision::text as revision from wbs where id = $1 for update",
      [wbsId],
    );
    const row = current.rows[0];
    if (row === undefined) throw new Error(`wbs ${wbsId} was not found`);
    const next = (BigInt(row.revision) + 1n).toString();
    await client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:${next}`]);
    await client.query("update wbs set revision = revision + 1 where id = $1", [wbsId]);
    await insertEmptyWbsChange(client, row.tenant_id, wbsId, next);
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The original statement error is the one the caller asserted.
    }
    throw error;
  }
}
