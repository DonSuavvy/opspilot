import { describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY } from "@/policy/refund";

import { checkBudget, type BudgetConfig } from "./budget";
import { rateCard, type RateCard } from "./cost";
import {
  runAgentLoop,
  type AssistantTurn,
  type ContentBlock,
  type MessageCreator,
  type SpanEvent,
} from "./loop";
import {
  buildRegistry,
  type ToolContext,
  type ToolDefinition,
} from "./registry";

import { z } from "zod";

/**
 * The hand-rolled agent loop.
 *
 * This is the module PLAN.md calls out as load-bearing for the interview
 * story: pause/resume across serverless invocations requires serializing the
 * message array mid-loop and reconstructing it later, which the SDK's tool
 * runner does not support. So the loop is ours, and it has to be tested like
 * production code rather than demonstrated once in a script.
 *
 * **Everything here runs against a scripted client.** `npm test` must never
 * need a database *or* an API key, so `createMessage` is a narrow interface the
 * loop owns — `(params) => Promise<AssistantTurn>` — and the tests hand it
 * queued turns. The production adapter behind that interface streams from
 * Bedrock and returns the SDK's assembled final message, which is structurally
 * an `AssistantTurn`. That split is deliberate: the four-field `usage` object
 * arrives split across event types on the streaming path, and hand-assembling
 * it is exactly how a run silently records zero cache cost. Let the SDK
 * assemble; let the loop consume something it can fake.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** $1/$5 per MTok — 1000 nanos per input token, 5000 per output token. */
const VERIFIED_RATES: RateCard = rateCard(1, 5, {
  verifiedOn: "2026-08-13",
  source: "test fixture",
});

const UNVERIFIED_RATES: RateCard = rateCard(1, 5, {
  verifiedOn: null,
  source: "test fixture — unverified on purpose",
});

/** 10 in + 10 out against VERIFIED_RATES = 10*1000 + 10*5000 = 60_000 nanos. */
const TURN_NANOS = 60_000;

function usage(over: Partial<AssistantTurn["usage"]> = {}) {
  return {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  };
}

function toolUse(name: string, input: unknown, id = `toolu_${name}`) {
  return { type: "tool_use" as const, id, name, input };
}

function turn(
  content: ContentBlock[],
  over: Partial<AssistantTurn> = {},
): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    stop_details: null,
    usage: usage(),
    ...over,
  };
}

/** A turn that calls the forced terminal tool and ends the run. */
function resolveTurn(action = "answered") {
  return turn([
    toolUse("resolve_ticket", {
      action,
      refund_amount_cents: 0,
      reply: "All set.",
      confidence: "high",
    }),
  ]);
}

/**
 * A scripted stand-in for the Anthropic client. Returns queued turns in order
 * and records the params it was called with, so a test can assert on the
 * *shape of the messages array* the loop built — which is where the tool-result
 * batching rule lives.
 */
function scriptedClient(turns: AssistantTurn[]) {
  const calls: Parameters<MessageCreator>[0][] = [];
  const create: MessageCreator = vi.fn(async (params) => {
    calls.push(structuredClone(params));
    const next = turns.shift();
    if (!next) throw new Error("scripted client ran out of turns");
    return next;
  });
  return { create, calls };
}

function tool(
  name: string,
  over: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `A ${name} tool used by the agent loop tests, described at length enough to pass boot validation.`,
    input: z.object({ q: z.string() }),
    safetyClass: "read",
    idempotent: true,
    handler: async () => ({ ok: name }),
    ...over,
  } as ToolDefinition;
}

