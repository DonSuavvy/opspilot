/**
 * Day 4 gate evidence: editing the policy changes the prompt the model reads.
 *
 * Needs a database, so it lives here rather than in the vitest suite — CLAUDE.md
 * requires `npm test` to run without Postgres.
 *
 * What this proves and what it does not: it proves the *prompt* tracks
 * `policy_config`. The *decision* side is now enforced by `issue_refund`'s
 * revalidation against the run's pinned policy (Day 5) and covered
 * deterministically in `src/agent/refund-handler.test.ts` — which needs no
 * database, so it belongs in the vitest suite rather than here.
 *
 * The window flip is applied to the real row and restored in a `finally`, so a
 * failure part-way through cannot leave the demo workspace narrowed.
 *
 * **Asserts a relationship, not a number.** An earlier version hardcoded "the
 * active window is 30", which was an invariant only while the SOP was
 * immutable. Day 4 shipped the editor, someone saved a 14-day version through
 * it, and the gate went red on a workspace that was working exactly as designed.
 * A gate that fails when the product is used is worse than no gate: it trains
 * you to ignore it. So the script now reads whatever is active, flips to a
 * *different* window, and asserts the prompt follows.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq } from "drizzle-orm";

import { compileSop } from "../src/agent/sop";
import { closeDb, getDb } from "../src/db/client";
import { sopVersions, workspaces } from "../src/db/schema";
import { loadActiveSop } from "../src/db/sops";

const GREEN = "[32m";
const RED = "[31m";
const BOLD = "[1m";
const RESET = "[0m";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${label} (got ${String(actual)}${
      ok ? "" : `, want ${String(expected)}`
    })`,
  );
}

/** The window as the compiled prompt states it, or null if the line is gone. */
function statedWindow(prompt: string): number | null {
  const m = /refund window is \*\*(\d+) days/.exec(prompt);
  return m ? Number(m[1]) : null;
}

async function main() {
  const db = getDb();

  const [ws] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");

  console.log(`\n${BOLD}SOP compilation — workspace ${ws.slug}${RESET}\n`);

  const before = await loadActiveSop(db, ws.id);
  const at30 = compileSop({
    bodyMarkdown: before.bodyMarkdown,
    policyConfig: before.policyConfig,
  });

  const activeWindow = before.policyConfig.refund.windowDays;
  // Flip to something that is definitely different from whatever is active.
  const flipped = activeWindow === 14 ? 30 : 14;

  console.log(`${BOLD}1. The active version loads and is pinnable${RESET}`);
  check("a version id exists to pin onto the run", typeof before.versionId, "string");
  check(
    "stored markdown keeps its placeholders",
    before.bodyMarkdown.includes("{{refund.windowDays}}"),
    true,
  );
  console.log(`    active window (whatever was last saved): ${activeWindow} days`);

  console.log(`\n${BOLD}2. The compiled prompt renders from policy_config${RESET}`);
  check("prompt states the active window", statedWindow(at30), activeWindow);
  check("no placeholder survives compilation", at30.includes("{{"), false);
  check("injection framing present", at30.includes("suspected_injection"), true);

  try {
    await db
      .update(sopVersions)
      .set({
        policyConfig: {
          ...before.policyConfig,
          refund: { ...before.policyConfig.refund, windowDays: flipped },
        },
      })
      .where(eq(sopVersions.id, before.versionId));

    const after = await loadActiveSop(db, ws.id);
    const at14 = compileSop({
      bodyMarkdown: after.bodyMarkdown,
      policyConfig: after.policyConfig,
    });

    console.log(
      `\n${BOLD}3. Demo arc step 2 — flip the window ${activeWindow} -> ${flipped}${RESET}`,
    );
    check("policy_config now states the new window", after.policyConfig.refund.windowDays, flipped);
    check("prompt now states the new window", statedWindow(at14), flipped);
    check("the prompt actually changed", at30 !== at14, true);
    check(
      `no stale '${activeWindow} days' anywhere`,
      new RegExp(`\\b${activeWindow}\\s+days?\\b`).test(at14),
      false,
    );
    check("injection framing survives the edit", at14.includes("suspected_injection"), true);
  } finally {
    await db
      .update(sopVersions)
      .set({ policyConfig: before.policyConfig })
      .where(eq(sopVersions.id, before.versionId));
  }

  const restored = await loadActiveSop(db, ws.id);
  console.log(`\n${BOLD}4. The demo workspace is left as it was found${RESET}`);
  check("window restored", restored.policyConfig.refund.windowDays, activeWindow);

  console.log(
    failures === 0
      ? `\n${GREEN}${BOLD}SOP verification: PASS${RESET}\n`
      : `\n${RED}${BOLD}SOP verification: FAIL (${failures})${RESET}\n`,
  );
  await closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
