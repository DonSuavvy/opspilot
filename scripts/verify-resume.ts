/**
 * Day 5 gate evidence: the two resume invariants that only a database can prove.
 *
 * Needs Postgres, so it lives here rather than in the vitest suite — CLAUDE.md
 * requires `npm test` to run without a database.
 *
 * 1. **Double resume is rejected, not replayed.** Two operators clicking
 *    Approve at the same moment both pass the run-status check — that read
 *    happens before either writes. The guard that actually holds is the
 *    `status = 'pending'` predicate on the decision UPDATE: Postgres
 *    serialises the two statements, so exactly one matches a row and the other
 *    matches none. Without it both would write a decision and the tool would
 *    be dispatched twice, which for `issue_refund` means refunding twice.
 *
 *    The HTTP-level 409 is *not* this test. That one fires on the second
 *    request only because the first already finished and moved the run out of
 *    `paused_for_approval` — sequential, not concurrent. This exercises the
 *    race the status check cannot see.
 *
 * 2. **Span numbering continues rather than restarting.** `run_spans` is
 *    unique on `(run_id, seq)` and a resumed run keeps its original row, so a
 *    resumed invocation numbering from zero collides on its first insert.
 *
 * Fixtures are created and removed in a `finally`, so a failure part-way
 * through cannot leave a fake paused run in the demo inbox.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq } from "drizzle-orm";

import { closeDb, getDb } from "../src/db/client";
import {
  ApprovalNotPendingError,
  decidePendingApproval,
  describeApproval,
  listApprovals,
  listPendingApprovals,
  nextSpanSeq,
  recordPendingApproval,
  toResumeDecisions,
} from "../src/db/approvals";
import { agentRuns, runSpans, workspaces } from "../src/db/schema";

const GREEN = "[32m";
const RED = "[31m";
const BOLD = "[1m";
const RESET = "[0m";

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

  console.log(`\n${BOLD}Resume guards — workspace ${ws.slug}${RESET}\n`);

  // A paused run with no ticket behind it: this fixture never goes near the
  // agent loop, it only exercises the SQL the resume route depends on.
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId: ws.id,
      model: "haiku",
      status: "paused_for_approval",
      serializedMessages: "[]",
    })
    .returning({ id: agentRuns.id });

  const runId = run!.id;

  try {
    await recordPendingApproval(db, {
      workspaceId: ws.id,
      runId,
      toolUseId: "toolu_verify_resume",
      toolName: "issue_refund",
      toolInput: { invoice_id: "INV-0000", amount_cents: 100 },
      safetyClass: "confirm_write",
    });

    console.log(`${BOLD}1. The pause is recorded as a pending question${RESET}`);
    const pending = await listApprovals(db, runId);
    check("exactly one approval row", pending.length, 1);
    check("it starts pending", pending[0]?.status, "pending");
    check(
      "a pending row is not treated as an answer",
      toResumeDecisions(pending).length,
      0,
    );

    console.log(
      `\n${BOLD}2. Recording the same pause twice does not stack rows${RESET}`,
    );
    await recordPendingApproval(db, {
      workspaceId: ws.id,
      runId,
      toolUseId: "toolu_verify_resume",
      toolName: "issue_refund",
      toolInput: { invoice_id: "INV-0000", amount_cents: 100 },
      safetyClass: "confirm_write",
    });
    check("still one row", (await listApprovals(db, runId)).length, 1);

    console.log(
      `\n${BOLD}3. Two concurrent decisions: one wins, one is refused${RESET}`,
    );
    const decide = () =>
      decidePendingApproval(db, {
        runId,
        approved: true,
        reason: null,
        decidedBy: "verify-resume",
        now: new Date(),
      });

    const raced = await Promise.allSettled([decide(), decide()]);
    const fulfilled = raced.filter((r) => r.status === "fulfilled");
    const refused = raced.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof ApprovalNotPendingError,
    );

    check("exactly one decision took effect", fulfilled.length, 1);
    check("the loser was refused, not replayed", refused.length, 1);

    const decided = await listApprovals(db, runId);
    check("the row is decided once", decided.length, 1);
    check("and it is approved", decided[0]?.status, "approved");
    check(
      "a decided row becomes exactly one loop decision",
      toResumeDecisions(decided).length,
      1,
    );

    console.log(`\n${BOLD}4. Span numbering continues across invocations${RESET}`);
    check("an unspanned run starts at 0", await nextSpanSeq(db, runId), 0);

    await db.insert(runSpans).values(
      [0, 1, 2].map((seq) => ({
        workspaceId: ws.id,
        runId,
        seq,
        type: "tool_exec" as const,
        name: "fixture",
        isError: false,
      })),
    );

    check("after three spans it resumes at 3", await nextSpanSeq(db, runId), 3);

    // The collision the offset exists to prevent, demonstrated rather than
    // asserted from the schema: re-inserting seq 0 must be rejected.
    let collided = false;
    try {
      await db.insert(runSpans).values({
        workspaceId: ws.id,
        runId,
        seq: 0,
        type: "tool_exec" as const,
        name: "would collide",
        isError: false,
      });
    } catch {
      collided = true;
    }
    check("restarting from 0 is rejected by the unique index", collided, true);

    console.log(
      `\n${BOLD}5. The queue lists what is pending and forgets what is decided${RESET}`,
    );
    // A second question on the same run: `recordPendingApproval` is idempotent
    // on (runId, toolUseId), and section 3 already consumed the first row.
    await recordPendingApproval(db, {
      workspaceId: ws.id,
      runId,
      toolUseId: "toolu_verify_queue",
      toolName: "issue_refund",
      toolInput: {
        invoice_id: "INV-0000",
        amount_cents: 100,
        reason: "duplicate_charge",
      },
      safetyClass: "confirm_write",
    });

    // Keyed on the fixture's id rather than on the list length: the demo
    // workspace can hold real pending approvals from earlier runs, and a
    // length assertion would fail for reasons that are not about this code.
    const queued = await listPendingApprovals(db, ws.id);
    const mine = queued.find((a) => a.runId === runId);
    check("the pending row is in the queue", mine !== undefined, true);
    check("it carries no ticket, and still lists", mine?.ticketSubject, null);
    check("its customer is null too", mine?.customer, null);
    check(
      "and its input survives jsonb well enough to describe",
      mine ? describeApproval(mine) : null,
      "Refund $1.00 against INV-0000 (duplicate_charge)",
    );
    check("it is dated", mine?.createdAt instanceof Date, true);

    await decidePendingApproval(db, {
      runId,
      approved: false,
      reason: "fixture",
      decidedBy: "verify-resume",
      now: new Date(),
    });

    const afterDecision = await listPendingApprovals(db, ws.id);
    check(
      "a decided row leaves the queue",
      afterDecision.some((a) => a.runId === runId),
      false,
    );
  } finally {
    // Cascades to run_spans and approvals via their FKs.
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  }

  console.log(
    failures === 0
      ? `\n${GREEN}${BOLD}PASS${RESET} — resume guards hold\n`
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
