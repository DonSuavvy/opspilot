import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type PolicyConfig } from "@/policy/refund";
import { SOP_MARKDOWN } from "@/db/sop-content";

import { compileSop, SOP_PLACEHOLDERS, UnknownPlaceholderError } from "./sop";

/**
 * Day 4's whole claim is that the SOP *is* the prompt. That only holds if the
 * numbers the model reads come from the same row the `issue_refund` handler
 * revalidates against — otherwise editing the refund window changes what the
 * code enforces while the prose keeps saying thirty days, and the demo shows a
 * decision flip that the model was never told about.
 *
 * The seeded markdown interpolated `DEFAULT_POLICY` at *seed* time, which froze
 * the figures into a string. These tests pin the replacement: placeholders, and
 * substitution at compile time from `policyConfig`.
 */

function policy(overrides: {
  refund?: Partial<PolicyConfig["refund"]>;
  escalation?: Partial<PolicyConfig["escalation"]>;
}): PolicyConfig {
  return {
    refund: { ...DEFAULT_POLICY.refund, ...overrides.refund },
    escalation: { ...DEFAULT_POLICY.escalation, ...overrides.escalation },
  };
}

describe("compileSop", () => {
  it("substitutes the refund window from policyConfig, not from the markdown", () => {
    const markdown = "The refund window is {{refund.windowDays}} days.";

    expect(compileSop({ bodyMarkdown: markdown, policyConfig: DEFAULT_POLICY })).toContain(
      "The refund window is 30 days.",
    );
  });

  /**
   * Demo arc step 2, reduced to its load-bearing property. Same document, one
   * config field changed, and the text the model receives must differ — if this
   * passes trivially the demo proves nothing.
   */
  it("changes the compiled prompt when the window flips 30 -> 14", () => {
    const markdown = "The refund window is {{refund.windowDays}} days.";

    const thirty = compileSop({
      bodyMarkdown: markdown,
      policyConfig: policy({ refund: { windowDays: 30 } }),
    });
    const fourteen = compileSop({
      bodyMarkdown: markdown,
      policyConfig: policy({ refund: { windowDays: 14 } }),
    });

    expect(thirty).not.toEqual(fourteen);
    expect(fourteen).toContain("The refund window is 14 days.");
    expect(fourteen).not.toContain("30 days");
  });

  it("formats cents placeholders as dollars", () => {
    const markdown =
      "auto {{refund.maxAutoApprove}} / ceiling {{refund.maxRefund}} / churn {{escalation.churnRiskLtv}}";

    const compiled = compileSop({
      bodyMarkdown: markdown,
      policyConfig: DEFAULT_POLICY,
    });

    expect(compiled).toContain("auto $100.00");
    expect(compiled).toContain("ceiling $500.00");
    expect(compiled).toContain("churn $2,500.00");
  });

  it("substitutes every occurrence, not just the first", () => {
    const compiled = compileSop({
      bodyMarkdown: "{{refund.windowDays}} and {{refund.windowDays}}",
      policyConfig: policy({ refund: { windowDays: 14 } }),
    });

    expect(compiled).toBe("14 and 14");
  });

  /**
   * Fails loudly, in the same spirit as the tool registry's boot validation. A
   * typo'd placeholder that survives into the prompt would ship the literal
   * `{{refund.windowDay}}` to the model, which reads as an instruction nobody
   * wrote and degrades silently.
   */
  it("throws on an unknown placeholder rather than passing it through", () => {
    expect(() =>
      compileSop({
        bodyMarkdown: "window is {{refund.windowDay}} days",
        policyConfig: DEFAULT_POLICY,
      }),
    ).toThrow(UnknownPlaceholderError);
  });

  it("names the offending placeholder and the known vocabulary in the error", () => {
    expect(() =>
      compileSop({
        bodyMarkdown: "{{refund.nonsense}}",
        policyConfig: DEFAULT_POLICY,
      }),
    ).toThrow(/refund\.nonsense/);
  });

  it("leaves markdown without placeholders untouched", () => {
    const markdown = "# Heading\n\nProse with no substitutions.";

    expect(
      compileSop({ bodyMarkdown: markdown, policyConfig: DEFAULT_POLICY }),
    ).toBe(markdown);
  });

  /**
   * The policy engine is pure and takes `now` as an argument for exactly this
   * reason. A compiler that read the clock would make the prompt — and so the
   * prompt cache key — change between two runs of the same SOP version.
   */
  it("is deterministic across calls", () => {
    const markdown = "window {{refund.windowDays}} auto {{refund.maxAutoApprove}}";

    expect(compileSop({ bodyMarkdown: markdown, policyConfig: DEFAULT_POLICY })).toBe(
      compileSop({ bodyMarkdown: markdown, policyConfig: DEFAULT_POLICY }),
    );
  });

  it("exposes its placeholder vocabulary for the editor to validate against", () => {
    expect(SOP_PLACEHOLDERS).toContain("refund.windowDays");
    expect(SOP_PLACEHOLDERS).toContain("refund.maxAutoApprove");
    expect(SOP_PLACEHOLDERS).toContain("escalation.churnRiskLtv");
  });
});

