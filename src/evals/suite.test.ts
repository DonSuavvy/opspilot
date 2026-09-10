import { describe, expect, it, vi } from "vitest";

import { rateCard } from "@/agent/cost";
import type { OpsData } from "@/agent/data";
import type { AgentLoopResult, AssistantTurn, MessageCreator } from "@/agent/loop";
import type { Provider } from "@/agent/provider";
import type { Db } from "@/db/client";
import type { ActiveSop } from "@/db/sops";
import { DEFAULT_POLICY } from "@/policy/refund";

import type { EvalCase } from "./case";
import { runEvalSuite, type EvalPersistence, type EvalSuiteEvent } from "./suite";

/**
 * What the suite does when a *case* breaks.
 *
 * The happy path already has coverage in `runner.test.ts` — one case, scored.
 * What only the suite can get wrong is the failure path around a case, and the
 * two bugs live at different points of it, which is why there are two
 * scenarios rather than one.
 *
 * **Before `finishRun`** — a throw from `writeSpan` or `createOpsData` leaves
 * the `agent_runs` row at `running`, still holding the reservation
 * `reserveRun` charged it. Left there it consumes the day's headroom for a run
 * that is not running, and it does so for every case behind it.
 *
 * **After `finishRun`** — a throw from `insertEvalResult` or `emit` happens
 * once the counters have already been bumped, so the catch counts the case a
 * second time and `finishEvalRun` writes `passed + failed > total`. Here the
 * run row is legitimately `completed`; re-finishing it as failed would be a
 * new lie, so the fix has to tell the two points apart.
 *
 * Neither is reachable against a real database — nothing makes `writeSpan`
 * throw except breaking it — so the suite's side effects arrive as an injected
 * `EvalPersistence`.
 */

const NOW = new Date("2026-09-08T12:00:00.000Z");

const SOP: ActiveSop = {
  versionId: "sop_v1",
  version: 1,
  bodyMarkdown: "You are a support agent. Refunds within {{refund.windowDays}} days.",
  policyConfig: DEFAULT_POLICY,
};

const PROVIDER: Provider = {
  id: "anthropic",
  modelId: () => "test-model",
  rateCard: () => rateCard(1, 5, { verifiedOn: "2026-08-13", source: "test" }),
};

function noopData(): OpsData {
  return {
    findCustomer: vi.fn(async () => null),
    getSubscription: vi.fn(async () => null),
    listInvoices: vi.fn(async () => []),
    findInvoice: vi.fn(async () => null),
    searchKb: vi.fn(async () => []),
    saveDraft: vi.fn(async () => ({ draftId: "d" })),
    escalateTicket: vi.fn(async () => ({ ticketId: "t", status: "escalated" })),
    resolveTicket: vi.fn(async () => ({ ticketId: "t", status: "resolved" })),
    recordRefund: vi.fn(async () => ({
      refundedCents: 0,
      status: "refunded",
      duplicate: false,
    })),
  };
}

function caseFor(slug: string): EvalCase {
  return {
    slug,
    title: slug,
    description: "",
    ticket: { customer: null, subject: "s", body: "b" },
    expect: { status: "completed" },
    tags: [],
    enabled: true,
  };
}

