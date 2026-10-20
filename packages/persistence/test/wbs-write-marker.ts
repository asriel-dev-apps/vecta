import type { Client } from "pg";

/**
 * Run `work` in a transaction whose `vecta.wbs_write` marker names `wbsId`.
 * The content-table triggers refuse the write without it. Transaction-local,
 * the same `set_config(..., true)` the unit of work uses.
 */
export async function withWbsWriteMarker<T>(
  client: Client,
  wbsId: string,
  revision: number | bigint | string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('vecta.wbs_write', $1, true)", [
      `${wbsId}:${revision.toString()}`,
    ]);
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
