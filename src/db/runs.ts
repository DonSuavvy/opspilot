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

import type { AgentLoopResult } from "../agent/loop";
import { spanToRow } from "../agent/trace";
import type { SpanRow } from "../agent/trace";
import type { Db } from "./client";
import { agentRuns, runSpans } from "./schema";

const NANOS_PER_USD = 1_000_000_000;

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
  db: Db,
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
 * Open a run and return the id Postgres generated.
 *
 * `.returning()` rather than a client-side uuid: the returned id is what every
 * span's FK points at and what the SSE stream reports, so it has to be the row
 * that actually exists.
 */
export async function startRun(
  db: Db,
  input: {
    workspaceId: string;
    ticketId: string;
    model: string;
    sopVersionId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      workspaceId: input.workspaceId,
      ticketId: input.ticketId,
      sopVersionId: input.sopVersionId ?? null,
      // The *logical* model name, per CLAUDE.md: wire ids live only in
      // provider.ts. The exact wire id is recorded on each llm_call span.
      model: input.model,
      status: "running",
    })
    .returning({ id: agentRuns.id });

  return row!.id;
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

export async function finishRun(
  db: Db,
  runId: string,
  result: AgentLoopResult,
  endedAt: Date,
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
      // Reuse the span mapper so the run total and its spans can never be
      // converted two different ways — and so the same CHECK-range guard runs.
      costUsd: spanToRow(
        { workspaceId: "", runId },
        {
          seq: -1,
          type: "llm_call",
          name: "run total",
          input: null,
          output: null,
          isError: false,
          usage: null,
          costNanos: result.costNanos,
          estimated: result.estimated,
          latencyMs: 0,
          startedAt: endedAt,
          endedAt,
        },
      ).costUsd,
      refusalCategory: result.refusal?.category ?? null,
      error: result.error,
      endedAt,
    })
    .where(eq(agentRuns.id, runId));
}
