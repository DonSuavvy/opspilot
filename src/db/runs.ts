/**
 * Run and span persistence — the flight recorder's write side.
 *
 * Ordering here is load-bearing. `run_spans.run_id` is `notNull` with an FK to
 * `agent_runs.id`, so the run row must exist *before* span 0 is emitted, and
 * the id threaded into `ToolContext.runId` has to be the one Postgres actually
 * generated. Inserting with a client-side placeholder and letting
 * `defaultRandom()` produce a different uuid is the shape of that bug.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import {
  decideReservation,
  type BudgetConfig,
  type BudgetRefusal,
} from "../agent/budget";
import type { AgentLoopResult } from "../agent/loop";
import { spanToRow } from "../agent/trace";
import type { SpanRow } from "../agent/trace";
import type { Db } from "./client";
import { agentRuns, runSpans } from "./schema";

const NANOS_PER_USD = 1_000_000_000;

/** How far back `runsPerMinute` looks. Matches `retryAfterSeconds`. */
const RATE_WINDOW_MS = 60_000;

/**
 * A handle that may be the pool or a transaction on it.
 *
 * Drizzle's transaction object is not assignable to `Db`, so every read that
 * has to run *inside* the reservation lock would otherwise need a duplicate.
 * Derived from `Db` itself rather than reassembled from four generic
 * parameters, so it cannot drift if the driver changes.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Nano-dollars to the `numeric(12,6)` string the column holds.
 *
 * Routed through `spanToRow` like every other cost in this file, so a run
 * total and its spans can never be converted two different ways — and so the
 * same negative/overflow guard runs before Postgres raises an opaque CHECK
 * violation three layers below the arithmetic that produced it.
 */
export function runCostUsd(nanos: number, label = "run total"): string {
  const at = new Date(0);
  return spanToRow(
    { workspaceId: "", runId: "" },
    {
      seq: -1,
      type: "llm_call",
      name: label,
      input: null,
      output: null,
      isError: false,
      usage: null,
      costNanos: nanos,
      estimated: false,
      latencyMs: 0,
      startedAt: at,
      endedAt: at,
    },
  ).costUsd;
}

function usdToNanos(usd: string | null): number {
  return Math.round(Number(usd ?? 0) * NANOS_PER_USD);
}

/**
 * Today's spend for a workspace, in nano-dollars — the baseline the loop's
 * pre-flight adds its own in-run accrual to.
 *
 * `cost_usd` is `numeric(12,6)`, i.e. dollars at micro-dollar resolution, and
 * `pg` hands numerics back as strings precisely so a large sum cannot lose
 * precision through a float. `Number()` once, at the end, on a figure bounded
 * by the daily cap.
 */
export async function spentTodayNanos(
  db: DbOrTx,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        gte(agentRuns.startedAt, midnight),
      ),
    );

  return Math.round(Number(row?.total ?? 0) * NANOS_PER_USD);
}

/**
 * How a run asks permission to exist.
 *
 * **The defect this closes.** `spentTodayNanos` sums `agent_runs.cost_usd`,
 * and until now `finishRun` was that column's only writer — so a run *in
 * flight* contributed exactly zero to the baseline every other run read. Two
 * concurrent `POST /api/agent/run` calls each saw the same starting figure and
 * each was cleared to spend the whole daily cap; ten concurrent calls, ten
 * times the cap. The per-call accrual added on Day 2 fixed the sequential case
 * *inside* one run and did nothing across runs.
 *
 * **The fix is to reserve, not to read harder.** No amount of care in the
 * SELECT helps, because the number it wants does not exist yet. So the run
 * writes its own estimate into `cost_usd` before it starts, under a row lock
 * on its workspace, and every concurrent reservation queues behind that lock
 * and sees it. `finishRun` later replaces the estimate with the actual.
 *
 * The lock is on `workspaces` rather than on `agent_runs`, because the thing
 * being serialised is *the decision*, and there is no row to lock for a run
 * that does not exist yet. One workspace's burst therefore never blocks
 * another's — which matters the moment public sandboxes exist.
 */
export type Reservation =
  | {
      ok: true;
      runId: string;
      /**
       * Today's spend **excluding** this reservation.
       *
       * The loop adds its own accrual to this figure before every call. Had
       * the reservation been included, the run would be charged for itself
       * twice and refuse itself roughly one call early.
       */
      baselineNanos: number;
      /**
       * What this run had already cost before this invocation — zero for a
       * fresh run, the first half's actual for a resumed one. Threaded back
       * into `accrueRunCost` and `finishRun`, which are absolute rather than
       * incremental writes, so neither can lose it or double it.
       */
      priorNanos: number;
    }
  | {
      ok: false;
      reason: BudgetRefusal;
      retryAfterSeconds?: number;
      remainingNanos: number;
    };

