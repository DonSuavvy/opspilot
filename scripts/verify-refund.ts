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
import { agentRuns, auditLog, invoices, workspaces } from "../src/db/schema";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failures = 0;

/**
 * `INV-2005`, the second half of the seeded duplicate charge. Chosen because
 * the demo arc never refunds it — `INV-2001` through `INV-2003` carry the
 * refund-window story and must keep the ages and balances `verify:seed`
 * asserts. It is restored on the way out regardless.
 */
const TARGET = "INV-2005";
/**
 * `INV-2004`, the other half of the same duplicate charge. It exists here only
 * to be a *second* invoice the same idempotency key can be aimed at, which is
 * the one thing a single-invoice fixture cannot show. Restored on the way out
 * exactly like `TARGET`.
 */
const OTHER = "INV-2004";
const REFUND_CENTS = 1_000;
const KEY = "verify-refund-fixture";

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

  const read = async (number: string) =>
    (
      await db
        .select({
          amountCents: invoices.amountCents,
          refundedCents: invoices.refundedCents,
          status: invoices.status,
        })
        .from(invoices)
        .where(and(eq(invoices.workspaceId, ws.id), eq(invoices.number, number)))
        .limit(1)
    )[0];

  const before = await read(TARGET);
  if (!before) throw new Error(`no ${TARGET} — run \`npm run db:seed\``);

  // Read before the try, so the `finally` can put both invoices back even if
  // the script dies on the first check.
  const beforeOther = await read(OTHER);
  if (!beforeOther) throw new Error(`no ${OTHER} — run \`npm run db:seed\``);

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
    const data = createOpsData(db, { workspaceId: ws.id, runId });

    console.log(
      `${BOLD}1. An audit row written through the seam carries the run id${RESET}`,
    );
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

    console.log(`\n${BOLD}2. The refund lands on the invoice${RESET}`);
    const result = await data.recordRefund({
      invoiceNumber: TARGET,
      amountCents: REFUND_CENTS,
      reason: "duplicate_charge",
      idempotencyKey: KEY,
    });

    const expectedTotal = before.refundedCents + REFUND_CENTS;
    const expectedStatus =
      expectedTotal === before.amountCents ? "refunded" : "partially_refunded";

    check("the seam reports the new running total", result.refundedCents, expectedTotal);
    check("and the new invoice status", result.status, expectedStatus);
    check("it is not reported as a duplicate", result.duplicate, false);

    const after = () => read(TARGET);

    // The query FAILURES #24 was closed by. Everything above is what the code
    // says happened; this is the row.
    const row = await after();
    check("refunded_cents on the row itself", row?.refundedCents, expectedTotal);
    check("status on the row itself", row?.status, expectedStatus);

    console.log(
      `\n${BOLD}3. Exactly one audit row, and it says what changed${RESET}`,
    );
    const refundRows = async () =>
      db
        .select({
          runId: auditLog.runId,
          entityId: auditLog.entityId,
          entityType: auditLog.entityType,
          before: auditLog.before,
          after: auditLog.after,
        })
        .from(auditLog)
        .where(
          and(eq(auditLog.runId, runId), eq(auditLog.action, "issue_refund")),
        );

    const audit = await refundRows();
    check("one issue_refund row", audit.length, 1);
    check("attributed to the run", audit[0]?.runId, runId);
    check("against the invoice", audit[0]?.entityType, "invoice");
    check("named by number", audit[0]?.entityId, TARGET);

    const auditBefore = audit[0]?.before as Record<string, unknown> | undefined;
    const auditAfter = audit[0]?.after as Record<string, unknown> | undefined;
    check("before: the balance it started from", auditBefore?.refundedCents, before.refundedCents);
    check("before: the status it started from", auditBefore?.status, before.status);
    check("after: the new running total", auditAfter?.refundedCents, expectedTotal);
    check("after: the new status", auditAfter?.status, expectedStatus);
    check("after: this refund's own amount", auditAfter?.amountCents, REFUND_CENTS);
    check("after: the reason", auditAfter?.reason, "duplicate_charge");
    check("after: the idempotency key", auditAfter?.idempotency_key, KEY);

    console.log(
      `\n${BOLD}4. The same key again moves no money${RESET}`,
    );
    const replay = await data.recordRefund({
      invoiceNumber: TARGET,
      amountCents: REFUND_CENTS,
      reason: "duplicate_charge",
      idempotencyKey: KEY,
    });

    check("reported as a duplicate", replay.duplicate, true);
    check("with the total from the first call", replay.refundedCents, expectedTotal);
    check("and its status", replay.status, expectedStatus);

    const replayed = await after();
    check("the invoice did not move again", replayed?.refundedCents, expectedTotal);
    check("still one audit row", (await refundRows()).length, 1);

    /**
     * And the replay describes the invoice as it is *now*. A second refund
     * under its own key moves the total after the first key was recorded, so
     * a duplicate answered from the first call's audit snapshot reports a
     * balance that was true once — the number a customer would be told.
     */
    await data.recordRefund({
      invoiceNumber: TARGET,
      amountCents: REFUND_CENTS,
      reason: "duplicate_charge",
      idempotencyKey: `${KEY}-b`,
    });

    const movedOn = await after();
    check("a second refund moved the total", movedOn?.refundedCents, expectedTotal + REFUND_CENTS);

    const stale = await data.recordRefund({
      invoiceNumber: TARGET,
      amountCents: REFUND_CENTS,
      reason: "duplicate_charge",
      idempotencyKey: KEY,
    });

    check("the old key is still a duplicate", stale.duplicate, true);
    check("reporting the row's total now", stale.refundedCents, movedOn?.refundedCents);
    check("and the row's status now", stale.status, movedOn?.status);

    /**
     * The key is written by the model, in `issue_refund`'s arguments. Nothing
     * stops it reusing one string across two invoices — a model that settles
     * on `"tkt_1-refund"` for a customer charged twice will send it twice —
     * and if the lookup matches on the key alone, the second refund is
     * swallowed and reported as a duplicate carrying the *first* invoice's
     * totals. Money the customer is owed, and a reply that says it moved.
     */
    console.log(
      `\n${BOLD}5. The same key against a different invoice is a different refund${RESET}`,
    );
    const other = await data.recordRefund({
      invoiceNumber: OTHER,
      amountCents: REFUND_CENTS,
      reason: "duplicate_charge",
      idempotencyKey: KEY,
    });

    const expectedOtherTotal = beforeOther.refundedCents + REFUND_CENTS;
    const expectedOtherStatus =
      expectedOtherTotal === beforeOther.amountCents
        ? "refunded"
        : "partially_refunded";

    check("not reported as a duplicate", other.duplicate, false);
    check("the other invoice's own total", other.refundedCents, expectedOtherTotal);
    check("and its own status", other.status, expectedOtherStatus);

    const otherRow = await read(OTHER);
    check(
      `refunded_cents on ${OTHER} itself`,
      otherRow?.refundedCents,
      expectedOtherTotal,
    );
    // Counted by invoice rather than in total: the section above writes rows
    // against TARGET too, and the fact being checked is that INV-2004 got one
    // of its own.
    const otherRows = (await refundRows()).filter((r) => r.entityId === OTHER);
    check(`an issue_refund row for ${OTHER}`, otherRows.length, 1);

    console.log(`\n${BOLD}6. An invoice this workspace does not have${RESET}`);
    let threw = false;
    try {
      await data.recordRefund({
        invoiceNumber: "INV-DOES-NOT-EXIST",
        amountCents: 100,
        reason: "other",
        idempotencyKey: "verify-refund-missing",
      });
    } catch {
      threw = true;
    }
    check("throws rather than writing nothing quietly", threw, true);
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

    // The seed is a fixture the demo arc depends on, so this script must be a
    // no-op against it once it exits — `verify:seed` asserts the duplicate
    // charge's invoices and they are not this script's to change.
    await db
      .update(invoices)
      .set({ refundedCents: before.refundedCents, status: before.status })
      .where(and(eq(invoices.workspaceId, ws.id), eq(invoices.number, TARGET)));
    await db
      .update(invoices)
      .set({
        refundedCents: beforeOther.refundedCents,
        status: beforeOther.status,
      })
      .where(and(eq(invoices.workspaceId, ws.id), eq(invoices.number, OTHER)));
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
