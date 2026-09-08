/**
 * The suite runner — eight cases, one `eval_runs` row, one pin.
 *
 * **Sequential, deliberately.** The obvious optimisation here is `Promise.all`
 * over the cases, and it would break the budget guard. `spentTodayNanos` sums
 * `agent_runs.cost_usd`, and `finishRun` is that column's only writer, so a run
 * still in flight contributes nothing to the baseline every other run reads.
 * Eight concurrent cases would each see the same starting figure and each be
 * cleared to spend up to the full daily cap. Running them in order means case
 * *n* reads a baseline that already includes cases 1..n-1 — the guard works
 * because of the ordering, not despite it. (CLAUDE.md logs the cross-run
 * version of this as still open; the suite is the one caller that must not
 * make it worse.)
 *
 * **One system prompt, compiled once.** Every case in a run must be scored
 * against the same bytes, or `prompt_version` is a lie and the diff attributes
 * a regression to the wrong thing.
 *
 * **`now` and the clock are different things.** `now` is the injected instant
 * the policy engine measures refund windows from — frozen for the whole suite,
 * so a case cannot flip because it ran either side of midnight. The clock is
 * wall time, and it only ever produces span timestamps and latencies. Exactly
 * the split `/api/agent/run` uses.
 */
import { cachedSystem } from "@/agent/cache";
import { compileSop } from "@/agent/sop";
import type { BudgetConfig } from "@/agent/budget";
import type { MessageCreator } from "@/agent/loop";
import type { LogicalModel, Provider } from "@/agent/provider";
import { buildRegistry } from "@/agent/registry";
import { spanToRow } from "@/agent/trace";
import { TOOLS } from "@/agent/tools";
import type { Db } from "@/db/client";
import {
  createEvalRun,
  finishEvalRun,
  insertEvalResult,
  upsertEvalCases,
} from "@/db/evals";
import { createOpsData } from "@/db/ops-data";
import { finishRun, spentTodayNanos, startRun, writeSpan } from "@/db/runs";
import { getSopVersion, loadActiveSop } from "@/db/sops";

import type { EvalCase } from "./case";
import { promptVersion } from "./pin";
import { runCase } from "./runner";
import type { Assertion } from "./types";

/**
 * What one model call is assumed to cost, for the budget pre-flight only.
 * Same figure `/api/agent/run` uses; see the note there.
 */
const ESTIMATED_CALL_NANOS = 20_000_000; // $0.02

/** Emitted once the run row exists, so the client can name what it is watching. */
export interface EvalRunStartedEvent {
  type: "run";
  evalRunId: string;
  sopVersionId: string;
  sopVersion: number;
  model: LogicalModel;
  gitSha: string | null;
  promptVersion: string;
  totalCases: number;
}

export interface EvalCaseFinishedEvent {
  type: "case";
  slug: string;
  title: string;
  passed: boolean;
  failureReason: string | null;
  assertions: Assertion[];
  costUsd: string;
  latencyMs: number;
  agentRunId: string | null;
}

export interface EvalRunFinishedEvent {
  type: "done";
  evalRunId: string;
  passed: number;
  failed: number;
  total: number;
  costUsd: string;
}

export type EvalSuiteEvent =
  | EvalRunStartedEvent
  | EvalCaseFinishedEvent
  | EvalRunFinishedEvent;

export interface RunEvalSuiteInput {
  db: Db;
  workspaceId: string;
  /** Null runs against whatever is active — the ordinary case. */
  sopVersionId: string | null;
  model: LogicalModel;
  cases: EvalCase[];
  createMessage: MessageCreator;
  provider: Provider;
  budgetConfig: BudgetConfig;
  gitSha: string | null;
  /** Frozen for the whole suite. Never `Date.now()` inside a case. */
  now: Date;
  emit: (event: EvalSuiteEvent) => void | Promise<void>;
}

