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
import type { AgentLoopResult, MessageCreator } from "@/agent/loop";
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

/**
 * Every side effect the suite has, in one injectable bag.
 *
 * Not ceremony: the two bugs this seam exists for are both in the *failure*
 * path — a case that throws after its `agent_runs` row is open must still be
 * finished and must be counted exactly once — and there is no way to provoke a
 * throw from `insertEvalResult` against a real database without breaking it.
 * The default is the real module, so no caller changes.
 */
export interface EvalPersistence {
  upsertEvalCases: typeof upsertEvalCases;
  createEvalRun: typeof createEvalRun;
  insertEvalResult: typeof insertEvalResult;
  finishEvalRun: typeof finishEvalRun;
  startRun: typeof startRun;
  finishRun: typeof finishRun;
  writeSpan: typeof writeSpan;
  spentTodayNanos: typeof spentTodayNanos;
  createOpsData: typeof createOpsData;
  getSopVersion: typeof getSopVersion;
  loadActiveSop: typeof loadActiveSop;
}

const DB_PERSISTENCE: EvalPersistence = {
  upsertEvalCases,
  createEvalRun,
  insertEvalResult,
  finishEvalRun,
  startRun,
  finishRun,
  writeSpan,
  spentTodayNanos,
  createOpsData,
  getSopVersion,
  loadActiveSop,
};

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
  /** Defaults to the real `src/db` functions; injected in tests. */
  persist?: EvalPersistence;
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

/**
 * What `finishRun` is told about a case that threw before the loop returned.
 *
 * A whole `AgentLoopResult` rather than a cast: `finishRun` writes every field
 * of it, `runStatus` branches on `status`, and `agent_runs.error` is the only
 * place the reason survives once the suite has moved on. Zeroed usage and cost
 * are honest — the throw happened before the loop reported either.
 */
function threwResult(message: string): AgentLoopResult {
  return {
    status: "failed",
    outcome: null,
    iterations: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    costNanos: 0,
    estimated: false,
    messages: [],
    serializedMessages: null,
    pendingApproval: null,
    refusal: null,
    budgetReason: null,
    error: message,
  };
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
  const persist = input.persist ?? DB_PERSISTENCE;

  const enabled = input.cases.filter((c) => c.enabled);
  const caseIds = await persist.upsertEvalCases(db, enabled);

  // Pinned once. A version id resolves that exact document; without one the
  // run takes whatever is active *at the start* and records which it was, so
  // an edit landing mid-suite cannot change what half the cases were scored
  // against.
  const sop = input.sopVersionId
    ? await persist.getSopVersion(db, workspaceId, input.sopVersionId)
    : await persist.loadActiveSop(db, workspaceId);

  const system = cachedSystem(
    compileSop({
      bodyMarkdown: sop.bodyMarkdown,
      policyConfig: sop.policyConfig,
    }),
  );
  const pin = promptVersion(system);

  const evalRunId = await persist.createEvalRun(db, {
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
    // Whether the `agent_runs` row is already closed. The catch below has to
    // tell a run that never finished from one that finished fine and then hit
    // a bookkeeping failure — re-finishing the second as failed would replace
    // a true row with a false one.
    let runFinished = false;

    try {
      agentRunId = await persist.startRun(db, {
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
      const baseline = await persist.spentTodayNanos(db, workspaceId, now);

      const run = await runCase(c, {
        registry,
        createMessage: input.createMessage,
        model: wireModel,
        rates,
        system,
        policyConfig: sop.policyConfig,
        data: persist.createOpsData(db, { workspaceId, runId: agentRunId }),
        workspaceId,
        runId: agentRunId,
        now,
        budget: { config: input.budgetConfig, spentTodayNanos: baseline },
        estimatedCallNanos: ESTIMATED_CALL_NANOS,
        clock: () => new Date(),
        emit: async (span) => {
          await persist.writeSpan(
            db,
            spanToRow({ workspaceId, runId: agentRunId! }, span),
          );
        },
      });

      const endedAt = new Date();
      await persist.finishRun(db, agentRunId, run.result, endedAt);
      runFinished = true;

      // Charged as soon as it is known, so the next case's baseline sees it
      // even if the bookkeeping below throws. The counters are not: they move
      // only once the case is recorded and announced, or the catch would count
      // it a second time.
      costNanos += run.result.costNanos;

      const latencyMs = endedAt.getTime() - startedAt.getTime();
      const caseCost = toUsd(run.result.costNanos);

      /**
       * A case can go red for two very different reasons, and the scorecard
       * has to say which. The scorer only ever sees the *outcome*, so a run
       * the provider throttled to death reads exactly like a run the agent
       * botched — the first calibration run reported three cases as
       * `expected status "completed", got "failed"` when the real cause was
       * a Bedrock 429 sitting in `agent_runs.error`. Naming it here keeps the
       * scorer pure and the scorecard honest.
       */
      const failureReason =
        run.score.failureReason !== null && run.result.error
          ? `${run.score.failureReason} — the run did not finish: ${run.result.error}`
          : run.score.failureReason;

      await persist.insertEvalResult(db, {
        workspaceId,
        evalRunId,
        evalCaseId: caseIds.get(c.slug)!,
        agentRunId,
        passed: run.score.passed,
        assertions: run.score.assertions,
        failureReason,
        costNanos: run.result.costNanos,
        latencyMs,
      });

      await emit({
        type: "case",
        slug: c.slug,
        title: c.title,
        passed: run.score.passed,
        failureReason,
        assertions: run.score.assertions,
        costUsd: caseCost,
        latencyMs,
        agentRunId,
      });

      if (run.score.passed) passed += 1;
      else failed += 1;
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

      /**
       * Close the row the case opened. A `running` row with a null cost is
       * invisible to `spentTodayNanos`, so leaving one here would hand every
       * later case a baseline that under-reports the day's spend — the one
       * thing the sequential ordering above exists to prevent.
       *
       * Swallowed on purpose: this is recovery, and a failure to record the
       * failure must not replace the error that caused it.
       */
      if (agentRunId !== null && !runFinished) {
        await persist
          .finishRun(db, agentRunId, threwResult(failureReason), new Date())
          .catch(() => {});
      }

      await persist.insertEvalResult(db, {
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

  await persist.finishEvalRun(db, evalRunId, {
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
