/**
 * CLI wrapper around `seedWorkspace`.
 *
 * Everything with a side effect lives here: reading `.env.local`, opening the
 * pool, printing, and setting an exit code. `src/db/seed.ts` is a library and
 * stays importable without doing any of it.
 *
 * That split is not cosmetic. `seed()` used to be invoked at module scope, so
 * importing the seed *ran* it — a vitest file that imported the module injected
 * `.env.local` and began writing to Postgres, in a suite CLAUDE.md requires to
 * work with no database at all.
 *
 * Run: npm run db:seed
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { closeDb, getDb } from "../src/db/client";
import { seedWorkspace } from "../src/db/seed";

const WORKSPACE_SLUG = "demo";

async function main(): Promise<void> {
  console.log("Seeding Beacon Analytics...");

  const counts = await seedWorkspace(getDb(), {
    slug: WORKSPACE_SLUG,
    // The durable demo tenant never expires. Day 8's per-visitor sandboxes
    // pass a real TTL here for the cron sweep to collect.
    expiresAt: null,
    now: new Date(),
  });

  console.log("Seeded:", counts);
  console.log(`\nRefund-window fixtures (window flip is demo arc step 2):`);
  console.log(`  INV-2001  paid  5d ago  -> in policy at 30 and at 14`);
  console.log(`  INV-2002  paid 22d ago  -> in policy at 30, OUT at 14  <- flips`);
  console.log(`  INV-2003  paid 45d ago  -> out of policy either way`);
  console.log(`  INV-2004/5 paid 9d ago  -> duplicate charge, always refundable`);
}

main()
  .then(async () => {
    await closeDb();
    console.log("\nSeed complete.");
  })
  .catch(async (error) => {
    console.error("\nSeed failed:", error);
    await closeDb();
    process.exit(1);
  });
