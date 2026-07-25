import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import * as schema from "./schema.js";

export function createPersistenceDatabase(client: Client) {
  return drizzle(client, { schema });
}

export async function migratePersistenceDatabase(client: Client): Promise<void> {
  await migrate(createPersistenceDatabase(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
}

export * from "./schema.js";
export * from "./persistence-database.js";
export * from "./neon-database.js";
export * from "./neon-http-database.js";
export * from "./project-read-queries.js";
export * from "./demo-project.js";
export * from "./project-record.js";
export * from "./project-repository.js";
export * from "./project-command-unit-of-work.js";
export * from "./project-access.js";
export * from "./project-list.js";
export * from "./project-workspace.js";
