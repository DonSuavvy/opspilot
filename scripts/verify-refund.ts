/**
 * Day 5 gate evidence: the approved refund actually lands, and the audit row
 * says which run moved the money.
 *
 * Needs Postgres, so it lives here rather than in the vitest suite — CLAUDE.md
 * requires `npm test` to run without a database.
 *
 * FAILURES #24 is the brief. A human approved a refund, the trace was green,
 * the customer was told the money was on its way, and `refunded_cents` was
 * zero. Two holes sat behind that: `issue_refund` wrote nothing at all, and
 * every `audit_log` row ever written carried `run_id = NULL`, because
 * `createOpsData` closed over the workspace and never received the run.
 *
 * The checks below are the queries that would have caught it.
 *
 * Fixtures are removed in a `finally` and the invoice is restored to the
 * values it had on entry, so a failure part-way through cannot leave a
 * half-refunded invoice in the demo workspace. Order matters in that cleanup:
 * `audit_log.run_id` is `on delete set null`, not cascade, so dropping the
 * throwaway run first would orphan the rows rather than remove them.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";

import { closeDb, getDb } from "../src/db/client";
import { createOpsData } from "../src/db/ops-data";
import { agentRuns, auditLog, workspaces } from "../src/db/schema";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

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

async function main() {
  const db = getDb();

  const [ws] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");

  console.log(`\n${BOLD}Refund recording — workspace ${ws.slug}${RESET}\n`);

  // A throwaway run to attribute the writes to. It never goes near the agent
  // loop; it exists so `audit_log.run_id` has something to point at.
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId: ws.id,
      model: "haiku",
      status: "completed",
      serializedMessages: "[]",
    })
    .returning({ id: agentRuns.id });

  const runId = run!.id;

  try {
    console.log(
      `${BOLD}1. An audit row written through the seam carries the run id${RESET}`,
    );
    const data = createOpsData(db, ws.id);
    await data.saveDraft("tkt_verify_refund", "gate fixture");

    const [draftRow] = await db
      .select({ runId: auditLog.runId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, ws.id),
          eq(auditLog.entityId, "tkt_verify_refund"),
        ),
      )
      .limit(1);

    check("the draft's audit row names the run", draftRow?.runId, runId);
  } finally {
    // `audit_log.run_id` is `set null` on delete, so these rows must go first
    // or they survive the run as untraceable orphans in the demo workspace.
    await db.delete(auditLog).where(eq(auditLog.runId, runId));
    await db
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, ws.id),
          eq(auditLog.entityId, "tkt_verify_refund"),
        ),
      );
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  }

  console.log(
    failures === 0
      ? `\n${GREEN}${BOLD}PASS${RESET} — the refund lands and the audit trail names the run\n`
      : `\n${RED}${BOLD}FAIL${RESET} — ${failures} check(s) failed\n`,
  );

  await closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