/** A registry mirroring the real safety-class mix, with handlers that work. */
function testRegistry(over: { handler?: ToolDefinition["handler"] } = {}) {
  return buildRegistry([
    tool("get_customer", over.handler ? { handler: over.handler } : {}),
    tool("search_kb"),
    tool("issue_refund", {
      safetyClass: "confirm_write",
      input: z.object({ invoice_id: z.string(), amount_cents: z.number() }),
      handler: async () => {
        throw new Error("confirm_write handler must never run before approval");
      },
    }),
    tool("resolve_ticket", {
      safetyClass: "auto_write",
      terminal: true,
      input: z.object({
        action: z.string(),
        refund_amount_cents: z.number(),
        reply: z.string(),
        confidence: z.string(),
      }),
      handler: async (input) => input,
    }),
  ]);
}

function budget(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return { dailyCapNanos: 5_000_000_000, killSwitch: false, ...over }; // $5
}

/** A monotonic fake clock, so latency and timestamps are assertable. */
function fakeClock(startMs = 1_760_000_000_000, stepMs = 5) {
  let t = startMs;
  return () => new Date((t += stepMs));
}

function loopInput(
  turns: AssistantTurn[],
  over: Partial<Parameters<typeof runAgentLoop>[0]> = {},
) {
  const client = scriptedClient(turns);
  const spans: SpanEvent[] = [];
  const input = {
    registry: testRegistry(),
    createMessage: client.create,
    model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    rates: VERIFIED_RATES,
    system: "You are OpsPilot.",
    messages: [{ role: "user" as const, content: "Ticket: where is my refund?" }],
    toolContext: {
      policyConfig: DEFAULT_POLICY,
      workspaceId: "ws_1",
      runId: "run_1",
      ticketId: "tkt_1",
      now: new Date("2026-08-13T00:00:00Z"),
      // The loop never touches the repository — it only forwards the context
      // to handlers, and this file's handlers are fakes that ignore it.
      data: {} as ToolContext["data"],
    },
    budget: { config: budget(), spentTodayNanos: 0 },
    estimatedCallNanos: TURN_NANOS,
    clock: fakeClock(),
    emit: (s: SpanEvent) => {
      spans.push(s);
    },
    ...over,
  };
  return { input, client, spans };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — reaching an outcome", () => {
  it("runs a read tool, then the terminal tool, and completes", async () => {
    const { input, client } = loopInput([
      turn([toolUse("get_customer", { q: "cus_0007" })]),
      resolveTurn("answered"),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(2);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({
      action: "answered",
      confidence: "high",
    });
  });

  /**
   * `resolve_ticket` is the forced terminal tool: the deterministic eval
   * scorers key off its structured output, so a run that kept going after it
   * would produce two candidate outcomes and no rule for picking one.
   */
  it("stops at the terminal tool without asking the model for another turn", async () => {
    const { input, client } = loopInput([
      resolveTurn(),
      turn([toolUse("search_kb", { q: "never reached" })]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  /**
   * A model that talks without acting is not done — every run has to end with
   * a structured outcome. Without this the loop would exit on `end_turn` with
   * `outcome: null` and the eval scorers would have nothing to score.
   */
  it("keeps going when the model ends a turn without calling a tool", async () => {
    const { input } = loopInput([
      turn([{ type: "text", text: "Let me look into that." }]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(2);
  });

  it("gives up after maxIterations rather than looping forever", async () => {
    const turns = Array.from({ length: 12 }, () =>
      turn([toolUse("search_kb", { q: "again" })]),
    );
    const { input } = loopInput(turns, { maxIterations: 12 });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(12);
    expect(result.error).toMatch(/iteration/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — refusal", () => {
  /**
   * CLAUDE.md's gotcha, pinned: `stop_reason: "refusal"` must be handled
   * *before* `content` is read. The turn below carries a tool_use block, which
   * a loop that inspected content first would happily execute — firing a tool
   * off the back of a response the model declined to stand behind.
   */
  it("refuses without executing tool_use blocks present in the refused turn", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const { input } = loopInput(
      [
        turn([toolUse("get_customer", { q: "cus_0007" })], {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
        }),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("refused");
    expect(handler).not.toHaveBeenCalled();
    expect(result.refusal?.category).toBe("cyber");
  });

  /**
   * The subtler half of the same gotcha. `stop_details` is populated *only* on
   * a refusal — but it can still be null *on* one, so `if (stop_details)` is
   * the wrong test and would let a refusal through as a normal turn.
   */
  it("refuses when stop_reason says so even though stop_details is null", async () => {
    const { input } = loopInput([
      turn([], { stop_reason: "refusal", stop_details: null }),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("refused");
    expect(result.refusal?.category).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The spend guard                                                            */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — budget", () => {
  /**
   * covara serves a working law firm's live Claude generation. A loop that can
   * call the API before consulting the guard is a loop that can spend money it
   * was refused, so the check has to be a pre-flight, not a report.
   */
  it("refuses before the first call when the cap is already spent", async () => {
    const { input, client } = loopInput([resolveTurn()], {
      budget: {
        config: budget({ dailyCapNanos: 1_000 }),
        spentTodayNanos: 1_000,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("daily_cap_reached");
    expect(client.create).not.toHaveBeenCalled();
    expect(result.costNanos).toBe(0);
  });

  it("refuses before the first call when the kill switch is pulled", async () => {
    const { input, client } = loopInput([resolveTurn()], {
      budget: { config: budget({ killSwitch: true }), spentTodayNanos: 0 },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("kill_switch");
    expect(client.create).not.toHaveBeenCalled();
  });

  /**
   * The failure this exists to prevent: a guard checked once at the top of the
   * run, using a figure read from the database before the loop started, lets a
   * 12-iteration run spend twelve times the amount it was cleared for. Spend
   * accrued *inside* the run has to count against the same cap.
   *
   * Cap $0.00015 (150_000 nanos) against 60_000-nano turns: iterations 1 and 2
   * clear the pre-flight, iteration 3 does not.
   */
  it("counts spend accrued inside the run against the cap", async () => {
    const turns = Array.from({ length: 5 }, () =>
      turn([toolUse("search_kb", { q: "again" })]),
    );
    const { input, client } = loopInput(turns, {
      budget: {
        config: budget({ dailyCapNanos: 150_000 }),
        spentTodayNanos: 0,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("run_would_exceed_cap");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.costNanos).toBe(2 * TURN_NANOS);
  });

  /**
   * Bedrock's rates are unverified and the one comparable AWS figure was 2x
   * the first-party price, so the guard charges unverified cards at
   * UNVERIFIED_RATE_SAFETY_FACTOR. Enforcing a cap with rates that might be
   * half the real ones is not a cap. Same cap as above, but doubled charging
   * means iteration 2 is already refused.
   */
  it("charges an unverified rate card at the pessimistic multiple", async () => {
    const turns = Array.from({ length: 5 }, () =>
      turn([toolUse("search_kb", { q: "again" })]),
    );
    const { input, client } = loopInput(turns, {
      rates: UNVERIFIED_RATES,
      budget: {
        config: budget({ dailyCapNanos: 150_000 }),
        spentTodayNanos: 0,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(result.estimated).toBe(true);
  });

  /** The guard's own arithmetic, restated at the loop's boundary. */
  it("agrees with checkBudget about the boundary it enforces", () => {
    expect(
      checkBudget({
        spentTodayNanos: 2 * TURN_NANOS,
        estimatedRunNanos: TURN_NANOS,
        rateVerified: true,
        config: budget({ dailyCapNanos: 150_000 }),
      }).allowed,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Approval pause                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — confirm-write pause", () => {
  /**
   * The pause is the pause/resume story and the Vercel-timeout answer at once:
   * the run serializes its message array, ends the invocation, and a later
   * /api/agent/resume reconstructs it. The handler must not run — approval
   * happens *before* the side effect, not after.
   */
  it("pauses on a confirm-write tool without running its handler", async () => {
    const { input, client } = loopInput([
      turn([
        toolUse("issue_refund", { invoice_id: "INV-2002", amount_cents: 4900 }),
      ]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("paused_for_approval");
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(result.pendingApproval).toMatchObject({
      toolName: "issue_refund",
      toolUseId: "toolu_issue_refund",
      toolInput: { invoice_id: "INV-2002", amount_cents: 4900 },
    });
  });

  /**
   * The serialized array is what resume rebuilds the conversation from. If it
   * does not round-trip, the resumed turn is invalid and the API rejects it —
   * which is why `agent_runs.serialized_messages` is `text` rather than
   * `jsonb` in the first place.
   */
  it("serializes a message array that round-trips through JSON", async () => {
    const { input } = loopInput([
      turn([
        toolUse("issue_refund", { invoice_id: "INV-2002", amount_cents: 4900 }),
      ]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.serializedMessages).toBeTypeOf("string");
    const restored = JSON.parse(result.serializedMessages!);
    expect(Array.isArray(restored)).toBe(true);
    // user turn + the assistant turn carrying the pending tool_use
    expect(restored).toHaveLength(2);
    expect(restored[1].role).toBe("assistant");
  });

  it("emits an approval_wait span so the pause is visible in the trace", async () => {
    const { input, spans } = loopInput([
      turn([
        toolUse("issue_refund", { invoice_id: "INV-2002", amount_cents: 4900 }),
      ]),
    ]);

    await runAgentLoop(input);

    expect(spans.map((s) => s.type)).toContain("approval_wait");
  });
});

/* -------------------------------------------------------------------------- */
/* Tool execution                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — tool execution", () => {
  /**
   * Parallel tool use is on by default: one assistant turn can carry several
   * tool_use blocks, and every matching tool_result has to come back in a
   * *single* user message. Splitting them across messages is accepted by the
   * API but quietly trains the model out of calling tools in parallel.
   */
  it("returns all tool results for one turn in a single user message", async () => {
    const { input, client } = loopInput([
      turn([
        toolUse("get_customer", { q: "cus_0007" }, "toolu_a"),
        toolUse("search_kb", { q: "refunds" }, "toolu_b"),
      ]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    const second = client.calls[1]!;
    const appended = second.messages.slice(1);
    const userTurns = appended.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);

    const blocks = userTurns[0]!.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual([
      "toolu_a",
      "toolu_b",
    ]);
  });

  /**
   * Tool names arrive as model output from Day 2 onward, so an unregistered
   * name is an input the loop must survive rather than a programmer error.
   * `requiresApproval` throws on unknown names by design; the loop has to
   * catch that and answer the model instead of crashing the run.
   */
  it("answers an unknown tool name with an error result and keeps going", async () => {
    const { input, client } = loopInput([
      turn([toolUse("delete_everything", { q: "x" }, "toolu_x")]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    const blocks = client.calls[1]!.messages.at(-1)!.content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ tool_use_id: "toolu_x", is_error: true });
  });

  /**
   * The `issue_refund` handler rejects out-of-policy calls with `is_error`, and
   * the agent is expected to adapt (typically by escalating). That contract
   * only holds if a throwing handler becomes a tool_result the model can read,
   * rather than an exception that kills the run.
   */
  it("turns a throwing handler into an is_error tool result", async () => {
    const handler = vi.fn(async () => {
      throw new Error("refund exceeds the policy window");
    });
    const { input, client } = loopInput(
      [
        turn([toolUse("get_customer", { q: "cus_0007" }, "toolu_c")]),
        resolveTurn(),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    const blocks = client.calls[1]!.messages.at(-1)!.content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(blocks[0])).toMatch(/policy window/);
  });

  /**
   * The wire schema is stripped of numeric and string constraints so the model
   * is told less than the code enforces; Zod is what actually guards the
   * handler. A malformed argument must therefore be rejected at parse time and
   * reported back, never handed to the handler.
   */
  it("rejects arguments that fail the Zod schema before the handler sees them", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const { input } = loopInput(
      [
        turn([toolUse("get_customer", { q: 42 }, "toolu_bad")]),
        resolveTurn(),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });
});

/* -------------------------------------------------------------------------- */
/* Spans and cost                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — trace and cost", () => {
  it("emits an llm_call span per model turn and a tool_exec span per tool call", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_customer", { q: "cus_0007" })]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    const byType = spans.reduce<Record<string, number>>((acc, s) => {
      acc[s.type] = (acc[s.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.llm_call).toBe(2);
    expect(byType.tool_exec).toBe(2); // get_customer + resolve_ticket
  });

  /**
   * `run_spans` has a unique index on (run_id, seq). A repeated or missing seq
   * is a constraint violation at persist time, so the counter is part of the
   * loop's contract rather than an implementation detail.
   */
  it("numbers spans from zero with no gaps or repeats", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_customer", { q: "cus_0007" })]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    expect(spans.map((s) => s.seq)).toEqual(spans.map((_, i) => i));
  });

  it("prices each llm_call span and totals them onto the run", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_customer", { q: "cus_0007" })]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);
    const llm = spans.filter((s) => s.type === "llm_call");

    expect(llm.every((s) => s.costNanos === TURN_NANOS)).toBe(true);
    expect(result.costNanos).toBe(2 * TURN_NANOS);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 20 });
  });

  /**
   * Cache reads are the saving the trace viewer's badge reports, and they are
   * billed as a distinct token class rather than as input — so a run that read
   * from cache must cost less than the same run that did not.
   */
  it("prices cache reads separately from uncached input", async () => {
    const { input } = loopInput([
      turn([], {
        stop_reason: "end_turn",
        usage: usage({ input_tokens: 0, cache_read_input_tokens: 100 }),
      }),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    // 100 cache-read tokens at 100 nanos each = 10_000, plus 10 output = 50_000
    expect(result.usage.cacheReadInputTokens).toBe(100);
    expect(result.costNanos).toBe(60_000 + TURN_NANOS);
  });

  it("marks the run estimated when the rate card is unverified", async () => {
    const { input } = loopInput([resolveTurn()], { rates: UNVERIFIED_RATES });

    const result = await runAgentLoop(input);

    expect(result.estimated).toBe(true);
  });

  /**
   * `now` is injected everywhere else in this codebase for determinism; the
   * loop needs a wall clock for latency and span timestamps, so it takes one
   * as an argument rather than reaching for Date.now(). That is what makes
   * these assertions possible at all.
   */
  it("takes its wall clock as an argument", async () => {
    const { input, spans } = loopInput([resolveTurn()], {
      clock: fakeClock(1_000_000, 7),
    });

    await runAgentLoop(input);

    expect(spans[0]!.latencyMs).toBe(7);
    expect(spans[0]!.startedAt.getTime()).toBe(1_000_007);
  });
});


/* -------------------------------------------------------------------------- */
/* Strict decoding                                                            */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — strict decoding", () => {
  /**
   * Measured, not assumed: the nine-tool registry is rejected by Bedrock with
   * `400 Compiled grammar size (329.9MB) exceeds maximum allowed size (300MB)`.
   * The loop therefore has to be able to send the tool block without asking for
   * constrained decoding, and it defaults that way because the only provider
   * this project actually runs on cannot do it.
   *
   * This costs nothing that matters. The test directly below shows why: the
   * loop still parses every tool call with the tool own Zod schema, so the
   * wire schema constrains the model and Zod constrains reality — exactly as
   * it did when strict was on.
   */
  it("does not ask for strict decoding by default", async () => {
    const { input, client } = loopInput([resolveTurn()]);

    await runAgentLoop(input);

    for (const spec of client.calls[0]!.tools as { strict?: unknown }[]) {
      expect(spec).not.toHaveProperty("strict");
    }
  });

  it("asks for it when the caller says the provider can take it", async () => {
    const { input, client } = loopInput([resolveTurn()], { strictTools: true });

    await runAgentLoop(input);

    for (const spec of client.calls[0]!.tools as { strict?: unknown }[]) {
      expect(spec).toHaveProperty("strict", true);
    }
  });
});