export interface ReserveRunInput {
  workspaceId: string;
  /**
   * Null for an eval run. `agent_runs.ticket_id` has always been nullable —
   * an eval case is not a row in `tickets` (see `eval_cases`, the one table
   * with no workspace). The `eval_results` row is what points back at it.
   */
  ticketId: string | null;
  model: string;
  sopVersionId?: string | null;
  /** Injected, never `Date.now()` — and written to `started_at`, so the rate
   * window is measured against the same instant the decision used. */
  now: Date;
  config: BudgetConfig;
  estimatedRunNanos: number;
  /** False when the rate card had no `verifiedOn` — see the safety factor. */
  rateVerified: boolean;
}

/**
 * The kill switch answered without a database round trip.
 *
 * An operator pulling it wants everything to stop, not to queue behind a row
 * lock first. Headroom is reported as zero rather than as the real figure:
 * nothing may be spent while the switch is on, and reading the true number
 * would need exactly the round trip being skipped.
 */
function killSwitched(config: BudgetConfig): Reservation | null {
  return config.killSwitch
    ? { ok: false, reason: "kill_switch", remainingNanos: 0 }
    : null;
}

/**
 * Serialise every reservation for this workspace.
 *
 * `for update` on the workspace row, held to the end of the transaction. Two
 * concurrent reservations therefore run the read-decide-write sequence one
 * after the other, which is the whole mechanism: the second one's SELECT
 * happens after the first one's INSERT.
 */