/** Every turn resolves the ticket, so every case completes and passes. */
const resolveTurn: AssistantTurn = {
  content: [
    {
      type: "tool_use",
      id: "toolu_resolve",
      name: "resolve_ticket",
      input: {
        action: "answered",
        refund_amount_cents: 0,
        reply: "Done.",
        confidence: "high",
      },
    },
  ],
  stop_reason: "tool_use",
  stop_details: null,
  usage: {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

/** Counted, so "no model call" is a measurement rather than an inference. */
function countingCreateMessage(): {
  createMessage: MessageCreator;
  calls: () => number;
} {
  let n = 0;
  return {
    createMessage: async () => {
      n += 1;
      return structuredClone(resolveTurn);
    },
    calls: () => n,
  };
}

const createMessage: MessageCreator = async () => structuredClone(resolveTurn);

interface Harness {
  persist: EvalPersistence;
  /** Every `reserveRun` input, in order. `unknown` so a field this file is
   * about to require does not have to exist yet for the file to compile. */
  reserveRunInputs: unknown[];
  /** Every side effect in order, so ordering is one artifact to read. */
  calls: string[];
  finishedRuns: { runId: string; result: AgentLoopResult }[];
  finishedSuite: {
    passedCases: number;
    failedCases: number;
    status: string;
  }[];
}

interface Breakage {
  /** Case number (1-based) whose first span persist throws. */
  writeSpan?: number;
  /** Case number whose result insert throws. */
  insertEvalResult?: number;
  /** Case number whose `finishRun` throws, wherever it is called from. */
  finishRun?: number;
  /** Case number from which `reserveRun` starts refusing. */
  refuseFrom?: number;
  /**
   * Case number refused once with `rate_limited`, the retryable refusal.
   * Later cases reserve normally — which is the whole point of it.
   */
  rateLimit?: number;
}

function harness(broken: Breakage): Harness {
  const calls: string[] = [];
  const reserveRunInputs: unknown[] = [];
  const finishedRuns: Harness["finishedRuns"] = [];
  const finishedSuite: Harness["finishedSuite"] = [];
  let started = 0;
  let attempts = 0;
  let inserted = 0;

  const persist: EvalPersistence = {
    upsertEvalCases: async (_db, cases) =>
      new Map(cases.map((c) => [c.slug, `case_${c.slug}`])),
    createEvalRun: async () => "eval_run_1",
    insertEvalResult: async () => {
      inserted += 1;
      calls.push(`insertEvalResult:${inserted}`);
      if (inserted === broken.insertEvalResult) {
        throw new Error("insert blew up");
      }
    },
    finishEvalRun: async (_db, _id, input) => {
      calls.push("finishEvalRun");
      finishedSuite.push({
        passedCases: input.passedCases,
        failedCases: input.failedCases,
        status: input.status,
      });
    },
    reserveRun: async (_db, input) => {
      reserveRunInputs.push(input);
      // Counted per *call*, not per successful start, so a refusal that is
      // not sticky does not leave the next case answering to the same number.
      attempts += 1;
      const attempt = attempts;
      if (broken.rateLimit === attempt) {
        calls.push(`reserveRun:rate_limited:${attempt}`);
        return {
          ok: false as const,
          reason: "rate_limited" as const,
          retryAfterSeconds: 60,
          remainingNanos: 0,
        };
      }
      if (broken.refuseFrom !== undefined && attempt >= broken.refuseFrom) {
        calls.push(`reserveRun:refused:${attempt}`);
        return {
          ok: false as const,
          reason: "daily_cap_reached" as const,
          remainingNanos: 0,
        };
      }
      started += 1;
      calls.push(`reserveRun:${started}`);
      return {
        ok: true as const,
        runId: `agent_run_${started}`,
        baselineNanos: 0,
        priorNanos: 0,
      };
    },
    finishRun: async (_db, runId, result) => {
      calls.push(`finishRun:${runId}`);
      finishedRuns.push({ runId, result });
      if (started === broken.finishRun) throw new Error("finish blew up");
    },
    writeSpan: async () => {
      if (started === broken.writeSpan) throw new Error("span blew up");
    },
    createOpsData: () => noopData(),
    getSopVersion: async () => SOP,
    loadActiveSop: async () => SOP,
  };

  return { persist, calls, finishedRuns, finishedSuite, reserveRunInputs };
}

async function run(
  h: Harness,
  slugs: string[],
  creator: MessageCreator = createMessage,
) {
  const events: EvalSuiteEvent[] = [];

  const summary = await runEvalSuite({
    db: {} as Db,
    workspaceId: "ws_demo",
    sopVersionId: null,
    model: "haiku",
    cases: slugs.map(caseFor),
    createMessage: creator,
    provider: PROVIDER,
    budgetConfig: {
      dailyCapNanos: 5_000_000_000,
      killSwitch: false,
      runsPerMinute: 10,
    },
    gitSha: null,
    now: NOW,
    emit: (event) => {
      events.push(event);
    },
    persist: h.persist,
  });

  return { summary, events };
}

describe("runEvalSuite, when a case throws before its run is finished", () => {
  it("finishes the run as failed instead of leaving it `running`", async () => {
    const h = harness({ writeSpan: 2 });
    await run(h, ["one", "two", "three"]);

    const second = h.finishedRuns.find((r) => r.runId === "agent_run_2");

    expect(second, "the thrown case's run was never finished").toBeDefined();
    expect(second!.result.status).toBe("failed");
    expect(second!.result.error).toContain("span blew up");
  });

  it("runs the remaining cases, and case 3's baseline reads after that finish", async () => {
    const h = harness({ writeSpan: 2 });
    const { events, summary } = await run(h, ["one", "two", "three"]);

    expect(events.filter((e) => e.type === "case")).toHaveLength(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);

    // The whole reason the suite is sequential: case 3 reads its budget
    // baseline only once case 2's row is closed and carries a cost.
    expect(h.calls.indexOf("reserveRun:3")).toBeGreaterThan(
      h.calls.indexOf("finishRun:agent_run_2"),
    );
  });

  it("keeps the original error when the recovery finish also throws", async () => {
    const h = harness({ writeSpan: 2, finishRun: 2 });
    const { events } = await run(h, ["one", "two", "three"]);

    const second = events.find((e) => e.type === "case" && e.slug === "two");

    expect(second).toBeDefined();
    expect((second as { failureReason: string }).failureReason).toContain(
      "span blew up",
    );
    expect((second as { failureReason: string }).failureReason).not.toContain(
      "finish blew up",
    );
  });
});

describe("runEvalSuite, when a case throws after its run is finished", () => {
  it("counts it once, so passed + failed never exceeds the total", async () => {
    const h = harness({ insertEvalResult: 2 });
    const { summary } = await run(h, ["one", "two", "three"]);

    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(2);
    expect(summary.passed + summary.failed).toBe(summary.total);
    expect(h.finishedSuite).toEqual([
      { passedCases: 2, failedCases: 1, status: "failed" },
    ]);
  });

  it("leaves the completed run alone rather than re-finishing it as failed", async () => {
    const h = harness({ insertEvalResult: 2 });
    await run(h, ["one", "two", "three"]);

    const finishes = h.finishedRuns.filter((r) => r.runId === "agent_run_2");

    // The agent run genuinely completed. Only the bookkeeping around it broke.
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.result.status).toBe("completed");
  });
});

/**
 * A budget refusal is a *result*, not a crash.
 *
 * The suite used to read its baseline per case and trust that the previous
 * case's `finishRun` had landed — which is exactly the hole CLAUDE.md logged
 * as open, because a run in flight contributes nothing to that sum. Reserving
 * closes it, and reserving means a case can now be told no before a single
 * token is bought.
 *
 * Two things have to hold once that happens. The refused case is recorded and
 * named, so the scorecard says *why* it is red rather than reporting a
 * mysterious infrastructure failure. And the cases behind it are not attempted
 * at all: if the cap is reached on case two, cases three through eight cannot
 * pass either, and firing six more reservations at a shared Bedrock account to
 * be told no six more times is the burst the guard exists to prevent.
 *
 * The suite still reports `completed`. `failed` is reserved for a suite that
 * broke; this one worked exactly as designed and has eight results to show.
 */
describe("runEvalSuite, when the budget refuses a case", () => {
  it("fails the case, refuses the rest, and calls the model for neither", async () => {
    const h = harness({ refuseFrom: 2 });
    const creator = countingCreateMessage();
    const { events, summary } = await run(
      h,
      ["one", "two", "three"],
      creator.createMessage,
    );

    expect(creator.calls(), "only case one should reach the model").toBe(1);

    const results = events.filter((e) => e.type === "case");
    expect(results).toHaveLength(3);
    expect(results.map((e) => e.passed)).toEqual([true, false, false]);
    expect(results[1]!.failureReason).toBe("budget: daily_cap_reached");
    expect(results[2]!.failureReason).toBe("budget: daily_cap_reached");
    expect(results[2]!.agentRunId).toBeNull();

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.passed + summary.failed).toBe(summary.total);
  });

  it("leaves the suite `completed` — a refusal is a finding, not a crash", async () => {
    const h = harness({ refuseFrom: 2 });
    await run(h, ["one", "two", "three"]);

    expect(h.finishedSuite).toEqual([
      { passedCases: 1, failedCases: 2, status: "completed" },
    ]);
  });

  it("opens no agent_runs row for a case it never ran", async () => {
    const h = harness({ refuseFrom: 2 });
    await run(h, ["one", "two", "three"]);

    // Case three is never even asked: the cap does not un-reach itself, and
    // a second refusal is one more round trip at a shared account.
    expect(h.calls.filter((c) => c.startsWith("reserveRun"))).toEqual([
      "reserveRun:1",
      "reserveRun:refused:2",
    ]);
    expect(h.finishedRuns.map((r) => r.runId)).toEqual(["agent_run_1"]);
  });
});

