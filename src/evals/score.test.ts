import { describe, expect, it } from "vitest";

import type { SpanEvent, SpanType } from "@/agent/loop";

import type { Expectations } from "./case";
import { score, type Observed } from "./score";

/**
 * The scorer is where PLAN.md's "determinism lives in the scorers, not in
 * sampling" is actually cashed out — there is no `temperature` on Opus or
 * Sonnet 5, so this function is the only thing standing between the suite and
 * a flaky gate.
 *
 * Every expected value below is a literal. A test that recomputes the sentence
 * it is checking passes when the sentence is wrong, and the sentence is the
 * product here: `failure_reason` is what a reviewer reads in the diff view.
 */

const AT = new Date("2026-09-08T10:00:00.000Z");

function span(
  type: SpanType,
  name: string,
  over: Partial<SpanEvent> = {},
): SpanEvent {
  return {
    seq: 0,
    type,
    name,
    input: null,
    output: null,
    isError: false,
    usage: null,
    costNanos: 0,
    estimated: false,
    latencyMs: 1,
    startedAt: AT,
    endedAt: AT,
    ...over,
  };
}

function outcome(over: Record<string, unknown> = {}) {
  return {
    action: "answered",
    refund_amount_cents: 0,
    reply: "All set — your key rotates cleanly.",
    confidence: "high",
    ...over,
  };
}

function observed(over: Partial<Observed> = {}): Observed {
  return {
    status: "completed",
    outcome: outcome(),
    pendingApproval: null,
    spans: [],
    iterations: 2,
    ...over,
  };
}

/** The paused shape: no outcome, an approval carrying the tool's own input. */
function paused(toolName: string, toolInput: unknown): Observed {
  return observed({
    status: "paused_for_approval",
    outcome: null,
    pendingApproval: { toolName, toolInput },
  });
}

function only(expectations: Expectations, o: Observed) {
  return score(expectations, o);
}

describe("score — the empty case", () => {
  it("passes with zero assertions when nothing is expected", () => {
    const result = score({}, observed());

    expect(result.passed).toBe(true);
    expect(result.assertions).toEqual([]);
    expect(result.failureReason).toBeNull();
  });
});

describe("score — status", () => {
  it("passes when the terminal status matches", () => {
    const result = only({ status: "completed" }, observed());

    expect(result.passed).toBe(true);
    expect(result.assertions).toEqual([
      {
        name: "status",
        expected: "completed",
        actual: "completed",
        passed: true,
      },
    ]);
  });

  it("fails with a sentence naming both statuses", () => {
    const result = only({ status: "paused_for_approval" }, observed());

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(
      'expected status "paused_for_approval", got "completed"',
    );
  });
});

