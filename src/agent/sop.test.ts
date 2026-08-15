import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type PolicyConfig } from "@/policy/refund";

import {
  CACHE_MINIMUM_TOKENS,
  cacheEligibility,
  compileSop,
  SOP_PLACEHOLDERS,
  UnknownPlaceholderError,
} from "./sop";

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
 * Prompt caching has a model-dependent floor and no error when you miss it —
 * the request simply reports `cache_creation_input_tokens: 0`. Demo mode runs
 * Haiku 4.5, whose floor is 4096, so a naive "cache the SOP prefix" silently
 * does not cache and the headline cache-hit metric reads zero forever.
 *
 * Decided 2026-08-14: report the threshold honestly rather than padding the
 * constitution to clear it. The floor is not monotonic across models (512 on
 * Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5), so a pad sized for Haiku is
 * noise on Opus, and padding that isn't real policy content is theatre.
 */
describe("cacheEligibility", () => {
  it("knows each model's documented minimum cacheable prefix", () => {
    expect(CACHE_MINIMUM_TOKENS.haiku).toBe(4096);
    expect(CACHE_MINIMUM_TOKENS.sonnet).toBe(1024);
    expect(CACHE_MINIMUM_TOKENS.opus).toBe(512);
  });

  it("reports a short Haiku prefix as below threshold", () => {
    const result = cacheEligibility({ model: "haiku", promptTokens: 400 });

    expect(result.eligible).toBe(false);
    expect(result.minimumTokens).toBe(4096);
    expect(result.shortfallTokens).toBe(3696);
  });

  it("reports the same prefix as eligible on opus, where the floor is lower", () => {
    const result = cacheEligibility({ model: "opus", promptTokens: 600 });

    expect(result.eligible).toBe(true);
    expect(result.minimumTokens).toBe(512);
    expect(result.shortfallTokens).toBe(0);
  });

  it("treats exactly the minimum as eligible", () => {
    expect(cacheEligibility({ model: "sonnet", promptTokens: 1024 }).eligible).toBe(
      true,
    );
    expect(cacheEligibility({ model: "sonnet", promptTokens: 1023 }).eligible).toBe(
      false,
    );
  });
});
