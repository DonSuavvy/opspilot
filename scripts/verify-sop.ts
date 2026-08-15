/**
 * Day 4 gate evidence: editing the policy changes the prompt the model reads.
 *
 * Needs a database, so it lives here rather than in the vitest suite — CLAUDE.md
 * requires `npm test` to run without Postgres.
 *
 * What this proves and what it does not: it proves the *prompt* tracks
 * `policy_config`. It does not prove the *decision* changes, because
 * `issue_refund`'s handler is still `pending()` and `evaluateRefund` has no
 * production caller until Day 5 wires the approval queue. Extend this script
 * then — the missing assertion is that INV-2002 is approved at 30 days and
 * denied at 14.
 *
 * The window flip is applied to the real row and restored in a `finally`, so a
 * failure part-way through cannot leave the demo workspace narrowed.
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

  console.log(`${BOLD}1. The active version loads and is pinnable${RESET}`);
  check("a version id exists to pin onto the run", typeof before.versionId, "string");
  check("policy_config states the shipped window", before.policyConfig.refund.windowDays, 30);
  check(
    "stored markdown keeps its placeholders",
    before.bodyMarkdown.includes("{{refund.windowDays}}"),
    true,
  );

  console.log(`\n${BOLD}2. The compiled prompt renders from policy_config${RESET}`);
  check("prompt states the window", statedWindow(at30), 30);
  check("no placeholder survives compilation", at30.includes("{{"), false);
  check("injection framing present", at30.includes("suspected_injection"), true);

  try {
    await db
      .update(sopVersions)
      .set({
        policyConfig: {
          ...before.policyConfig,
          refund: { ...before.policyConfig.refund, windowDays: 14 },
        },
      })
      .where(eq(sopVersions.id, before.versionId));

    const after = await loadActiveSop(db, ws.id);
    const at14 = compileSop({
      bodyMarkdown: after.bodyMarkdown,
      policyConfig: after.policyConfig,
    });

    console.log(`\n${BOLD}3. Demo arc step 2 — flip the window 30 -> 14${RESET}`);
    check("policy_config now states 14", after.policyConfig.refund.windowDays, 14);
    check("prompt now states 14", statedWindow(at14), 14);
    check("the prompt actually changed", at30 !== at14, true);
    check("no stale '30 days' anywhere", /\b30\s+days?\b/.test(at14), false);
    check("injection framing survives the edit", at14.includes("suspected_injection"), true);
  } finally {
    await db
      .update(sopVersions)
      .set({ policyConfig: before.policyConfig })
      .where(eq(sopVersions.id, before.versionId));
  }

  const restored = await loadActiveSop(db, ws.id);
  console.log(`\n${BOLD}4. The demo workspace is left as it was found${RESET}`);
  check("window restored", restored.policyConfig.refund.windowDays, 30);

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