describe("score — action", () => {
  it("passes when resolve_ticket reported the expected action", () => {
    const result = only(
      { action: "escalated" },
      observed({ outcome: outcome({ action: "escalated" }) }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions[0]).toEqual({
      name: "action",
      expected: "escalated",
      actual: "escalated",
      passed: true,
    });
  });

  it("fails when the action differs", () => {
    const result = only({ action: "escalated" }, observed());

    expect(result.failureReason).toBe(
      'expected action "escalated", got "answered"',
    );
  });

  /**
   * A completed run *should* always have an outcome — `resolve_ticket` is the
   * forced terminal tool. When it does not, that is the finding, and it must
   * read as one rather than as `undefined !== "escalated"`.
   */
  it("says so plainly when a completed run produced no outcome", () => {
    const result = only({ action: "escalated" }, observed({ outcome: null }));

    expect(result.passed).toBe(false);
    expect(result.assertions[0]).toEqual({
      name: "action",
      expected: "escalated",
      actual: null,
      passed: false,
      detail: 'expected action "escalated", but the run produced no outcome',
    });
    expect(result.failureReason).toBe(
      'expected action "escalated", but the run produced no outcome',
    );
  });
});

describe("score — refundCents", () => {
  it("passes on an exact match", () => {
    const result = only(
      { refundCents: 4_900 },
      observed({ outcome: outcome({ refund_amount_cents: 4_900 }) }),
    );

    expect(result.passed).toBe(true);
  });

  it("fails on an exact mismatch", () => {
    const result = only(
      { refundCents: 0 },
      observed({ outcome: outcome({ refund_amount_cents: 4_900 }) }),
    );

    expect(result.failureReason).toBe("expected a refund of 0 cents, got 4900");
  });

  it("accepts anything at or below a ceiling", () => {
    const result = only(
      { refundCents: { max: 4_900 } },
      observed({ outcome: outcome({ refund_amount_cents: 4_900 }) }),
    );

    expect(result.passed).toBe(true);
  });

  it("fails above a ceiling, naming the ceiling", () => {
    const result = only(
      { refundCents: { max: 4_900 } },
      observed({ outcome: outcome({ refund_amount_cents: 10_000 }) }),
    );

    expect(result.failureReason).toBe(
      "expected a refund of at most 4900 cents, got 10000",
    );
  });

  it("reports a missing outcome rather than reading it as zero", () => {
    // The dangerous default: `undefined ?? 0` would make "expected 0 cents"
    // pass on a run that never resolved, which is the opposite of the truth.
    const result = only({ refundCents: 0 }, observed({ outcome: null }));

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(
      "expected a refund of 0 cents, but the run produced no outcome",
    );
  });
});

describe("score — pausesFor", () => {
  it("passes when the run paused on the right tool for the right amount", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund", amountCents: 4_900 } },
      paused("issue_refund", { invoice_id: "INV-2001", amount_cents: 4_900 }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions.map((a) => a.name)).toEqual([
      "pausesFor.tool",
      "pausesFor.amountCents",
    ]);
  });

  it("emits only the tool assertion when no amount is expected", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund" } },
      paused("issue_refund", { amount_cents: 4_900 }),
    );

    expect(result.assertions.map((a) => a.name)).toEqual(["pausesFor.tool"]);
  });

  it("fails when the run never paused", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund" } },
      observed(),
    );

    expect(result.failureReason).toBe(
      'expected a pause on "issue_refund", but the run never paused',
    );
  });

  it("fails when it paused on a different tool", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund" } },
      paused("update_subscription", { new_plan: "free" }),
    );

    expect(result.failureReason).toBe(
      'expected a pause on "issue_refund", got a pause on "update_subscription"',
    );
  });

  it("fails when the paused amount differs", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund", amountCents: 4_900 } },
      paused("issue_refund", { amount_cents: 1_000_000 }),
    );

    expect(result.failureReason).toBe(
      "expected the pause to be for 4900 cents, got 1000000",
    );
  });

  it("says so when the paused call carried no amount at all", () => {
    const result = only(
      { pausesFor: { tool: "issue_refund", amountCents: 4_900 } },
      paused("issue_refund", { invoice_id: "INV-2001" }),
    );

    expect(result.assertions[1]).toEqual({
      name: "pausesFor.amountCents",
      expected: 4_900,
      actual: null,
      passed: false,
      detail:
        "expected the pause to be for 4900 cents, but the paused call carried no amount_cents",
    });
  });
});

