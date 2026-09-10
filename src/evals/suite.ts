/**
 * The suite runner — eight cases, one `eval_runs` row, one pin.
 *
 * **Sequential, deliberately** — for two reasons, and only one of them used to
 * be true. The suite once relied on the ordering for its budget guard: case
 * *n* read a baseline that already included cases 1..n-1 because `finishRun`
 * had landed. That crutch is gone. `reserveRun` charges a run before it starts
 * and under a row lock, so eight concurrent cases would now be counted
 * correctly. The ordering stays because of the *other* reason: eight cases
 * fired at once is roughly 25 model calls in under a minute against an account
 * shared with a law firm's live generation, and that is precisely the burst
 * that cost the first calibration run three cases to a Bedrock 429.
 *
 * **A budget refusal is a result, not a crash.** A case the guard turns away
 * is recorded, named `budget: <reason>`, and counted as failed — and every
 * case behind it is refused unattempted, because if the cap is reached on case
 * two then cases three through eight cannot pass either and firing six more
 * reservations to be told no six more times is the burst again. The suite
 * still reports `completed`: `failed` is for a suite that broke.
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
import {
  ESTIMATED_RUN_NANOS,
  type BudgetConfig,
  type BudgetRefusal,
} from "@/agent/budget";
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
import { finishRun, reserveRun, writeSpan } from "@/db/runs";
import { getSopVersion, loadActiveSop } from "@/db/sops";

import type { EvalCase } from "./case";
import { promptVersion } from "./pin";
import { runCase } from "./runner";
import type { Assertion } from "./types";

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
  reserveRun: typeof reserveRun;
  finishRun: typeof finishRun;
  writeSpan: typeof writeSpan;
  createOpsData: typeof createOpsData;
  getSopVersion: typeof getSopVersion;
  loadActiveSop: typeof loadActiveSop;
}

const DB_PERSISTENCE: EvalPersistence = {
  upsertEvalCases,
  createEvalRun,
  insertEvalResult,
  finishEvalRun,
  reserveRun,
  finishRun,
  writeSpan,
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

/**
 * The refusals that stay true for the rest of the suite.
 *
 * Typed as `BudgetRefusal[]` rather than as string literals so a renamed or
 * mistyped member is a compile error rather than a case quietly re-attempted
 * against an exhausted cap. `rate_limited` is absent on purpose — see
 * `budgetRefusal` in `runEvalSuite`.
 */
const STICKY_REFUSALS: readonly BudgetRefusal[] = [
  "kill_switch",
  "daily_cap_reached",
  "run_would_exceed_cap",
];

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
  /**
   * Sticky, but only for the refusals that stay true.
   *
   * Once the day's money is gone every remaining case is refused without a
   * reservation of its own — the cap does not un-reach itself, and re-asking
   * eight times is the burst the guard exists to prevent. `rate_limited` is
   * deliberately *not* in that set: it is a wait rather than a limit, it
   * clears inside sixty seconds, and the golden suite is eight sequential
   * runs against a default of ten a minute, so it is the refusal most likely
   * to land mid-suite. Made sticky it turned one throttled case into six red
   * ones that were never attempted.
   *
   * Kept separate from `threw` on purpose: neither turns the suite's status
   * to `failed`.
   */
  let budgetRefusal: BudgetRefusal | null = null;

  const rateVerified = rates.verifiedOn !== null;

  for (const c of enabled) {
    /** This case's refusal, sticky or not. `budgetRefusal` only holds the
     * sticky ones, so a rate-limited case still needs somewhere to say why. */
    let caseRefusal: BudgetRefusal | null = budgetRefusal;
    const startedAt = new Date();
    let agentRunId: string | null = null;
    let priorNanos = 0;
    // Whether the `agent_runs` row is already closed. The catch below has to
    // tell a run that never finished from one that finished fine and then hit
    // a bookkeeping failure — re-finishing the second as failed would replace
    // a true row with a false one.
    let runFinished = false;

    try {
      if (budgetRefusal === null) {
        // Charged before a token is bought, and under a lock, so a case is
        // visible to every concurrent run from the moment it starts rather
        // than from the moment it finishes.
        const reservation = await persist.reserveRun(db, {
          workspaceId,
          // An eval case is not a ticket. `eval_results.eval_case_id` is what
          // points back at what was run.
          ticketId: null,
          model,
          sopVersionId: sop.versionId,
          now,
          config: input.budgetConfig,
          estimatedRunNanos: ESTIMATED_RUN_NANOS,
          rateVerified,
        });

        if (reservation.ok) {
          agentRunId = reservation.runId;
          priorNanos = reservation.priorNanos;

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
            budget: {
              config: input.budgetConfig,
              spentTodayNanos: reservation.baselineNanos,
            },
            estimatedCallNanos: ESTIMATED_RUN_NANOS,
            clock: () => new Date(),
            emit: async (span) => {
              await persist.writeSpan(
                db,
                spanToRow({ workspaceId, runId: agentRunId! }, span),
              );
            },
          });

          const endedAt = new Date();
          await persist.finishRun(db, agentRunId, run.result, endedAt, {
            priorNanos,
          });
          runFinished = true;

          // Charged as soon as it is known, so the next case's baseline sees
          // it even if the bookkeeping below throws. The counters are not:
          // they move only once the case is recorded and announced, or the
          // catch would count it a second time.
          costNanos += run.result.costNanos;

          const latencyMs = endedAt.getTime() - startedAt.getTime();
          const caseCost = toUsd(run.result.costNanos);

          /**
           * A case can go red for two very different reasons, and the
           * scorecard has to say which. The scorer only ever sees the
           * *outcome*, so a run the provider throttled to death reads exactly
           * like a run the agent botched — the first calibration run reported
           * three cases as `expected status "completed", got "failed"` when
           * the real cause was a Bedrock 429 sitting in `agent_runs.error`.
           * Naming it here keeps the scorer pure and the scorecard honest.
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

          continue;
        }

        caseRefusal = reservation.reason;
        if (STICKY_REFUSALS.includes(reservation.reason)) {
          budgetRefusal = reservation.reason;
        }
      }

      /**
       * Refused. No row was opened and no model was called, so there is
       * nothing to finish — only a result to record, named so the scorecard
       * says *why* it is red rather than reporting a mysterious failure.
       */
      failed += 1;
      const failureReason = `budget: ${caseRefusal}`;
      const latencyMs = Date.now() - startedAt.getTime();

      await persist.insertEvalResult(db, {
        workspaceId,
        evalRunId,
        evalCaseId: caseIds.get(c.slug)!,
        agentRunId: null,
        passed: false,
        assertions: [],
        failureReason,
        costNanos: 0,
        latencyMs,
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
        agentRunId: null,
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

      /**
       * Close the row the case opened. A `running` row still holds its
       * reservation, so leaving one here would keep the day's headroom
       * consumed by a run that is not running.
       *
       * Swallowed on purpose: this is recovery, and a failure to record the
       * failure must not replace the error that caused it.
       */
      if (agentRunId !== null && !runFinished) {
        await persist
          .finishRun(db, agentRunId, threwResult(failureReason), new Date(), {
            priorNanos,
          })
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