/**
 * The tests above prove the substitution *mechanism* on toy strings. This block
 * proves the *shipped document* actually uses it.
 *
 * They are different failures. One stray un-parameterized literal — a hard
 * `**$500.00**` left in the prose — passes every mechanism test above and still
 * breaks demo arc step 2, because the model reads a figure the handler is no
 * longer enforcing. The guard has to run against the real markdown.
 */
describe("the shipped SOP document", () => {
  it("carries no hard-coded money figures", () => {
    // Every dollar amount must arrive via a renderer, which is what keeps the
    // prose honest after a policy edit. `$` followed by a digit in the *source*
    // means someone typed a figure instead of a placeholder.
    expect(SOP_MARKDOWN).not.toMatch(/\$\s*\d/);
  });

  it("carries no hard-coded day counts for the refund window", () => {
    expect(SOP_MARKDOWN).not.toMatch(/\b\d+\s+days?\b/);
  });

  it("compiles cleanly — every placeholder it uses is a known one", () => {
    expect(() =>
      compileSop({ bodyMarkdown: SOP_MARKDOWN, policyConfig: DEFAULT_POLICY }),
    ).not.toThrow();
  });

  it("leaves no unsubstituted placeholder in the compiled prompt", () => {
    const compiled = compileSop({
      bodyMarkdown: SOP_MARKDOWN,
      policyConfig: DEFAULT_POLICY,
    });

    expect(compiled).not.toContain("{{");
    expect(compiled).not.toContain("}}");
  });

  /**
   * Demo arc step 2, asserted end to end on the real document. If this fails,
   * the demo shows a refund denied under a rule the model was never told.
   */
  it("says 14 days and never 30 once the window is narrowed", () => {
    const compiled = compileSop({
      bodyMarkdown: SOP_MARKDOWN,
      policyConfig: policy({ refund: { windowDays: 14 } }),
    });

    expect(compiled).toContain("14 days");
    expect(compiled).not.toMatch(/\b30\s+days?\b/);
  });

  it("states the shipped figures when compiled against the default policy", () => {
    const compiled = compileSop({
      bodyMarkdown: SOP_MARKDOWN,
      policyConfig: DEFAULT_POLICY,
    });

    expect(compiled).toContain("30 days");
    expect(compiled).toContain("$100.00"); // maxAutoApproveCents
    expect(compiled).toContain("$500.00"); // maxRefundCents
    expect(compiled).toContain("$2,500.00"); // churnRiskLtvCents
  });

  /**
   * The injection guardrail is prose, not a number, and must survive every
   * policy edit — demo arc step 4 depends on it being in the prompt regardless
   * of what the refund figures say.
   */
  it("keeps the untrusted-ticket-body framing under any policy", () => {
    const compiled = compileSop({
      bodyMarkdown: SOP_MARKDOWN,
      policyConfig: policy({ refund: { windowDays: 1 } }),
    });

    expect(compiled).toContain("data written by a customer");
    expect(compiled).toContain("suspected_injection");
  });
});
