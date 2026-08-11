import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let cached: Db | undefined;
let cachedPool: Pool | undefined;

/**
 * Lazily construct the database handle.
 *
 * This is deliberately a function rather than a module-scope `export const db`.
 * A top-level `new Pool(process.env.DATABASE_URL!)` makes every module that
 * transitively imports the schema explode at *import* time when the variable is
 * unset — which takes down `vitest`, `tsc --noEmit`, and CI for reasons that
 * have nothing to do with the code under test. The policy engine and tool
 * registry are pure by design and never call this.
 *
 * One driver for both targets: `pg` speaks the standard Postgres wire protocol,
 * which Neon supports on its pooled (`-pooler`) endpoint. If serverless
 * connection limits bite during Day 8 deploy hardening, swap to
 * `drizzle-orm/neon-http`; nothing above this function needs to change.
 */
export function getDb(): Db {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Run `cp .env.example .env.local`, then " +
        "`npm run db:up` for a local Postgres on port 5434.",
    );
  }

  cachedPool = new Pool({
    connectionString: url,
    // Neon requires TLS; local Docker Postgres does not offer it.
    ssl: url.includes("localhost") || url.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: true },
  });

  cached = drizzle(cachedPool, { schema });
  return cached;
}

/** Close the pool. Used by scripts (seed, cron) so the process can exit. */
export async function closeDb(): Promise<void> {
  await cachedPool?.end();
  cachedPool = undefined;
  cached = undefined;
}
