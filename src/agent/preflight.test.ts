import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_POLICY } from "@/policy/refund";

import { runAgentLoop, type AssistantTurn, type SpanEvent } from "./loop";
import { buildRegistry, type ToolContext } from "./registry";
import { rateCard } from "./cost";

/**
 * What has to happen *before* a confirm-write call pauses the run.
 *
 * FAILURES #22: `issue_refund`'s policy revalidation was written, tested, and
 * unreachable — the loop pauses on a confirm-write call and returns before ever
 * dispatching the handler, so the guard ran on resume, if at all. That is the
 * wrong order in a way that costs more than a missed check: an out-of-policy
 * refund gets queued, a human is asked to approve something the code will refuse
 * anyway, and the rejection arrives after they have already said yes.
 *
 * Reading the pause block for that also surfaced a sharper one. The pause sits
 * *above* the Zod parse, so the approval queue can be handed input that fails
 * the tool's own schema — a human could be asked to approve `amount_cents: -5`.
 *
 * Both are the same fix: validate, then pause.
 */

const NOW = new Date("2026-08-15T12:00:00Z");

function ctx(): ToolContext {
  return {
    workspaceId: "ws_1",
    runId: "run_1",
    ticketId: "tkt_1",
    now: NOW,
    data: {} as ToolContext["data"],
    policyConfig: DEFAULT_POLICY,
  };
}

function turn(input: unknown): AssistantTurn {
  return {
    content: [
      { type: "tool_use", id: "toolu_1", name: "risky_write", input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const resolveTurn: AssistantTurn = {
  content: [
    {
      type: "tool_use",
      id: "toolu_2",
      name: "resolve_ticket",
      input: {
        action: "escalated",
        refund_amount_cents: 0,
        reply: "escalated",
        confidence: "high",
      },
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
};

function registry(preflight?: (input: unknown, ctx: ToolContext) => Promise<void>) {
  return buildRegistry([
    {
      name: "risky_write",
      description: "A confirm-write tool that moves money and pauses for approval.",
      input: z.object({ amount_cents: z.number().int().positive() }),
      safetyClass: "confirm_write" as const,
      idempotent: true,
      preflight,
      handler: async () => {
        throw new Error("handler must not run before approval");
      },
    },
    {
      name: "resolve_ticket",
      description: "The forced terminal tool that ends every run with an outcome.",
      input: z.object({
        action: z.string(),
        refund_amount_cents: z.number(),
        reply: z.string(),
        confidence: z.string(),
      }),
      safetyClass: "auto_write" as const,
      idempotent: true,
      terminal: true,
      handler: async (input: unknown) => input,
    },
  ]);
}

async function run(
  turns: AssistantTurn[],
  preflight?: (input: unknown, ctx: ToolContext) => Promise<void>,
) {
  const spans: SpanEvent[] = [];
  let i = 0;
  const result = await runAgentLoop({
    registry: registry(preflight),
    createMessage: async () => turns[i++]!,
    model: "test-model",
    rates: rateCard(1, 5, { verifiedOn: "2026-08-15", source: "test fixture" }),
    system: "You are OpsPilot.",
    messages: [{ role: "user", content: "refund please" }],
    toolContext: ctx(),
    budget: {
      config: { dailyCapNanos: 10_000_000_000, killSwitch: false },
      spentTodayNanos: 0,
    },
    estimatedCallNanos: 1_000,
    clock: () => NOW,
    emit: (s) => {
      spans.push(s);
    },
  });
  return { result, spans };
}

describe("confirm-write validation runs before the pause", () => {
  it("pauses when the call is valid and the preflight allows it", async () => {
    const { result, spans } = await run([turn({ amount_cents: 4_900 })]);

    expect(result.status).toBe("paused_for_approval");
    expect(spans.some((s) => s.type === "approval_wait")).toBe(true);
  });

  /**
   * The FAILURES #22 case. A preflight that refuses must stop the run reaching
   * the queue at all — and must hand the model an error it can act on, because
   * a silent denial leaves it believing the refund is pending.
   */
  it("does not pause when the preflight refuses", async () => {
    const { result } = await run(
      [turn({ amount_cents: 4_900 }), resolveTurn],
      async () => {
        throw new Error("refund denied by policy: outside_window");
      },
    );

    expect(result.status).not.toBe("paused_for_approval");
  });

  it("emits no approval_wait span when the preflight refuses", async () => {
    const { spans } = await run(
      [turn({ amount_cents: 4_900 }), resolveTurn],
      async () => {
        throw new Error("refund denied by policy: outside_window");
      },
    );

    expect(spans.some((s) => s.type === "approval_wait")).toBe(false);
  });

  it("tells the model why, so it can escalate instead of retrying", async () => {
    const turns = [turn({ amount_cents: 4_900 }), resolveTurn];
    const { result } = await run(turns, async () => {
      throw new Error("refund denied by policy: outside_window");
    });

    const toolResult = JSON.stringify(result.messages);
    expect(toolResult).toContain("outside_window");
  });

  /**
   * The sharper half. Zod parsing sat *below* the pause, so a confirm-write call
   * with input its own schema rejects was queued for a human anyway.
   */
  it("does not pause on input the tool's own schema rejects", async () => {
    const { result, spans } = await run([
      turn({ amount_cents: -5 }),
      resolveTurn,
    ]);

    expect(result.status).not.toBe("paused_for_approval");
    expect(spans.some((s) => s.type === "approval_wait")).toBe(false);
  });

  it("passes the run's pinned policy to the preflight", async () => {
    const seen = vi.fn<(input: unknown, ctx: ToolContext) => Promise<void>>(
      async () => {},
    );
    await run([turn({ amount_cents: 4_900 })], seen);

    expect(seen).toHaveBeenCalledWith(
      { amount_cents: 4_900 },
      expect.objectContaining({ policyConfig: DEFAULT_POLICY }),
    );
  });

  it("hands the preflight parsed input, not the raw wire object", async () => {
    // Parsing before the preflight is what lets a preflight trust its argument
    // instead of re-validating shape it should already be able to rely on.
    const seen = vi.fn<(input: unknown, ctx: ToolContext) => Promise<void>>(
      async () => {},
    );
    await run([turn({ amount_cents: 4_900, extra: "ignored" })], seen);

    expect(seen.mock.calls[0]?.[0]).toEqual({ amount_cents: 4_900 });
  });
});
