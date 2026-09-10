/**
 * Day 8 gate evidence: one sandbox per visitor, isolated, and swept.
 *
 * The unit tests cover the parts that are pure. Everything interesting about
 * sandboxes is not: two workspaces have to hold disjoint rows, two requests
 * arriving together have to plant one workspace rather than race, an expired
 * sandbox has to come back, and the sweep has to leave the durable `demo`
 * tenant alone. None of that is checkable without Postgres, and `npm test`
 * must stay green without one, so it lives here.
 *
 * Every row this script creates is deleted before it exits, including on the
 * failure path.
 *
 * Run: npm run db:up && npm run db:migrate && npm run db:seed && npm run verify:sandbox
 */
import { randomBytes } from "node:crypto";

import { config } from "dotenv";
import { and, eq, inArray } from "drizzle-orm";

import { closeDb, getDb } from "../src/db/client";
import {
  ensureSandbox,
  resetSandbox,
  sweepExpiredSandboxes,
} from "../src/db/sandbox";
import { agentRuns, tickets, workspaces } from "../src/db/schema";
import { newSandboxSlug } from "../src/lib/sandbox";

config({ path: ".env.local" });

let failures = 0;

function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${message}`);
    failures += 1;
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** Slugs this run minted, so the cleanup at the end knows what to remove. */
const minted: string[] = [];

function freshSlug(): string {
  const slug = newSandboxSlug(randomBytes(16));
  minted.push(slug);
  return slug;
}

async function ticketIdsIn(workspaceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.workspaceId, workspaceId));
  return rows.map((r) => r.id);
}

async function workspaceRow(slug: string) {
  const [row] = await getDb()
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return row;
}

async function main(): Promise<number> {
  const db = getDb();
  const now = new Date();

  const demoBefore = await workspaceRow("demo");
  if (!demoBefore) {
    throw new Error("demo workspace missing — run npm run db:seed");
  }

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m1. Two visitors, two worlds\x1b[0m");

  const slugA = freshSlug();
  const slugB = freshSlug();
  const a = await ensureSandbox(db, slugA, now);
  const b = await ensureSandbox(db, slugB, now);

  check(a.seeded && b.seeded, "both first visits seeded");
  check(a.workspaceId !== b.workspaceId, "they got different workspaces");

  const ticketsA = await ticketIdsIn(a.workspaceId);
  const ticketsB = await ticketIdsIn(b.workspaceId);
  const shared = ticketsA.filter((id) => ticketsB.includes(id));

  check(ticketsA.length === 8, `sandbox A has 8 tickets (got ${ticketsA.length})`);
  check(ticketsB.length === 8, `sandbox B has 8 tickets (got ${ticketsB.length})`);
  // The bug this catches is the one `seedIdsFor` was rewritten for: ids derived
  // from the key alone are identical across workspaces and collide on insert.
  check(shared.length === 0, `no ticket id is in both (${shared.length} shared)`);

  const demoAfterSeeding = await workspaceRow("demo");
  check(
    demoAfterSeeding?.id === demoBefore.id &&
      demoAfterSeeding?.seededAt?.getTime() === demoBefore.seededAt?.getTime(),
    "the demo tenant was not touched",
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m2. A second request does not re-seed\x1b[0m");

  const again = await ensureSandbox(db, slugA, now);
  check(again.workspaceId === a.workspaceId, "same workspace id");
  check(again.seeded === false, "reported as found, not planted");
  check(
    again.expiresAt.getTime() === a.expiresAt.getTime(),
    "the TTL did not move",
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m3. Five requests arriving together\x1b[0m");

  // The real case is a browser fetching a page and its API call at once on a
  // cookie that has just been minted. Both find nothing and both try to seed.
  const slugC = freshSlug();
  const racers = await Promise.all(
    Array.from({ length: 5 }, () => ensureSandbox(db, slugC, now)),
  );

  const seededCount = racers.filter((r) => r.seeded).length;
  const distinctIds = new Set(racers.map((r) => r.workspaceId));
  const rowsForC = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, slugC));

  check(distinctIds.size === 1, "all five agree on one workspace id");
  check(seededCount === 1, `exactly one of them planted it (got ${seededCount})`);
  check(
    rowsForC.length === 1,
    `one row in workspaces for the slug (got ${rowsForC.length})`,
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m4. The sweep, 25 hours later\x1b[0m");

  const swept = await sweepExpiredSandboxes(db, new Date(now.getTime() + 25 * HOUR_MS));
  const survivors = await db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(inArray(workspaces.slug, [slugA, slugB, slugC]));

  check(swept >= 3, `swept ${swept} expired sandboxes`);
  check(survivors.length === 0, "all three test sandboxes are gone");

  const demoAfterSweep = await workspaceRow("demo");
  check(
    demoAfterSweep?.id === demoBefore.id,
    "the demo tenant survived, because its expiry is null",
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m5. Reset replants the same sandbox\x1b[0m");

  const slugD = freshSlug();
  const before = await ensureSandbox(db, slugD, now);

  // Something to lose. An agent run is the row a visitor most wants gone when
  // they reset, and it cascades from the workspace rather than being deleted
  // by name.
  await db.insert(agentRuns).values({
    workspaceId: before.workspaceId,
    model: "haiku",
    status: "completed",
  });
  await db
    .update(tickets)
    .set({ suspectedInjection: true })
    .where(eq(tickets.workspaceId, before.workspaceId));

  const later = new Date(now.getTime() + HOUR_MS);
  const after = await resetSandbox(db, slugD, later);

  const runsLeft = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, after.workspaceId));
  const flagged = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.workspaceId, after.workspaceId),
        eq(tickets.suspectedInjection, true),
      ),
    );

  // Not a new id, and that is the design rather than a shortfall: every id in
  // the fixture set is derived from the slug by `seedIdsFor`, which is what
  // lets an eval case name an invoice by computing its id.
  check(after.workspaceId === before.workspaceId, "the workspace id is stable");
  check(after.seeded, "reported as planted");
  check(runsLeft.length === 0, `the agent run cascaded away (${runsLeft.length} left)`);
  check(
    flagged.length === 1,
    `tickets are back to the seeded state (${flagged.length} flagged, expected the 1 the seed sets)`,
  );
  check(
    after.expiresAt.getTime() === later.getTime() + 24 * HOUR_MS,
    "the TTL restarted from the reset instant",
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m6. An expired sandbox comes back\x1b[0m");

  // The 7 day cookie against a 24 hour TTL guarantees this case: the visitor
  // who returns on day two has a valid slug and no rows.
  const slugE = freshSlug();
  const first = await ensureSandbox(db, slugE, now);
  const tomorrow = new Date(now.getTime() + 25 * HOUR_MS);
  const second = await ensureSandbox(db, slugE, tomorrow);

  check(second.seeded, "the expired sandbox was re-seeded");
  check(second.workspaceId === first.workspaceId, "under the same workspace id");
  check(
    second.expiresAt.getTime() === tomorrow.getTime() + 24 * HOUR_MS,
    "with a fresh 24 hour TTL",
  );
  check(
    (await ticketIdsIn(second.workspaceId)).length === 8,
    "and its 8 tickets are back",
  );

  console.log(
    failures === 0
      ? "\n\x1b[32m\x1b[1mSandbox verification: PASS\x1b[0m\n"
      : `\n\x1b[31m\x1b[1mSandbox verification: ${failures} FAILURE(S)\x1b[0m\n`,
  );
  return failures;
}

async function cleanup() {
  if (minted.length === 0) return;
  const removed = await getDb()
    .delete(workspaces)
    .where(inArray(workspaces.slug, minted))
    .returning({ id: workspaces.id });
  // Fewer than were minted is the expected outcome, not a shortfall: check 4
  // sweeps three of them on purpose.
  console.log(
    `Removed ${removed.length} test sandboxes; the sweep in check 4 had ` +
      `already taken ${minted.length - removed.length}.`,
  );
}

main()
  .then(async (f) => {
    await cleanup();
    await closeDb();
    process.exit(f === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await closeDb();
    process.exit(1);
  });
