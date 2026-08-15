import { describe, expect, it } from "vitest";

import type { TokenUsage } from "./cost";

import {
  CACHE_MINIMUM_TOKENS,
  cachedSystem,
  cacheEligibility,
  describeCache,
  describeRunCache,
} from "./cache";

/**
 * Prompt caching fails silently. Miss the model's minimum prefix and the
 * request succeeds, reports `cache_creation_input_tokens: 0`, and the hit-rate
 * metric reads zero forever — indistinguishable from a caching bug.
 *
 * Demo mode runs Haiku 4.5, whose floor is 4096 against 512 on Opus 5, so the
 * SOP prefix is the *most* likely thing to sit under it. Decided 2026-08-14:
 * report the shortfall honestly rather than padding the constitution to clear
 * it, since a pad sized for Haiku is noise on Opus and padding that isn't real
 * policy content is theatre.
 */

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

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
    expect(result.shortfallTokens).toBe(0);
  });

  it("treats exactly the minimum as eligible", () => {
    expect(cacheEligibility({ model: "sonnet", promptTokens: 1024 }).eligible).toBe(true);
    expect(cacheEligibility({ model: "sonnet", promptTokens: 1023 }).eligible).toBe(false);
  });
});

describe("cachedSystem", () => {
  /**
   * Explicit blocks, not the top-level `cache_control` auto-placement: that
   * convenience is unsupported on Bedrock, which is where OpsPilot runs. It
   * would not error there — it would simply not cache, which is the same silent
   * failure this module exists to make visible.
   */
  it("marks the prompt as a cacheable prefix", () => {
    const blocks = cachedSystem("the compiled SOP");

    expect(blocks).toEqual([
      {
        type: "text",
        text: "the compiled SOP",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("keeps the prompt text byte-identical", () => {
    // Any drift in the prefix invalidates the cache, so the block must not
    // trim, normalise, or re-wrap what the compiler produced.
    const prompt = "  leading and trailing whitespace matters  \n\n";

    expect(cachedSystem(prompt)[0]!.text).toBe(prompt);
  });
});

/**
 * `describeCache` reads what actually happened rather than predicting what
 * should have. The distinction is the whole point: an estimate next to the cost
 * badge would be a guessed number in a project that already flags Bedrock costs
 * as `estimated: true`.
 *
 * The measurement is available because the three token classes are disjoint —
 * the API does not double-count a cached token as input. So when nothing
 * cached, `inputTokens` *is* the entire prompt, and comparing it to the floor
 * gives a measured reason rather than a guess.
 */
describe("describeCache", () => {
  it("reports a hit when tokens were read from cache", () => {
    const report = describeCache({
      model: "haiku",
      usage: usage({ inputTokens: 120, cacheReadInputTokens: 5_000 }),
    });

    expect(report.status).toBe("hit");
    expect(report.readTokens).toBe(5_000);
  });

  it("reports a write when the prefix was cached for the next call", () => {
    const report = describeCache({
      model: "haiku",
      usage: usage({ inputTokens: 120, cacheCreationInputTokens: 5_000 }),
    });

    expect(report.status).toBe("write");
    expect(report.writtenTokens).toBe(5_000);
  });

  /**
   * The case the honest-display decision exists for. Nothing cached, and the
   * whole prompt was billed as input — so the prompt is 900 tokens, which is
   * under Haiku's 4096 floor. That is a measured explanation, not a hunch.
   */
  it("explains a non-cache as below-threshold using the measured prompt size", () => {
    const report = describeCache({
      model: "haiku",
      usage: usage({ inputTokens: 900 }),
    });

    expect(report.status).toBe("below_threshold");
    expect(report.minimumTokens).toBe(4096);
    expect(report.shortfallTokens).toBe(3196);
  });

  /**
   * Same numbers, different model. On Opus the floor is 512, so a 900-token
   * prompt was eligible and simply did not hit — a cold first call, or a prefix
   * that changed. Reporting that as "below threshold" would be a lie, which is
   * why the floor is a per-model lookup rather than a constant.
   */
  it("distinguishes an eligible miss from a below-threshold prompt", () => {
    const report = describeCache({
      model: "opus",
      usage: usage({ inputTokens: 900 }),
    });

    expect(report.status).toBe("miss");
    expect(report.shortfallTokens).toBe(0);
  });

  it("counts all three token classes toward the prompt when some cached", () => {
    // Disjoint classes: a prefix that read 4000 and billed 200 as input was a
    // 4200-token prompt, not 200.
    const report = describeCache({
      model: "haiku",
      usage: usage({ inputTokens: 200, cacheReadInputTokens: 4_000 }),
    });

    expect(report.promptTokens).toBe(4_200);
  });

  it("carries a label that never claims a hit that did not happen", () => {
    expect(
      describeCache({ model: "haiku", usage: usage({ inputTokens: 900 }) }).label,
    ).toMatch(/below cache threshold/i);

    expect(
      describeCache({
        model: "haiku",
        usage: usage({ cacheReadInputTokens: 5_000 }),
      }).label,
    ).toMatch(/cache hit/i);
  });

  it("treats absent cache counters as zero rather than throwing", () => {
    // The four-field usage object is normalised upstream, but a provider that
    // omits the cache fields must degrade to "no cache", not crash the run.
    const report = describeCache({
      model: "haiku",
      usage: usage({ inputTokens: 10_000 }),
    });

    expect(report.status).toBe("miss");
    expect(report.readTokens).toBe(0);
    expect(report.writtenTokens).toBe(0);
  });
});

/**
 * Caught in the browser, not by a unit test: the console fed `describeCache`
 * the run's *summed* usage and rendered "cache miss — prefix was eligible but
 * not cached" on a Haiku run whose two prompts were 2618 and 2945 tokens.
 *
 * Neither was ever eligible — Haiku's floor is 4096 — but 2618 + 2945 = 5563
 * clears it arithmetically. The sum describes a prompt that never existed, and
 * the badge blamed the wrong thing in the confident voice of a measurement.
 *
 * Token counts sum across calls. Eligibility does not: it is a property of each
 * individual prefix, so the aggregate has to combine *verdicts*, never tokens.
 */
describe("describeRunCache", () => {
  const belowFloor = usage({ inputTokens: 2_618 });
  const alsoBelowFloor = usage({ inputTokens: 2_945 });

  it("reports below-threshold when no single prompt cleared the floor", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [belowFloor, alsoBelowFloor],
    });

    expect(report?.status).toBe("below_threshold");
  });

  it("reports the largest prompt, since that is the one closest to clearing", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [belowFloor, alsoBelowFloor],
    });

    expect(report?.promptTokens).toBe(2_945);
    expect(report?.shortfallTokens).toBe(4_096 - 2_945);
  });

  it("never sums token counts across calls into one prompt", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [belowFloor, alsoBelowFloor],
    });

    expect(report?.promptTokens).not.toBe(2_618 + 2_945);
  });

  it("reports a hit when any call read from cache", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [
        usage({ inputTokens: 200, cacheCreationInputTokens: 5_000 }),
        usage({ inputTokens: 200, cacheReadInputTokens: 5_000 }),
      ],
    });

    expect(report?.status).toBe("hit");
    expect(report?.readTokens).toBe(5_000);
  });

  it("reports a write when the prefix was cached but never read back", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [usage({ inputTokens: 200, cacheCreationInputTokens: 5_000 })],
    });

    expect(report?.status).toBe("write");
  });

  it("sums read tokens across every call that hit", () => {
    const report = describeRunCache({
      model: "haiku",
      usages: [
        usage({ cacheReadInputTokens: 4_000 }),
        usage({ cacheReadInputTokens: 4_500 }),
      ],
    });

    expect(report?.readTokens).toBe(8_500);
  });

  it("distinguishes an eligible miss from a below-threshold run", () => {
    const report = describeRunCache({
      model: "opus",
      usages: [belowFloor, alsoBelowFloor],
    });

    expect(report?.status).toBe("miss");
  });

  it("returns null when the run made no model calls", () => {
    expect(describeRunCache({ model: "haiku", usages: [] })).toBeNull();
  });
});