async function lockWorkspace(tx: DbOrTx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select 1 from workspaces where id = ${workspaceId} for update`,
  );
}

/** Runs *started* in this workspace inside the rate window. */
async function runsInWindow(
  tx: DbOrTx,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        gte(agentRuns.startedAt, new Date(now.getTime() - RATE_WINDOW_MS)),
      ),
    );

  return Number(row?.n ?? 0);
}

function refused(
  decision: ReturnType<typeof decideReservation>,
): Reservation & { ok: false } {
  return {
    ok: false,
    // Only reachable when `allowed` is false, where `reason` is never null.
    reason: decision.reason!,
    retryAfterSeconds: decision.retryAfterSeconds,
    remainingNanos: decision.remainingNanos,
  };
}

/**
 * Open a run, charged up front, or refuse it before it costs anything.
 *
 * `.returning()` rather than a client-side uuid: the returned id is what every
 * span's FK points at and what the SSE stream reports, so it has to be the row
 * that actually exists.
 *
 * A refusal writes nothing, so the transaction commits empty rather than
 * rolling back — the two release the lock at the same instant and leave the
 * same state behind, and returning a value is simpler than throwing one.
 */
export async function reserveRun(
  db: Db,
  input: ReserveRunInput,
): Promise<Reservation> {
  const stopped = killSwitched(input.config);
  if (stopped) return stopped;

  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);

    const baselineNanos = await spentTodayNanos(
      tx,
      input.workspaceId,
      input.now,
    );

    const decision = decideReservation({
      spentTodayNanos: baselineNanos,
      runsInLastMinute: await runsInWindow(tx, input.workspaceId, input.now),
      estimatedRunNanos: input.estimatedRunNanos,
      rateVerified: input.rateVerified,
      config: input.config,
    });

    if (!decision.allowed) return refused(decision);

    const [row] = await tx
      .insert(agentRuns)
      .values({
        workspaceId: input.workspaceId,
        ticketId: input.ticketId,
        sopVersionId: input.sopVersionId ?? null,
        // The *logical* model name, per CLAUDE.md: wire ids live only in
        // provider.ts. The exact wire id is recorded on each llm_call span.
        model: input.model,
        status: "running",
        // Explicit rather than `defaultNow()`, so the row this reservation
        // writes falls inside the same rate window the decision measured.
        startedAt: input.now,
        costUsd: runCostUsd(input.estimatedRunNanos, "reservation"),
      })
      .returning({ id: agentRuns.id });

    return {
      ok: true,
      runId: row!.id,
      baselineNanos,
      priorNanos: 0,
    };
  });
}

export interface ReserveResumeInput {
  runId: string;
  workspaceId: string;
  now: Date;
  config: BudgetConfig;
  estimatedRunNanos: number;
  rateVerified: boolean;
}

/**
 * The same gate for the second half of a paused run.
 *
 * A resume is a fresh set of model calls against the same shared account, so
 * it is exactly as capable of blowing the cap as a new run and is charged the
 * same way. The difference is that the row already exists and already carries
 * the first invocation's cost, so the reservation is *added* to it and
 * `priorNanos` reports what was there — which is how `finishRun` avoids
 * overwriting the first half with the second half's total.
 */
export async function reserveResume(
  db: Db,
  input: ReserveResumeInput,
): Promise<Reservation> {
  const stopped = killSwitched(input.config);
  if (stopped) return stopped;

  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);

    const baselineNanos = await spentTodayNanos(
      tx,
      input.workspaceId,
      input.now,
    );

    const decision = decideReservation({
      spentTodayNanos: baselineNanos,
      runsInLastMinute: await runsInWindow(tx, input.workspaceId, input.now),
      estimatedRunNanos: input.estimatedRunNanos,
      rateVerified: input.rateVerified,
      config: input.config,
    });

    if (!decision.allowed) return refused(decision);

    const [existing] = await tx
      .select({ costUsd: agentRuns.costUsd })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .limit(1);

    if (!existing) {
      throw new Error(`reserveResume: no run ${input.runId}`);
    }

    const priorNanos = usdToNanos(existing.costUsd);

    await tx
      .update(agentRuns)
      .set({
        costUsd: runCostUsd(priorNanos + input.estimatedRunNanos, "reservation"),
      })
      .where(eq(agentRuns.id, input.runId));

    return { ok: true, runId: input.runId, baselineNanos, priorNanos };
  });
}

/**
 * Charge a run for what it has actually spent so far, as it spends it.
 *
 * Absolute, not incremental: the row is set to `prior + max(reservation,
 * accrued)`, which is idempotent and monotone no matter how many times it is
 * called. The obvious incremental form —
 * `cost_usd = cost_usd - reservation + greatest(reservation, accrued)` —
 * is correct exactly once. The second time accrued exceeds the reservation it
 * adds the excess to a row that already contains it: with a $0.02 reservation,
 * accruals of $0.025 then $0.030 leave the row reading $0.035. `finishRun`
 * then subtracts the reservation from that inflated figure and compounds it.
 * There is only ever one writer per run row, so the absolute form is safe.
 *
 * The reservation is a *floor*, never released early. A run that has spent
 * less than it reserved keeps holding the reservation, because the money it is
 * still about to spend is exactly what concurrent runs need to see.
 */
export async function accrueRunCost(
  db: Db,
  runId: string,
  input: {
    priorNanos: number;
    reservationNanos: number;
    accruedNanos: number;
  },
): Promise<void> {
  const held =
    input.priorNanos + Math.max(input.reservationNanos, input.accruedNanos);

  await db
    .update(agentRuns)
    .set({ costUsd: runCostUsd(held, "accrual") })
    .where(eq(agentRuns.id, runId));
}

/**
 * Give back a reservation a run turned out not to need.
 *
 * The run never started — a decision was refused after it was taken, say — so
 * the row goes back to whatever it cost before. Expressed through
 * `accrueRunCost` so there is one place that knows the row holds
 * `prior + held`.
 */
export async function releaseReservation(
  db: Db,
  runId: string,
  priorNanos: number,
): Promise<void> {
  await accrueRunCost(db, runId, {
    priorNanos,
    reservationNanos: 0,
    accruedNanos: 0,
  });
}

export async function writeSpan(db: Db, row: SpanRow): Promise<void> {
  await db.insert(runSpans).values(row);
}

/** `AgentLoopStatus` is finer-grained than the column's enum. */
function runStatus(result: AgentLoopResult) {
  switch (result.status) {
    case "completed":
      return "completed" as const;
    case "paused_for_approval":
      return "paused_for_approval" as const;
    // A refusal and a budget refusal are both "this run did not resolve the
    // ticket", which is what `failed` means here. The distinguishing detail
    // survives on `refusal_category` and `error`, so nothing is lost.
    default:
      return "failed" as const;
  }
}

/**
 * Close a run, replacing its reservation with what it actually cost.
 *
 * `priorNanos` is what the run had cost *before* this invocation — zero for a
 * fresh run, the first half's actual for a resumed one — so the row lands on
 * `prior + actual`. The previous version wrote `result.costNanos` flat, which
 * on a resumed run is only the second invocation's accrual: the first half's
 * cost was silently overwritten and lost, both from the run's own row and from
 * every later `spentTodayNanos` read.
 *
 * A run whose process dies between reserving and finishing keeps its
 * reservation for the rest of the day. That is the conservative direction: the
 * cap under-spends rather than over-spends, and the window is one day.
 */
export async function finishRun(
  db: Db,
  runId: string,
  result: AgentLoopResult,
  endedAt: Date,
  reservation: { priorNanos: number } = { priorNanos: 0 },
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: runStatus(result),
      outcome: result.outcome ?? null,
      serializedMessages: result.serializedMessages,
      iterations: result.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadInputTokens,
      cacheWriteTokens: result.usage.cacheCreationInputTokens,
      costUsd: runCostUsd(reservation.priorNanos + result.costNanos),
      refusalCategory: result.refusal?.category ?? null,
      error: result.error,
      endedAt,
    })
    .where(eq(agentRuns.id, runId));
}