export interface EvalSuiteSummary {
  evalRunId: string;
  passed: number;
  failed: number;
  total: number;
  costNanos: number;
  promptVersion: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reuse the span mapper, so a run total and its spans convert identically. */
function toUsd(costNanos: number): string {
  const at = new Date(0);
  return spanToRow(
    { workspaceId: "", runId: "" },
    {
      seq: -1,
      type: "llm_call",
      name: "total",
      input: null,
      output: null,
      isError: false,
      usage: null,
      costNanos,
      estimated: false,
      latencyMs: 0,
      startedAt: at,
      endedAt: at,
    },
  ).costUsd;
}

export async function runEvalSuite(
  input: RunEvalSuiteInput,
): Promise<EvalSuiteSummary> {
  const { db, workspaceId, model, now, emit } = input;

  const enabled = input.cases.filter((c) => c.enabled);
  const caseIds = await upsertEvalCases(db, enabled);

  // Pinned once. A version id resolves that exact document; without one the
  // run takes whatever is active *at the start* and records which it was, so
  // an edit landing mid-suite cannot change what half the cases were scored
  // against.
  const sop = input.sopVersionId
    ? await getSopVersion(db, workspaceId, input.sopVersionId)
    : await loadActiveSop(db, workspaceId);

  const system = cachedSystem(
    compileSop({
      bodyMarkdown: sop.bodyMarkdown,
      policyConfig: sop.policyConfig,
    }),
  );
  const pin = promptVersion(system);

  const evalRunId = await createEvalRun(db, {
    workspaceId,
    sopVersionId: sop.versionId,
    // The logical name, per CLAUDE.md — the wire id belongs on the spans.
    model,
    gitSha: input.gitSha,
    promptVersion: pin,
    totalCases: enabled.length,
  });

  await emit({
    type: "run",
    evalRunId,
    sopVersionId: sop.versionId,
    sopVersion: sop.version,
    model,
    gitSha: input.gitSha,
    promptVersion: pin,
    totalCases: enabled.length,
  });

  const registry = buildRegistry(TOOLS);
  const wireModel = input.provider.modelId(model);
  const rates = input.provider.rateCard(model);

  let passed = 0;
  let failed = 0;
  let costNanos = 0;
  let threw = false;

  for (const c of enabled) {
    const startedAt = new Date();
    let agentRunId: string | null = null;

    try {
      agentRunId = await startRun(db, {
        workspaceId,
        // An eval case is not a ticket. `eval_results.eval_case_id` is what
        // points back at what was run.
        ticketId: null,
        model,
        sopVersionId: sop.versionId,
      });

      // Re-read per case rather than once before the loop: the previous case's
      // `finishRun` has landed by now, so this baseline includes it. That is
      // the whole reason the suite is sequential.
      const baseline = await spentTodayNanos(db, workspaceId, now);

      const run = await runCase(c, {
        registry,
        createMessage: input.createMessage,
        model: wireModel,
        rates,
        system,
        policyConfig: sop.policyConfig,
        data: createOpsData(db, { workspaceId, runId: agentRunId }),
        workspaceId,
        runId: agentRunId,
        now,
        budget: { config: input.budgetConfig, spentTodayNanos: baseline },
        estimatedCallNanos: ESTIMATED_CALL_NANOS,
        clock: () => new Date(),
        emit: async (span) => {
          await writeSpan(
            db,
            spanToRow({ workspaceId, runId: agentRunId! }, span),
          );
        },
      });

      const endedAt = new Date();
      await finishRun(db, agentRunId, run.result, endedAt);

      costNanos += run.result.costNanos;
      if (run.score.passed) passed += 1;
      else failed += 1;

      const latencyMs = endedAt.getTime() - startedAt.getTime();
      const caseCost = toUsd(run.result.costNanos);

      await insertEvalResult(db, {
        workspaceId,
        evalRunId,
        evalCaseId: caseIds.get(c.slug)!,
        agentRunId,
        passed: run.score.passed,
        assertions: run.score.assertions,
        failureReason: run.score.failureReason,
        costNanos: run.result.costNanos,
        latencyMs,
      });

      await emit({
        type: "case",
        slug: c.slug,
        title: c.title,
        passed: run.score.passed,
        failureReason: run.score.failureReason,
        assertions: run.score.assertions,
        costUsd: caseCost,
        latencyMs,
        agentRunId,
      });
    } catch (error) {
      /**
       * A case that throws is a failed case, not a failed suite. The other
       * seven still carry information, and a run that died on case three
       * would otherwise leave a `running` row and no results at all — which
       * reads as an infrastructure problem rather than as the finding it is.
       * The run's own status carries the distinction.
       */
      threw = true;
      failed += 1;

      const failureReason = `case threw: ${errorText(error)}`;
      const latencyMs = Date.now() - startedAt.getTime();

      await insertEvalResult(db, {
        workspaceId,
        evalRunId,
        evalCaseId: caseIds.get(c.slug)!,
        agentRunId,
        passed: false,
        assertions: [],
        failureReason,
        costNanos: 0,
        latencyMs,
      }).catch(() => {
        // Nothing left to do; the summary below still reports the failure.
      });

      await emit({
        type: "case",
        slug: c.slug,
        title: c.title,
        passed: false,
        failureReason,
        assertions: [],
        costUsd: "0.000000",
        latencyMs,
        agentRunId,
      });
    }
  }

  await finishEvalRun(db, evalRunId, {
    status: threw ? "failed" : "completed",
    passedCases: passed,
    failedCases: failed,
    costNanos,
    endedAt: new Date(),
  });

  await emit({
    type: "done",
    evalRunId,
    passed,
    failed,
    total: enabled.length,
    costUsd: toUsd(costNanos),
  });

  return {
    evalRunId,
    passed,
    failed,
    total: enabled.length,
    costNanos,
    promptVersion: pin,
  };
}
