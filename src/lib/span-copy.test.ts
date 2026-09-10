import { describe, expect, it } from "vitest";

import { INJECTION_SCAN_SPAN } from "@/agent/guardrails";
import { describeSpan, type DescribableSpan } from "@/lib/span-copy";

/** A span with only the fields `describeSpan` reads, so nothing else is implied. */
function span(overrides: Partial<DescribableSpan> = {}): DescribableSpan {
  return {
    type: "tool_exec",
    name: "get_customer",
    isError: false,
    input: null,
    output: null,
    usage: null,
    ...overrides,
  };
}

/** The shape `prepareTicketRun` actually emits at seq 0 on a flagged ticket. */
function injectionScan(
  signals: unknown,
  restrictedTools: unknown,
): DescribableSpan {
  return span({
    type: "guardrail",
    name: INJECTION_SCAN_SPAN,
    isError: false,
    input: { signals },
    output: { flagged: true, restrictedTools },
  });
}

describe("describeSpan", () => {
  describe("the injection scan", () => {
    it("names the signal count and the tools it withheld", () => {
      expect(
        describeSpan(
          injectionScan(
            [
              "ignore_instructions",
              "override_claim",
              "authority_claim",
              "approval_bypass",
              "confirm_processed",
            ],
            ["issue_refund", "update_subscription"],
          ),
        ),
      ).toBe(
        "Flagged: 5 signals, withheld issue_refund and update_subscription",
      );
    });

    it("says signal, singular, when there was one", () => {
      expect(describeSpan(injectionScan(["override_claim"], ["issue_refund"])))
        .toBe("Flagged: 1 signal, withheld issue_refund");
    });

    it("falls back to the span name when the signals are missing", () => {
      expect(describeSpan(injectionScan(undefined, ["issue_refund"]))).toBe(
        "injection_scan",
      );
    });

    it("falls back to the span name when nothing was withheld", () => {
      expect(describeSpan(injectionScan(["override_claim"], []))).toBe(
        "injection_scan",
      );
    });
  });

  describe("the budget guardrail", () => {
    it("names the refusal reason", () => {
      expect(
        describeSpan(
          span({
            type: "guardrail",
            name: "budget",
            isError: true,
            input: { spentTodayNanos: 5_000_000_000 },
            output: {
              allowed: false,
              reason: "daily_cap_reached",
              remainingNanos: 0,
            },
          }),
        ),
      ).toBe("Budget refused: daily_cap_reached");
    });

    it("falls back to the span name when the reason is null", () => {
      expect(
        describeSpan(
          span({
            type: "guardrail",
            name: "budget",
            isError: true,
            input: {},
            output: { allowed: false, reason: null, remainingNanos: 0 },
          }),
        ),
      ).toBe("budget");
    });
  });

  describe("a tool preflight guardrail", () => {
    it("says the policy refused the call, by tool name", () => {
      expect(
        describeSpan(
          span({
            type: "guardrail",
            name: "issue_refund",
            isError: true,
            input: { invoice_id: "INV-2002" },
            output: { error: "refund window is 14 days; invoice is 22 old" },
          }),
        ),
      ).toBe("issue_refund refused by policy");
    });
  });

  describe("an approval wait", () => {
    it("names the tool waiting on a decision", () => {
      expect(
        describeSpan(
          span({
            type: "approval_wait",
            name: "issue_refund",
            input: { invoice_id: "INV-2002", amount_cents: 4900 },
            output: { toolUseId: "toolu_01" },
          }),
        ),
      ).toBe("Waiting for approval: issue_refund");
    });

    it("says only that it is waiting when no tool is named", () => {
      expect(describeSpan(span({ type: "approval_wait", name: "" }))).toBe(
        "Waiting for approval",
      );
    });
  });

  describe("a tool execution", () => {
    it("is its own name", () => {
      expect(describeSpan(span({ name: "get_invoices" }))).toBe("get_invoices");
    });

    it("is marked when the call came back an error", () => {
      expect(
        describeSpan(
          span({
            name: "issue_refund",
            isError: true,
            output: { error: "out of policy" },
          }),
        ),
      ).toBe("issue_refund (error)");
    });
  });

  describe("a model call", () => {
    it("carries the token counts when the turn reported usage", () => {
      expect(
        describeSpan(
          span({
            type: "llm_call",
            name: "haiku",
            usage: {
              inputTokens: 2618,
              outputTokens: 412,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          }),
        ),
      ).toBe("haiku · 2618/412 tok");
    });

    it("is the model name alone when there is no usage", () => {
      expect(describeSpan(span({ type: "llm_call", name: "haiku" }))).toBe(
        "haiku",
      );
    });
  });

  describe("malformed spans", () => {
    // Everything here is a shape the wire could carry after a schema change.
    // None of it may throw: this renders inside the live trace, and a summary
    // that throws takes the whole console down mid-run.
    it("never throws, and always says something", () => {
      const malformed: DescribableSpan[] = [
        span({ type: "guardrail", name: INJECTION_SCAN_SPAN, input: null }),
        span({ type: "guardrail", name: INJECTION_SCAN_SPAN, input: "signals" }),
        injectionScan("ignore_instructions", ["issue_refund"]),
        injectionScan([""], ["issue_refund"]),
        injectionScan(["override_claim"], [42]),
        span({ type: "guardrail", name: "budget", isError: true, output: null }),
        span({ type: "guardrail", name: "budget", isError: true, output: [] }),
        span({ type: "guardrail", name: "sop_check", isError: false }),
        span({ type: "llm_call", name: "haiku", usage: null }),
      ];

      for (const bad of malformed) {
        expect(() => describeSpan(bad)).not.toThrow();
        expect(describeSpan(bad).length).toBeGreaterThan(0);
      }
    });
  });
});