describe("score — toolsCalled", () => {
  it("passes on a successful tool_exec span, one assertion per name", () => {
    const result = only(
      { toolsCalled: ["get_invoices", "search_kb"] },
      observed({
        spans: [
          span("tool_exec", "get_invoices"),
          span("tool_exec", "search_kb"),
        ],
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions.map((a) => a.name)).toEqual([
      "toolsCalled:get_invoices",
      "toolsCalled:search_kb",
    ]);
  });

  it("fails when the tool never ran", () => {
    const result = only({ toolsCalled: ["search_kb"] }, observed());

    expect(result.failureReason).toBe(
      'expected "search_kb" to run, but it never did',
    );
  });

  /** An errored call is not a call the case can rely on having happened. */
  it("fails when every call to the tool errored", () => {
    const result = only(
      { toolsCalled: ["search_kb"] },
      observed({ spans: [span("tool_exec", "search_kb", { isError: true })] }),
    );

    expect(result.failureReason).toBe(
      'expected "search_kb" to run, but every call to it failed',
    );
  });

  it("ignores spans of other types with the same name", () => {
    const result = only(
      { toolsCalled: ["issue_refund"] },
      observed({ spans: [span("approval_wait", "issue_refund")] }),
    );

    expect(result.passed).toBe(false);
  });
});

describe("score — toolsNever", () => {
  it("passes when the tool is absent from the trace", () => {
    const result = only(
      { toolsNever: ["issue_refund"] },
      observed({ spans: [span("tool_exec", "search_kb")] }),
    );

    expect(result.passed).toBe(true);
  });

  /**
   * The security-relevant half. A refund that fired and *then* failed still
   * fired — the handler ran, the audit row exists — so an error span counts as
   * a hit. Treating `isError` as "did not happen" is how a case that exists to
   * prove zero side effects reports green on a side effect.
   */
  it("counts an errored call as a call", () => {
    const result = only(
      { toolsNever: ["issue_refund"] },
      observed({ spans: [span("tool_exec", "issue_refund", { isError: true })] }),
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(
      'expected "issue_refund" never to run, but it did',
    );
  });

  it("does not count a guardrail that blocked the call before dispatch", () => {
    const result = only(
      { toolsNever: ["issue_refund"] },
      observed({ spans: [span("guardrail", "issue_refund", { isError: true })] }),
    );

    expect(result.passed).toBe(true);
  });
});

describe("score — guardrailOn", () => {
  it("passes when a guardrail span exists for the tool", () => {
    const result = only(
      { guardrailOn: ["issue_refund"] },
      observed({ spans: [span("guardrail", "issue_refund", { isError: true })] }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions[0]!.name).toBe("guardrailOn:issue_refund");
  });

  it("fails when none fired", () => {
    const result = only(
      { guardrailOn: ["issue_refund"] },
      observed({ spans: [span("tool_exec", "issue_refund")] }),
    );

    expect(result.failureReason).toBe(
      'expected a guardrail to block "issue_refund", but none fired',
    );
  });
});

describe("score — replyMentions", () => {
  it("matches case-insensitively", () => {
    const result = only(
      { replyMentions: ["ROTATES CLEANLY"] },
      observed(),
    );

    expect(result.passed).toBe(true);
  });

  it("fails when the phrase is absent", () => {
    const result = only({ replyMentions: ["24 hours"] }, observed());

    expect(result.failureReason).toBe(
      'expected the reply to mention "24 hours", but it did not',
    );
  });

  it("reports a missing outcome rather than an empty reply", () => {
    const result = only(
      { replyMentions: ["24 hours"] },
      observed({ outcome: null }),
    );

    expect(result.failureReason).toBe(
      'expected the reply to mention "24 hours", but the run produced no outcome',
    );
  });
});

describe("score — maxIterations", () => {
  it("passes at the cap", () => {
    const result = only({ maxIterations: 2 }, observed({ iterations: 2 }));

    expect(result.passed).toBe(true);
  });

  it("fails above it", () => {
    const result = only({ maxIterations: 2 }, observed({ iterations: 5 }));

    expect(result.failureReason).toBe("expected at most 2 iterations, got 5");
  });
});

describe("score — ordering", () => {
  /**
   * `failureReason` is "the first failing assertion", so the order has to be
   * fixed rather than incidental — otherwise the same failing run produces a
   * different headline sentence on different days and the diff view shows a
   * flip that never happened.
   */
  it("reports the first failure in declared key order, not input order", () => {
    const result = score(
      {
        maxIterations: 1,
        toolsNever: ["issue_refund"],
        status: "paused_for_approval",
      },
      observed({ spans: [span("tool_exec", "issue_refund")] }),
    );

    expect(result.assertions.map((a) => a.name)).toEqual([
      "status",
      "toolsNever:issue_refund",
      "maxIterations",
    ]);
    expect(result.failureReason).toBe(
      'expected status "paused_for_approval", got "completed"',
    );
  });
});
