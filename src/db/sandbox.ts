/**
 * A workspace per visitor: plant it, keep it, sweep it.
 *
 * The public demo hands every visitor their own copy of Beacon Analytics,
 * seeded on arrival and deleted a day later. Two problems go away at once.
 * Nobody spends a stranger's budget or refunds a stranger's invoice, and the
 * fixture set stops decaying, because it is re-planted relative to *now*
 * rather than aged in place since whenever the last deploy ran the seed.
 *
 * Slug validation runs here as well as in the proxy. The proxy is the only
 * caller today, but this module deletes rows, and a delete that trusts its
 * argument because some other file usually checks it is one refactor away
 * from being wrong.
 */
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

import { isSandboxSlug, sandboxExpiry } from "@/lib/sandbox";

import type { DbOrTx } from "./runs";
import { workspaces } from "./schema";
import { seedWorkspace } from "./seed";

/** A sandbox, resolved. */
export interface SandboxWorkspace {
  workspaceId: string;
  /** When the cron sweep may delete it. Always in the future on return. */
  expiresAt: Date;
  /** True when this call planted the rows, false when it found them. */
  seeded: boolean;
}

/** Thrown for any slug that is not `sb_` plus 32 lower case hex characters. */
export class NotASandboxError extends Error {
  constructor(slug: string) {
    super(`${JSON.stringify(slug)} is not a sandbox slug`);
    this.name = "NotASandboxError";
  }
}

function requireSandboxSlug(slug: string): void {
  if (!isSandboxSlug(slug)) throw new NotASandboxError(slug);
}

/**
 * A row that can be handed back as it stands.
 *
 * A null `expiresAt` counts as unusable rather than as immortal. The durable
 * `demo` tenant has one, and a sandbox with one would never be swept and would
 * break the `Date` this module promises its callers, so the answer is to
 * re-seed under a real TTL.
 */
function isLive(
  row: { expiresAt: Date | null } | undefined,
  now: Date,
): row is { expiresAt: Date } {
  return row?.expiresAt != null && row.expiresAt > now;
}

async function readSandbox(db: DbOrTx, slug: string) {
  const [row] = await db
    .select({ id: workspaces.id, expiresAt: workspaces.expiresAt })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);

  return row;
}

/**
 * Resolve a slug to a live workspace, planting one if there is not one.
 *
 * Called on every page render and every API request, so the common case is a
 * single indexed select and no transaction at all. Only the seeding path pays
 * for the lock.
 *
 * **The race, and why the lock is advisory.** Two requests for the same fresh
 * slug arrive together: a browser fetching a page and its API call, or simply
 * a double click. Both selects find nothing, both seed, and the second dies on
 * `workspaces_slug_idx`. There is no row to take `for update` on, because the
 * row is the thing being created, which rules out the pattern `reserveRun`
 * uses next door in `runs.ts`. So the lock is taken on the *slug* instead:
 * `pg_advisory_xact_lock(hashtext(slug))` blocks the second transaction until
 * the first commits, and the re-read inside the lock then finds the workspace
 * and returns it with `seeded: false`.
 *
 * Catching the unique violation and re-selecting would also work and would be
 * one less round trip. It loses on failure mode: a duplicate key arriving from
 * a half-finished seed is indistinguishable from one arriving from a bug, and
 * the recovery path would be exercised only under load, which is exactly when
 * nobody is watching. Blocking is boring, and `hashtext` collisions cost at
 * most a brief wait on an unrelated slug.
 */
export async function ensureSandbox(
  db: DbOrTx,
  slug: string,
  now: Date,
): Promise<SandboxWorkspace> {
  requireSandboxSlug(slug);

  const existing = await readSandbox(db, slug);
  if (isLive(existing, now)) {
    return {
      workspaceId: existing.id,
      expiresAt: existing.expiresAt,
      seeded: false,
    };
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${slug}))`);

    // Read again under the lock. The whole point of the lock is that this
    // answer can differ from the one above.
    const row = await readSandbox(tx, slug);
    if (isLive(row, now)) {
      return { workspaceId: row.id, expiresAt: row.expiresAt, seeded: false };
    }

    return await plant(tx, slug, now);
  });
}

/**
 * Throw away a sandbox and plant it again.
 *
 * The Reset button. `seedWorkspace` deletes the workspace first and the
 * cascade takes every tenant-scoped row with it, so this is the same code path
 * as a first visit, under the same lock, for the same reason.
 *
 * The workspace id does not change. Every id in the fixture set is derived
 * from the slug by `seedIdsFor`, which is what lets the eval cases name an
 * invoice by computing its id, so a reset yields the same ids with fresh dates
 * and no runs against them.
 */
export async function resetSandbox(
  db: DbOrTx,
  slug: string,
  now: Date,
): Promise<SandboxWorkspace> {
  requireSandboxSlug(slug);

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${slug}))`);
    return await plant(tx, slug, now);
  });
}

async function plant(
  tx: DbOrTx,
  slug: string,
  now: Date,
): Promise<SandboxWorkspace> {
  const expiresAt = sandboxExpiry(now);
  await seedWorkspace(tx, { slug, expiresAt, now });

  // Read the id back rather than deriving it. `seedIdsFor` would give the same
  // answer today, and a select cannot drift from what was actually written.
  const planted = await readSandbox(tx, slug);
  if (!planted) {
    throw new Error(`seeded ${slug} but could not read it back`);
  }

  return { workspaceId: planted.id, expiresAt, seeded: true };
}

/**
 * Delete every sandbox past its TTL, and nothing else.
 *
 * `expires_at is not null` is redundant beside the comparison, since a null
 * never satisfies `<`. It is written anyway because it names the rule: rows
 * with no expiry are durable, `demo` is one of them, and a future edit that
 * loosens the comparison should have to delete this line first.
 *
 * The delete cascades to every tenant-scoped table, so one statement clears a
 * sandbox's tickets, runs, spans, approvals and eval results.
 */
export async function sweepExpiredSandboxes(
  db: DbOrTx,
  now: Date,
): Promise<number> {
  const swept = await db
    .delete(workspaces)
    .where(and(isNotNull(workspaces.expiresAt), lt(workspaces.expiresAt, now)))
    .returning({ id: workspaces.id });

  return swept.length;
}