/**
 * A rate limit is not a cap, and the suite must not treat it as one.
 *
 * The sticky refusal exists because the cap does not un-reach itself: once the
 * day's money is gone, asking seven more times is exactly the burst the guard
 * prevents. `rate_limited` is the opposite — it is a *wait*, it clears on its
 * own inside sixty seconds, and the golden suite is eight sequential runs
 * against a default of ten a minute, so it is the refusal most likely to land
 * mid-suite. Made sticky, one throttled case turned the six behind it red and
 * the scorecard said nothing about the agent.
 */
describe("runEvalSuite, when a case is rate limited", () => {
  it("fails that case and still runs the next one", async () => {
    const h = harness({ rateLimit: 2 });
    const creator = countingCreateMessage();
    const { events, summary } = await run(
      h,
      ["one", "two", "three"],
      creator.createMessage,
    );

    expect(
      creator.calls(),
      "cases one and three should both reach the model",
    ).toBe(2);

    expect(h.calls.filter((c) => c.startsWith("reserveRun"))).toEqual([
      "reserveRun:1",
      "reserveRun:rate_limited:2",
      "reserveRun:2",
    ]);

    const results = events.filter((e) => e.type === "case");
    expect(results.map((e) => e.passed)).toEqual([true, false, true]);
    expect(results[1]!.failureReason).toBe("budget: rate_limited");
    expect(results[2]!.failureReason).toBeNull();

    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
  });
});

