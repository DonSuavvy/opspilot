/**
 * Eval-run persistence — the half of the Eval Lab that needs Postgres.
 *
 * Nothing here is unit-tested, deliberately: `npm test` must run without a
 * database, and a mocked `AsyncSession` proves that the mock behaves, not that
 * the query does. The evidence for this module is `scripts/verify-evals.ts`,
 * which runs a whole suite against the real schema and reads the rows back.
 *
 * **Cost is converted exactly once, the way `finishRun` does it.** Nano-dollars
 * are the accounting unit because cache multipliers land off the micro grid;
 * `numeric(12,6)` is the storage unit. Two conversions would eventually differ,
 * and the difference would surface as a `costSane` CHECK violation three layers
 * from the arithmetic that caused it.
 */
import { desc, eq } from "drizzle-orm";

import { microsToUsdString, nanosToMicros } from "@/agent/cost";
import type { EvalCase } from "@/evals/case";
import type { Assertion, CaseResultRow } from "@/evals/types";
import type { PolicyConfig } from "@/policy/refund";

import type { Db } from "./client";
import { evalCases, evalResults, evalRuns, sopVersions } from "./schema";

function costUsd(nanos: number): string {
  return microsToUsdString(nanosToMicros(nanos));
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Push the golden suite into `eval_cases`, keyed by slug, and return the row
 * ids.
 *
 * The suite lives in TypeScript — it is code, it is reviewed, it ships with the
 * repo — and the table exists so results have something to point at and so the
 * diff view can render a case's title without importing the suite. Upserting on
 * every run keeps those two in step: edit a case's expectations, run the suite,
 * and the row already says what the results were scored against.
 *
 * One statement per case rather than a batch with an `excluded.` set clause.
 * Eight rows once per suite is not where the time goes, and the readable
 * version is the one that will still be correct after someone adds a column.
 */
export async function upsertEvalCases(
  db: Db,
  cases: EvalCase[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const c of cases) {
    const [row] = await db
      .insert(evalCases)
      .values({
        slug: c.slug,
        title: c.title,
        description: c.description,
        ticketPayload: c.ticket,
        expectations: c.expect,
        tags: c.tags,
        enabled: c.enabled,
      })
      .onConflictDoUpdate({
        target: evalCases.slug,
        set: {
          title: c.title,
          description: c.description,
          ticketPayload: c.ticket,
          expectations: c.expect,
          tags: c.tags,
          enabled: c.enabled,
        },
      })
      .returning({ id: evalCases.id });

    ids.set(c.slug, row!.id);
  }

  return ids;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateEvalRunInput {
  workspaceId: string;
  /** Null only when the SOP version was deleted out from under the run. */
  sopVersionId: string | null;
  /** The *logical* model name, per CLAUDE.md. Wire ids live in provider.ts. */
  model: string;
  gitSha: string | null;
  promptVersion: string;
  totalCases: number;
}

export async function createEvalRun(
  db: Db,
  input: CreateEvalRunInput,
): Promise<string> {
  const [row] = await db
    .insert(evalRuns)
    .values({
      workspaceId: input.workspaceId,
      sopVersionId: input.sopVersionId,
      model: input.model,
      gitSha: input.gitSha,
      promptVersion: input.promptVersion,
      status: "running",
      totalCases: input.totalCases,
    })
    .returning({ id: evalRuns.id });

  return row!.id;
}

export interface FinishEvalRunInput {
  status: "completed" | "failed";
  passedCases: number;
  failedCases: number;
  costNanos: number;
  endedAt: Date;
}

export async function finishEvalRun(
  db: Db,
  id: string,
  input: FinishEvalRunInput,
): Promise<void> {
  await db
    .update(evalRuns)
    .set({
      status: input.status,
      passedCases: input.passedCases,
      failedCases: input.failedCases,
      costUsd: costUsd(input.costNanos),
      endedAt: input.endedAt,
    })
    .where(eq(evalRuns.id, id));
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface InsertEvalResultInput {
  workspaceId: string;
  evalRunId: string;
  evalCaseId: string;
  /** Null when the case threw before its agent run row was opened. */
  agentRunId: string | null;
  passed: boolean;
  assertions: Assertion[];
  failureReason: string | null;
  costNanos: number;
  latencyMs: number | null;
}

export async function insertEvalResult(
  db: Db,
  input: InsertEvalResultInput,
): Promise<void> {
  await db.insert(evalResults).values({
    workspaceId: input.workspaceId,
    evalRunId: input.evalRunId,
    evalCaseId: input.evalCaseId,
    agentRunId: input.agentRunId,
    passed: input.passed,
    assertions: input.assertions,
    failureReason: input.failureReason,
    costUsd: costUsd(input.costNanos),
    latencyMs: input.latencyMs,
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One row of the run list. The SOP columns are what label a run "v2 · 14-day". */
export interface EvalRunSummary {
  id: string;
  sopVersionId: string | null;
  /** Null when the SOP version was deleted — the run is still worth listing. */
  sopVersion: number | null;
  /** The window that was in force, so a reader can see what changed. */
  refundWindowDays: number | null;
  model: string;
  gitSha: string | null;
  promptVersion: string | null;
  status: "running" | "completed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** Numeric as text, as Postgres returns it. */
  costUsd: string;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Read `refund.windowDays` out of a stored `policy_config`.
 *
 * Deliberately not `parsePolicyConfig`: this is a display label, and a run
 * whose SOP has since been edited to something the current schema rejects
 * should still appear in the list with a blank label rather than take the whole
 * list down. The enforcement path — `loadActiveSop` — does parse, because there
 * the same row decides whether money moves.
 */
function windowDaysOf(policyConfig: unknown): number | null {
  const config = policyConfig as Partial<PolicyConfig> | null;
  const days = config?.refund?.windowDays;
  return typeof days === "number" ? days : null;
}

/**
 * Newest first.
 *
 * **Left join, not inner.** `sop_version_id` is `on delete set null`, so an
 * inner join would silently drop exactly the runs whose SOP was deleted — the
 * ones a reader is most likely to be looking for when something has gone
 * missing.
 */
export async function listEvalRuns(
  db: Db,
  workspaceId: string,
): Promise<EvalRunSummary[]> {
  const rows = await db
    .select({
      id: evalRuns.id,
      sopVersionId: evalRuns.sopVersionId,
      sopVersion: sopVersions.version,
      policyConfig: sopVersions.policyConfig,
      model: evalRuns.model,
      gitSha: evalRuns.gitSha,
      promptVersion: evalRuns.promptVersion,
      status: evalRuns.status,
      totalCases: evalRuns.totalCases,
      passedCases: evalRuns.passedCases,
      failedCases: evalRuns.failedCases,
      costUsd: evalRuns.costUsd,
      startedAt: evalRuns.startedAt,
      endedAt: evalRuns.endedAt,
    })
    .from(evalRuns)
    .leftJoin(sopVersions, eq(evalRuns.sopVersionId, sopVersions.id))
    .where(eq(evalRuns.workspaceId, workspaceId))
    .orderBy(desc(evalRuns.startedAt));

  return rows.map(({ policyConfig, ...row }) => ({
    ...row,
    refundWindowDays: windowDaysOf(policyConfig),
  }));
}

export interface EvalRunDetail {
  run: EvalRunSummary;
  /** In case order, joined to the slug and title the diff view renders. */
  results: CaseResultRow[];
}

export async function getEvalRun(
  db: Db,
  id: string,
): Promise<EvalRunDetail | null> {
  const [run] = await db
    .select({
      id: evalRuns.id,
      sopVersionId: evalRuns.sopVersionId,
      sopVersion: sopVersions.version,
      policyConfig: sopVersions.policyConfig,
      model: evalRuns.model,
      gitSha: evalRuns.gitSha,
      promptVersion: evalRuns.promptVersion,
      status: evalRuns.status,
      totalCases: evalRuns.totalCases,
      passedCases: evalRuns.passedCases,
      failedCases: evalRuns.failedCases,
      costUsd: evalRuns.costUsd,
      startedAt: evalRuns.startedAt,
      endedAt: evalRuns.endedAt,
    })
    .from(evalRuns)
    .leftJoin(sopVersions, eq(evalRuns.sopVersionId, sopVersions.id))
    .where(eq(evalRuns.id, id))
    .limit(1);

  if (!run) return null;

  const rows = await db
    .select({
      slug: evalCases.slug,
      title: evalCases.title,
      passed: evalResults.passed,
      assertions: evalResults.assertions,
      failureReason: evalResults.failureReason,
      costUsd: evalResults.costUsd,
      latencyMs: evalResults.latencyMs,
      agentRunId: evalResults.agentRunId,
    })
    .from(evalResults)
    .innerJoin(evalCases, eq(evalResults.evalCaseId, evalCases.id))
    .where(eq(evalResults.evalRunId, id))
    .orderBy(evalResults.createdAt);

  const { policyConfig, ...summary } = run;

  return {
    run: { ...summary, refundWindowDays: windowDaysOf(policyConfig) },
    results: rows.map(({ assertions, ...row }) => ({
      ...row,
      assertions: assertions as Assertion[],
    })),
  };
}
