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
/** Loopback hosts, where Docker Postgres offers no TLS to negotiate. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Decide TLS from the parsed **hostname**, never from the connection string.
 *
 * This used to be `url.includes("localhost")`, which matched the whole string —
 * so a password, username, database name or query parameter containing
 * "localhost" silently disabled encryption against a remote production host.
 * It failed open, in the one direction that loses confidentiality rather than
 * availability, and nothing would have reported it.
 *
 * Exported so the decision is testable without constructing a pool. Throws on
 * a malformed URL, which surfaces a bad `DATABASE_URL` here rather than on the
 * first query several layers away.
 */
export function resolveSsl(url: string): false | { rejectUnauthorized: true } {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid connection URL. Expected something like ` +
        `postgres://user:password@localhost:5434/opspilot`,
    );
  }

  // URL keeps IPv6 literals bracketed; the set stores them bare. The case fold
  // is not redundant: `URL` lowercases hostnames only for *special* schemes,
  // and `postgres:` is not one, so `@LOCALHOST/` arrives cased exactly as typed.
  // `toLowerCase`, never the locale-sensitive `toLocaleLowerCase`. Folding
  // cannot fail open: only case variants of a loopback name fold onto one.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: true };
}

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
    ssl: resolveSsl(url),
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