/**
 * One instant for the policy, one instant per row.
 *
 * `now` is frozen for the whole suite on purpose — a refund window that moved
 * between case two and case seven would make the golden set drift, which is
 * the reason `now` is injected anywhere in this codebase. But the same frozen
 * instant was also being written to `agent_runs.started_at`, so eight rows all
 * claimed to have started at once: the per-minute count saw a burst that never
 * happened, and Mission Control's timeline collapsed to a point.
 *
 * The clock is stepped a minute per case here rather than trusted to advance
 * on its own. Three cases against a fake persistence layer finish inside a
 * millisecond, so real timestamps would be equal about as often as not and the
 * distinctness this asserts would be a coin flip.
 */
describe("runEvalSuite, and the instants it stamps its rows with", () => {
  it("gives every case its own started_at while the policy keeps one now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));

    try {
      const h = harness({});
      await run(h, ["one", "two", "three"], async () => {
        vi.setSystemTime(new Date(Date.now() + 60_000));
        return structuredClone(resolveTurn);
      });

      const inputs = h.reserveRunInputs as { now: Date; startedAt?: Date }[];
      expect(inputs).toHaveLength(3);

      expect(
        inputs.map((i) => i.now.getTime()),
        "the policy instant stays frozen",
      ).toEqual([NOW.getTime(), NOW.getTime(), NOW.getTime()]);

      const startedAts = inputs.map((i) => i.startedAt?.getTime());
      expect(new Set(startedAts).size, "three rows, three instants").toBe(3);
      expect(
        startedAts.every((t) => t !== undefined && t !== NOW.getTime()),
        "and none of them is the frozen now",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
