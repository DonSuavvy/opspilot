/**
 * One eval case, run once.
 *
 * The join between three things that are each independently testable and
 * otherwise never meet: the agent loop, the write barrier, and the scorer.
 * Every collaborator arrives as an argument — the registry, the model, the
 * rate card, the data seam, the clock — which is what lets a case run in
 * vitest against a scripted `MessageCreator` with no key and no database, and
 * against Bedrock and Postgres from `runEvalSuite` with no code change.
 *
 * **The write barrier is applied here, not by the caller.** Wrapping `data`
 * before it reaches `toolContext` is the difference between an eval that reads
 * the seeded workspace and one that dismantles it, and a rule the caller has
 * to remember is a rule that survives until the second call site.
 *
 * **The case slug stands in for a ticket id.** A case is not a row in
 * `tickets` — that is the whole point of `eval_cases` having no workspace —
 * so the slug is what goes into the prompt and into `ToolContext.ticketId`.
 * Safe only because every write is intercepted: a slug reaching a real
 * `resolveTicket` would update nothing and report success.
 */
import type { BudgetConfig } from "@/agent/budget";
import type { SystemBlock } from "@/agent/cache";
import type { OpsData } from "@/agent/data";
import type { RateCard } from "@/agent/cost";
import {
  runAgentLoop,
  type AgentLoopResult,
  type SpanEvent,
} from "@/agent/loop";
import { ticketMessage } from "@/agent/prompt";
import type { ToolRegistry } from "@/agent/registry";
import type { PolicyConfig } from "@/policy/refund";

import type { EvalCase } from "./case";
import { withRecordedWrites, type RecordedWrite } from "./recorded-data";
import { score } from "./score";
import type { CaseScore } from "./types";

export interface RunCaseDeps {
  registry: ToolRegistry;
  createMessage: Parameters<typeof runAgentLoop>[0]["createMessage"];
  /** The provider's wire id — resolved by the caller, per CLAUDE.md. */
  model: string;
  rates: RateCard;
  /** Compiled once by the suite and reused, so every case pins the same prompt. */
  system: string | SystemBlock[];
  /** The version this run is pinned to, for `issue_refund`'s revalidation. */
  policyConfig: PolicyConfig;
  /** The real seam. Wrapped below; never handed to the loop directly. */
  data: OpsData;
  workspaceId: string;
  /** The `agent_runs` row this case's spans belong to. */
  runId: string;
  now: Date;
  budget: { config: BudgetConfig; spentTodayNanos: number };
  estimatedCallNanos: number;
  clock: () => Date;
  /** Optional passthrough — the suite persists spans as they happen. */
  emit?: (span: SpanEvent) => void | Promise<void>;
}

export interface CaseRun {
  result: AgentLoopResult;
  /** In emission order, so `spans[n].seq === n`. */
  spans: SpanEvent[];
  /** Every write the agent attempted, none of which landed. */
  writes: RecordedWrite[];
  score: CaseScore;
}

export async function runCase(
  c: EvalCase,
  deps: RunCaseDeps,
): Promise<CaseRun> {
  const { data, writes } = withRecordedWrites(deps.data);
  const spans: SpanEvent[] = [];

  const result = await runAgentLoop({
    registry: deps.registry,
    createMessage: deps.createMessage,
    model: deps.model,
    rates: deps.rates,
    system: deps.system,
    messages: [
      {
        role: "user",
        // The same builder `/api/agent/run` uses, so a case is scored against
        // the prompt the demo actually sends.
        content: ticketMessage({
          id: c.slug,
          subject: c.ticket.subject,
          customer: c.ticket.customer,
          body: c.ticket.body,
        }),
      },
    ],
    toolContext: {
      workspaceId: deps.workspaceId,
      runId: deps.runId,
      ticketId: c.slug,
      now: deps.now,
      data,
      policyConfig: deps.policyConfig,
    },
    budget: deps.budget,
    estimatedCallNanos: deps.estimatedCallNanos,
    clock: deps.clock,
    emit: async (span) => {
      // Collected first. The scorer needs the whole trace, and a caller's
      // `emit` that throws — a closed SSE stream, a failed insert — must not
      // be able to lose a span the score depends on.
      spans.push(span);
      await deps.emit?.(span);
    },
  });

  return {
    result,
    spans,
    writes,
    score: score(c.expect, {
      status: result.status,
      outcome: result.outcome,
      pendingApproval: result.pendingApproval
        ? {
            toolName: result.pendingApproval.toolName,
            toolInput: result.pendingApproval.toolInput,
          }
        : null,
      spans,
      iterations: result.iterations,
    }),
  };
}
