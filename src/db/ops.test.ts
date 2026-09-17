import { describe, expect, it } from "vitest";

import { budgetGauge, summarizeGuardrail, toRecentRun } from "./ops";

/**
 * Mission Control's two pure halves.
 *
 * Everything else in `ops.ts` needs Postgres and follows `src/db/evals.ts`'s
 * precedent — its evidence is a live query, not a mocked session. These two
 * are arithmetic and string handling, so they are pinned here with literal
 * expectations and `npm test` stays database-free.
 */
const USD = 1_000_000_000;

describe("budgetGauge", () => {
  it("reports ok well under the cap", () => {
    expect(
      budgetGauge({ spentNanos: USD, capNanos: 5 * USD, killSwitch: false }),
    ).toEqual({ state: "ok", percent: 20, remainingNanos: 4 * USD });
  });

  it("rounds percent to one decimal", () => {
    expect(
      budgetGauge({ spentNanos: USD, capNanos: 3 * USD, killSwitch: false })
        .percent,
    ).toBe(33.3);
  });

  /**
   * The boundary is inclusive on purpose: 80.0% is the point at which someone
   * should be told, and a strict `>` would leave the round number silent.
   */
  it("warns at exactly 80 percent", () => {
    expect(
      budgetGauge({
        spentNanos: 4 * USD,
        capNanos: 5 * USD,
        killSwitch: false,
      }),
    ).toEqual({ state: "warning", percent: 80, remainingNanos: USD });
  });

  it("stays ok just under 80 percent", () => {
    expect(
      budgetGauge({
        spentNanos: 3_970_000_000,
        capNanos: 5 * USD,
        killSwitch: false,
      }),
    ).toEqual({ state: "ok", percent: 79.4, remainingNanos: 1_030_000_000 });
  });

  /**
   * The threshold reads the *rounded* percent, so the badge and the number
   * beside it always agree. 79.99999998% displays as "80.0%", and a card
   * reading "80.0% · ok" is a worse bug than warning a hair early — whoever
   * is looking at it would have to decide which half to believe.
   */
  it("warns when a hair under 80 rounds up to it", () => {
    expect(
      budgetGauge({
        spentNanos: 3_999_999_999,
        capNanos: 5 * USD,
        killSwitch: false,
      }),
    ).toEqual({ state: "warning", percent: 80, remainingNanos: 1_000_000_001 });
  });

  it("is exhausted when spend equals the cap", () => {
    expect(
      budgetGauge({
        spentNanos: 5 * USD,
        capNanos: 5 * USD,
        killSwitch: false,
      }),
    ).toEqual({ state: "exhausted", percent: 100, remainingNanos: 0 });
  });

  it("clamps percent and remaining when spend overshoots the cap", () => {
    expect(
      budgetGauge({
        spentNanos: 9 * USD,
        capNanos: 5 * USD,
        killSwitch: false,
      }),
    ).toEqual({ state: "exhausted", percent: 100, remainingNanos: 0 });
  });

  /**
   * A zero cap divides by zero, and `Infinity` would render as a bar of
   * nonsense. It is also the honest reading: nothing may be spent, so the
   * budget is spent.
   */
  it("treats a zero cap as exhausted at 100 percent", () => {
    expect(
      budgetGauge({ spentNanos: 0, capNanos: 0, killSwitch: false }),
    ).toEqual({ state: "exhausted", percent: 100, remainingNanos: 0 });
  });

  it("reports killed regardless of spend", () => {
    expect(
      budgetGauge({ spentNanos: 0, capNanos: 5 * USD, killSwitch: true }),
    ).toEqual({ state: "killed", percent: 0, remainingNanos: 5 * USD });
  });

  /**
   * The switch outranks the cap, matching `checkBudget`'s ordering: an
   * operator who pulled it wants to be told about the switch, not about
   * arithmetic. `percent` still describes spend, because it answers a
   * different question from `state`.
   */
  it("keeps killed ahead of exhausted", () => {
    expect(
      budgetGauge({ spentNanos: 6 * USD, capNanos: 5 * USD, killSwitch: true }),
    ).toEqual({ state: "killed", percent: 100, remainingNanos: 0 });
  });
});

/**
 * Guardrail spans are written by four different call sites with four different
 * output shapes, and a fifth is being wired in another worktree right now. So
 * this keys off what is *present* in the payload rather than off a presumed
 * union — an unfamiliar shape degrades to the span name instead of throwing or
 * rendering `[object Object]`.
 */
