/**
 * Day 6 gate evidence: the Eval Lab writes what the diff view will read, and
 * running it does not consume the demo.
 *
 * The scorer, the runner and the write barrier are unit-tested against seams —
 * no key, no Postgres. What no unit test can show is the part that only exists
 * once real rows are involved: that a run is *pinned* (SOP version, model, git
 * SHA, prompt version), that its totals add up, that `listEvalRuns` can label
 * it "v1 · 30-day" without a second query, that `getEvalRun` hands the diff
 * view its assertions back intact — and, most importantly, that eight cases a
 * day do not quietly refund the seeded invoices and close the seeded inbox.
 *
 * **No network and no cost.** `createMessage` is scripted, and its turns report
 * zero usage, so the suite adds nothing to the day's spend. What is being
 * verified here is the plumbing; whether the *model* resolves a ticket
 * correctly is what the calibration run and the CI gate are for.
 *
 * Run: npm run verify:evals
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq, inArray } from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { budgetConfigSchema } from "../src/agent/budget";
import type { AssistantTurn, ContentBlock, MessageCreator } from "../src/agent/loop";
import { providerFromEnv } from "../src/agent/provider";
import { closeDb, getDb } from "../src/db/client";
import { getEvalRun, listEvalRuns } from "../src/db/evals";
import {
  agentRuns,
  evalRuns,
  invoices,
  runSpans,
  tickets,
  workspaces,
} from "../src/db/schema";
import { loadActiveSop } from "../src/db/sops";
import { GOLDEN_CASES } from "../src/evals/cases";
import { runEvalSuite, type EvalSuiteEvent } from "../src/evals/suite";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failures = 0;

function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${message}`);
  } else {
    console.error(`  ${RED}✗${RESET} ${message}`);
    failures += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* The scripted model                                                         */
/* -------------------------------------------------------------------------- */

function toolUse(name: string, input: unknown) {
  return { type: "tool_use" as const, id: `toolu_${name}`, name, input };
}

