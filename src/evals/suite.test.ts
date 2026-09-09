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
 * **Before `finishRun`** — a throw from `writeSpan`, `createOpsData` or the
 * baseline read leaves the `agent_runs` row at `running` with a null cost. It
 * then contributes zero to every later case's budget baseline, which is the
 * one thing the suite's sequential ordering exists to guarantee.
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

const createMessage: MessageCreator = async () => structuredClone(resolveTurn);

interface Harness {
  persist: EvalPersistence;
  /** Every side effect in order, so ordering is one artifact to read. */
  calls: string[];
  finishedRuns: { runId: string; result: AgentLoopResult }[];
  finishedSuite: { passedCases: number; failedCases: number }[];
}

interface Breakage {
  /** Case number (1-based) whose first span persist throws. */
  writeSpan?: number;
  /** Case number whose result insert throws. */
  insertEvalResult?: number;
  /** Case number whose `finishRun` throws, wherever it is called from. */
  finishRun?: number;
}

function harness(broken: Breakage): Harness {
  const calls: string[] = [];
  const finishedRuns: Harness["finishedRuns"] = [];
  const finishedSuite: Harness["finishedSuite"] = [];
  let started = 0;
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
      });
    },
    startRun: async () => {
      started += 1;
      calls.push(`startRun:${started}`);
      return `agent_run_${started}`;
    },
    finishRun: async (_db, runId, result) => {
      calls.push(`finishRun:${runId}`);
      finishedRuns.push({ runId, result });
      if (started === broken.finishRun) throw new Error("finish blew up");
    },
    writeSpan: async () => {
      if (started === broken.writeSpan) throw new Error("span blew up");
    },
    spentTodayNanos: async () => {
      calls.push(`spentTodayNanos:${started}`);
      return 0;
    },
    createOpsData: () => noopData(),
    getSopVersion: async () => SOP,
    loadActiveSop: async () => SOP,
  };

  return { persist, calls, finishedRuns, finishedSuite };
}

async function run(h: Harness, slugs: string[]) {
  const events: EvalSuiteEvent[] = [];

  const summary = await runEvalSuite({
    db: {} as Db,
    workspaceId: "ws_demo",
    sopVersionId: null,
    model: "haiku",
    cases: slugs.map(caseFor),
    createMessage,
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
    expect(h.calls.indexOf("spentTodayNanos:3")).toBeGreaterThan(
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
    expect(h.finishedSuite).toEqual([{ passedCases: 2, failedCases: 1 }]);
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