describe("summarizeGuardrail", () => {
  it("names the refusal reason on a budget span", () => {
    expect(
      summarizeGuardrail({
        name: "budget",
        isError: true,
        output: {
          allowed: false,
          reason: "daily_cap_reached",
          remainingNanos: 0,
        },
      }),
    ).toBe("daily cap reached");
  });

  it("names the first violation when the policy engine lists them", () => {
    expect(
      summarizeGuardrail({
        name: "issue_refund",
        isError: true,
        output: {
          approved: false,
          violations: ["outside_refund_window", "exceeds_max_refund"],
        },
      }),
    ).toBe("outside refund window");
  });

  it("uses the error text a preflight threw", () => {
    expect(
      summarizeGuardrail({
        name: "issue_refund",
        isError: true,
        output: { error: "refund of $80.00 exceeds the $50.00 per-refund cap" },
      }),
    ).toBe("refund of $80.00 exceeds the $50.00 per-refund cap");
  });

  /** A span row is display data; a stack trace pasted into a table is not. */
  it("keeps only the first line of a multi-line error", () => {
    expect(
      summarizeGuardrail({
        name: "issue_refund",
        isError: true,
        output: { error: "denied by policy\n    at evaluateRefund (x.ts:1)" },
      }),
    ).toBe("denied by policy");
  });

  it("truncates a very long error", () => {
    const summary = summarizeGuardrail({
      name: "issue_refund",
      isError: true,
      output: { error: "x".repeat(300) },
    });
    expect(summary).toHaveLength(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  /**
   * The shape these three assert is `prepareTicketRun`'s, read from
   * `src/agent/guardrails.ts` rather than guessed.
   *
   * The signals go in the span's **input** and the withheld tools in its
   * output; the previous version of these tests put the signals in `output`,
   * a shape nothing writes, so they passed while Mission Control rendered the
   * real span as a bare `injection_scan`. A fake that agrees with the code
   * under test and with nothing else is worse than no test at all.
   */
  it("names the signals and the tools an injection scan withheld", () => {
    expect(
      summarizeGuardrail({
        name: "injection_scan",
        isError: false,
        input: {
          signals: [
            "ignore_instructions",
            "authority_claim",
            "prior_approval",
            "policy_override",
            "urgency",
          ],
        },
        output: {
          flagged: true,
          restrictedTools: ["issue_refund", "update_subscription"],
        },
      }),
    ).toBe(
      "Injection flagged: 5 signals, withheld issue_refund and update_subscription",
    );
  });

  it("says one signal in the singular, and names a lone tool alone", () => {
    expect(
      summarizeGuardrail({
        name: "injection_scan",
        isError: false,
        input: { signals: ["ignore_instructions"] },
        output: { flagged: true, restrictedTools: ["issue_refund"] },
      }),
    ).toBe("Injection flagged: 1 signal, withheld issue_refund");
  });

  it("still says a scan flagged when it withheld nothing", () => {
    expect(
      summarizeGuardrail({
        name: "injection_scan",
        isError: false,
        input: { signals: ["urgency"] },
        output: { flagged: true, restrictedTools: [] },
      }),
    ).toBe("Injection flagged: 1 signal");
  });

  it("falls back to the span name when the output says nothing", () => {
    expect(
      summarizeGuardrail({ name: "issue_refund", isError: true, output: null }),
    ).toBe("issue_refund");
  });

  it("falls back to the span name on an unrecognised shape", () => {
    expect(
      summarizeGuardrail({
        name: "update_subscription",
        isError: true,
        output: { somethingNew: true },
      }),
    ).toBe("update_subscription");
  });

  /**
   * `violations` is checked before `error`, because a denial span written by
   * a future call site may plausibly carry both and the enumerated code is the
   * more precise of the two.
   */
  it("prefers a violation over an error string", () => {
    expect(
      summarizeGuardrail({
        name: "issue_refund",
        isError: true,
        output: { violations: ["invoice_not_paid"], error: "denied" },
      }),
    ).toBe("invoice not paid");
  });

  it("ignores an empty violations array", () => {
    expect(
      summarizeGuardrail({
        name: "issue_refund",
        isError: true,
        output: { violations: [], error: "denied" },
      }),
    ).toBe("denied");
  });
});

describe("toRecentRun", () => {
  /**
   * The row the query returns, so the mapper is tested on the shape it is
   * actually handed rather than on a convenient subset.
   */
  const row = {
    id: "run-1",
    workspaceSlug: `sb_${"0123456789abcdef".repeat(2)}`,
    status: "completed",
    model: "haiku",
    startedAt: new Date("2026-09-10T03:00:00.000Z"),
    costUsd: "0.0021",
  };

  it("masks the sandbox slug, because the slug is the capability", () => {
    // Mission Control is unauthenticated. A visitor who reads a full slug off
    // this page can set it as their cookie and approve a stranger's paused
    // refund or wipe their sandbox. The badge only needs to say *which*
    // sandbox, which four characters do.
    expect(toRecentRun(row).workspaceLabel).toBe("sb_…cdef");
  });

  it("puts no full slug anywhere in the row it returns", () => {
    expect(JSON.stringify(toRecentRun(row))).not.toMatch(/sb_[0-9a-f]{32}/);
  });

  it("leaves the durable tenant named", () => {
    expect(toRecentRun({ ...row, workspaceSlug: "demo" }).workspaceLabel).toBe(
      "demo",
    );
  });

  it("carries the rest of the row through untouched", () => {
    expect(toRecentRun(row)).toEqual({
      id: "run-1",
      workspaceLabel: "sb_…cdef",
      status: "completed",
      model: "haiku",
      startedAt: new Date("2026-09-10T03:00:00.000Z"),
      costUsd: "0.0021",
    });
  });
});