/** Zero usage, so nothing here reaches the day's spend or the rate card. */
function turn(content: ContentBlock[]): AssistantTurn {
  return {
    content,
    stop_reason: "tool_use",
    stop_details: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Two cases, four turns, handed out in order.
 *
 * `refund-in-window` reads the invoice and asks to refund it, which pauses the
 * run at the approval gate — the path that would move money if the barrier
 * leaked. `missing-info` escalates and resolves, which is the path that scores
 * a clean pass against real expectations.
 */
function scriptedModel(): MessageCreator {
  const turns: AssistantTurn[] = [
    turn([toolUse("get_invoices", { customer_id: "cus_0001", limit: 12 })]),
    turn([
      toolUse("issue_refund", {
        invoice_id: "INV-2001",
        amount_cents: 4_900,
        reason: "service_issue",
        idempotency_key: "verify-evals-INV-2001",
      }),
    ]),
    turn([
      toolUse("escalate", {
        ticket_id: "missing-info",
        reason: "unknown_customer",
        summary: "No account, invoice or email in the ticket.",
      }),
    ]),
    turn([
      toolUse("resolve_ticket", {
        action: "escalated",
        refund_amount_cents: 0,
        reply: "I could not identify the account, so a colleague will follow up.",
        confidence: "medium",
      }),
    ]),
  ];

  return async () => {
    const next = turns.shift();
    if (!next) throw new Error("scripted model ran out of turns");
    return next;
  };
}

/* -------------------------------------------------------------------------- */

async function main() {
  const db = getDb();

  const [ws] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");

  console.log(`\n${BOLD}Eval Lab — workspace ${ws.slug}${RESET}\n`);

  /* --- what the demo depends on, before --- */
  const invoicesBefore = await db
    .select({
      number: invoices.number,
      status: invoices.status,
      refundedCents: invoices.refundedCents,
    })
    .from(invoices)
    .where(eq(invoices.workspaceId, ws.id));
  const ticketsBefore = await db
    .select({ id: tickets.id, status: tickets.status })
    .from(tickets)
    .where(eq(tickets.workspaceId, ws.id));

  const cases = GOLDEN_CASES.filter((c) =>
    ["refund-in-window", "missing-info"].includes(c.slug),
  );
  if (cases.length !== 2) throw new Error("expected two golden cases by slug");

  // The suite below runs with `sopVersionId: null`, so it is scored against
  // whatever is active. Read that here rather than hardcoding a version: the
  // SOP editor is a demo feature, and a v1 written into this script fails the
  // moment someone uses it.
  const activeSop = await loadActiveSop(db, ws.id);

  const events: EvalSuiteEvent[] = [];
  let evalRunId = "";
  const agentRunIds: string[] = [];

  try {
    const summary = await runEvalSuite({
      db,
      workspaceId: ws.id,
      sopVersionId: null,
      model: "haiku",
      cases,
      createMessage: scriptedModel(),
      provider: providerFromEnv(process.env),
      budgetConfig: budgetConfigSchema.parse(process.env),
      gitSha: "verify-evals-fixture",
      now: new Date(),
      emit: (event) => {
        events.push(event);
        if (event.type === "case" && event.agentRunId) {
          agentRunIds.push(event.agentRunId);
        }
      },
    });
    evalRunId = summary.evalRunId;

    /* --- the run row is pinned and totalled --- */
    console.log(`${BOLD}The run row${RESET}`);

    const [row] = await db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.id, evalRunId))
      .limit(1);

    check(row !== undefined, "an eval_runs row exists");
    check(row?.status === "completed", `status is completed (${row?.status})`);
    check(row?.model === "haiku", "the logical model name is recorded");
    check(
      row?.gitSha === "verify-evals-fixture",
      "the git SHA is pinned to the row",
    );
    check(
      (row?.promptVersion ?? "").length === 12,
      `the prompt version is a 12-char pin (${row?.promptVersion})`,
    );
    check(row?.sopVersionId !== null, "the SOP version is pinned to the row");
    check(row?.totalCases === 2, `total_cases is 2 (${row?.totalCases})`);
    check(
      (row?.passedCases ?? -1) + (row?.failedCases ?? -1) === 2,
      `passed + failed is 2 (${row?.passedCases} + ${row?.failedCases})`,
    );

    /* --- the events the API streams --- */
    console.log(`\n${BOLD}The event stream${RESET}`);

    check(events[0]?.type === "run", "the first event names the run");
    check(
      events.filter((e) => e.type === "case").length === 2,
      "one case event per case",
    );
    check(
      events[events.length - 1]?.type === "done",
      "the last event is the summary",
    );

    /* --- the agent runs behind them --- */
    console.log(`\n${BOLD}The agent runs${RESET}`);

    const runs = await db
      .select({
        id: agentRuns.id,
        ticketId: agentRuns.ticketId,
        status: agentRuns.status,
      })
      .from(agentRuns)
      .where(inArray(agentRuns.id, agentRunIds));

    check(runs.length === 2, `two agent_runs rows (${runs.length})`);
    check(
      runs.every((r) => r.ticketId === null),
      "each carries a null ticket_id — an eval case is not a ticket",
    );
    check(
      runs.some((r) => r.status === "paused_for_approval"),
      "the refund case stopped at the approval gate",
    );

    const spans = await db
      .select({ id: runSpans.id })
      .from(runSpans)
      .where(inArray(runSpans.runId, agentRunIds));
    check(spans.length > 0, `spans were persisted (${spans.length})`);

    /* --- what the list and detail views read --- */
    console.log(`\n${BOLD}The reads the UI makes${RESET}`);

    const listed = await listEvalRuns(db, ws.id);
    const mine = listed.find((r) => r.id === evalRunId);

    check(listed[0]?.id === evalRunId, "the newest run is listed first");
    check(
      mine?.sopVersion === activeSop.version,
      `the SOP version number is joined in (v${mine?.sopVersion})`,
    );
    check(
      mine?.refundWindowDays === activeSop.policyConfig.refund.windowDays,
      `the refund window is joined in (${mine?.refundWindowDays}-day)`,
    );

    const detail = await getEvalRun(db, evalRunId, ws.id);
    const slugs = (detail?.results ?? []).map((r) => r.slug).sort();

    check(detail !== null, "getEvalRun returns the run");
    check(
      slugs.join(",") === "missing-info,refund-in-window",
      `both case rows come back, joined to their slugs (${slugs.join(",")})`,
    );
    check(
      (detail?.results ?? []).every((r) => r.assertions.length > 0),
      "every result carries its assertions",
    );

    const missingInfo = detail?.results.find((r) => r.slug === "missing-info");
    check(
      missingInfo?.passed === true,
      "the scripted escalation scores a pass against the real expectations",
    );
    check(
      missingInfo?.failureReason === null,
      "a passing case records no failure reason",
    );

    const refundCase = detail?.results.find((r) => r.slug === "refund-in-window");
    check(
      (refundCase?.assertions ?? []).some((a) => a.name === "pausesFor.tool"),
      "the refund case asserted on the pause",
    );
    check(
      typeof refundCase?.latencyMs === "number",
      "latency is recorded per case",
    );

    // A real uuid, not a garbage string: `eval_runs.workspace_id` is a uuid
    // column, so a malformed id would throw and the check would pass for the
    // wrong reason.
    const elsewhere = await getEvalRun(db, evalRunId, randomUUID());
    check(
      elsewhere === null,
      "the same run looked up under another workspace is not found",
    );

    /* --- and the demo is intact --- */
    console.log(`\n${BOLD}The seeded workspace, after${RESET}`);

    const invoicesAfter = await db
      .select({
        number: invoices.number,
        status: invoices.status,
        refundedCents: invoices.refundedCents,
      })
      .from(invoices)
      .where(eq(invoices.workspaceId, ws.id));
    const ticketsAfter = await db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.workspaceId, ws.id));

    check(
      JSON.stringify(invoicesAfter) === JSON.stringify(invoicesBefore),
      "not one cent was refunded against a seeded invoice",
    );
    check(
      JSON.stringify(ticketsAfter) === JSON.stringify(ticketsBefore),
      "not one seeded ticket changed status",
    );
  } finally {
    // The eval run cascades to its results; the agent runs cascade to their
    // spans. The `eval_cases` rows stay — they are the golden suite, and the
    // next run upserts them anyway.
    if (evalRunId) {
      await db.delete(evalRuns).where(eq(evalRuns.id, evalRunId));
    }
    if (agentRunIds.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.id, agentRunIds));
    }
  }

  console.log(
    failures === 0
      ? `\n${GREEN}${BOLD}PASS${RESET} — the Eval Lab persists a pinned run and leaves the demo alone\n`
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
