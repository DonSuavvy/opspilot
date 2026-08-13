/**
 * Cost accounting for agent runs.
 *
 * This module answers the question Mission Control is built around — *what did
 * this ticket cost to resolve?* — and it answers it in integers.
 *
 * **The unit is the nano-dollar.** The policy engine holds money in integer
 * cents; this holds it in integer nano-dollars (1e-9 USD) and converts to
 * micro-dollars only at the storage boundary, because `cost_usd` is
 * `numeric(12,6)`. Nanos rather than micros because the cache multipliers land
 * off the micro grid: a 1.25x cache write on Haiku's $1/MTok rate is 1.25
 * micro-dollars per token, which is not an integer. In nanos, every published
 * rate and every multiplier is exact, so a run's cost is the same number no
 * matter what order its spans were summed in.
 *
 * **1 nano-dollar per token == $1 per MTok.** A million tokens at 1000 nanos
 * each is 10^9 nanos, which is exactly one dollar. That identity is why the
 * table below can be transcribed straight from the pricing page — there is no
 * conversion arithmetic to get wrong.
 *
 * Rates verified against the `claude-api` skill on 2026-08-13 rather than from
 * memory, per CLAUDE.md: model IDs and prices changed in 2025-26.
 */

/** The three models this project runs. See CLAUDE.md's model strategy table. */
export type ModelId = "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-5";

/** Which cache TTL a write was billed at. 5 minutes is the API default. */
export type CacheTtl = "5m" | "1h";

export interface ModelPricing {
  /** Uncached input, nano-dollars per token. Equals the $/MTok figure. */
  inputNanosPerToken: number;
  outputNanosPerToken: number;
  /** ~0.1x input — the saving the trace viewer's cache badge reports. */
  cacheReadNanosPerToken: number;
  /** 1.25x input. The API default TTL. */
  cacheWrite5mNanosPerToken: number;
  /** 2x input. Cheaper per hour, dearer per write — needs more reads to pay off. */
  cacheWrite1hNanosPerToken: number;
}

/**
 * A price list plus the answer to "how do you know?".
 *
 * Provenance is part of the data because OpsPilot runs on two providers and
 * only one of them has confirmed rates. Amazon Bedrock is partner-operated and
 * priced separately; its current Claude rates could not be verified, and the
 * one figure that could be retrieved showed a retired model at **2x** the
 * first-party price. A rate card that cannot say where it came from is a rate
 * card whose output should not be presented as a fact — so `verifiedOn: null`
 * propagates into `CostBreakdown.estimated` and the number is labelled rather
 * than asserted. Cost per resolved ticket is the headline KPI; confidently
 * wrong is worse than openly approximate.
 */
export interface RateCard extends ModelPricing {
  /** ISO date these rates were confirmed, or `null` when unverified. */
  verifiedOn: string | null;
  /** Where they came from — a doc, a bill, a skill. Read by humans. */
  source: string;
}

export function rateCard(
  inputPerMTok: number,
  outputPerMTok: number,
  provenance: { verifiedOn: string | null; source: string },
): RateCard {
  const input = inputPerMTok * 1_000;
  return {
    inputNanosPerToken: input,
    outputNanosPerToken: outputPerMTok * 1_000,
    cacheReadNanosPerToken: input / 10,
    cacheWrite5mNanosPerToken: (input * 5) / 4,
    cacheWrite1hNanosPerToken: input * 2,
    ...provenance,
  };
}

const ANTHROPIC_PROVENANCE = {
  verifiedOn: "2026-08-13",
  source: "claude-api skill, first-party list rates",
} as const;

/**
 * First-party Anthropic API rates. Derived rather than transcribed: every
 * cache rate is a multiple of the input rate, so writing them out by hand
 * would create four more places for a typo to hide. The multipliers are the
 * part nobody quotes and therefore the part most likely to be wrong.
 */
export const ANTHROPIC_RATES: Readonly<Record<ModelId, RateCard>> = {
  "claude-haiku-4-5": rateCard(1, 5, ANTHROPIC_PROVENANCE),
  "claude-sonnet-5": rateCard(3, 15, ANTHROPIC_PROVENANCE),
  "claude-opus-5": rateCard(5, 25, ANTHROPIC_PROVENANCE),
};

/**
 * The token counts from one API response.
 *
 * Field names mirror the SDK's `usage` object in camelCase. All four are
 * counts of *distinct* token classes — the API does not double-count a cached
 * token as input, so the total is a plain sum.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface CostBreakdown {
  inputNanos: number;
  outputNanos: number;
  cacheReadNanos: number;
  cacheWriteNanos: number;
  totalNanos: number;
  /**
   * True when the rate card had no `verifiedOn` date. The arithmetic is exact
   * either way — this says the *prices* are unconfirmed, so the figure is an
   * estimate. Callers must not present an estimated cost as measured, and the
   * spend guard charges it at a pessimistic multiple.
   */
  estimated: boolean;
}

/**
 * `usage` comes off the Anthropic SDK — external data, the same category as
 * the Drizzle rows the policy engine learned not to trust (FAILURES entry 13).
 * A NaN here would produce a NaN cost, and one NaN row turns every `SUM` over
 * `cost_usd` into NaN: the dashboard shows *nothing* rather than something
 * visibly wrong, which is the harder failure to notice. Throwing is the loud
 * direction, and this is programmer-facing data, not a user-facing decision.
 */
function tokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `cost: ${field} must be a non-negative safe integer, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Takes the rate card rather than a model name, so the provider owns pricing
 * and this module owns only arithmetic. That split is what lets Bedrock and
 * the first-party API be priced differently without a branch in here.
 */
export function costOf(
  rates: RateCard,
  usage: TokenUsage,
  options: { cacheTtl?: CacheTtl } = {},
): CostBreakdown {
  if (!rates) {
    throw new RangeError(
      "cost: no rate card supplied — a run must never be silently free",
    );
  }

  const cacheWriteRate =
    options.cacheTtl === "1h"
      ? rates.cacheWrite1hNanosPerToken
      : rates.cacheWrite5mNanosPerToken;

  const inputNanos =
    tokenCount(usage.inputTokens, "inputTokens") * rates.inputNanosPerToken;
  const outputNanos =
    tokenCount(usage.outputTokens, "outputTokens") * rates.outputNanosPerToken;
  const cacheReadNanos =
    tokenCount(usage.cacheReadInputTokens, "cacheReadInputTokens") *
    rates.cacheReadNanosPerToken;
  const cacheWriteNanos =
    tokenCount(usage.cacheCreationInputTokens, "cacheCreationInputTokens") *
    cacheWriteRate;

  return {
    inputNanos,
    outputNanos,
    cacheReadNanos,
    cacheWriteNanos,
    totalNanos: inputNanos + outputNanos + cacheReadNanos + cacheWriteNanos,
    estimated: rates.verifiedOn === null,
  };
}

/**
 * Convert to the storage unit. `cost_usd` is `numeric(12,6)` — micro-dollars.
 *
 * Half-up, and stated here rather than left to `toFixed`, because it runs on
 * every span and a reader should be able to reproduce the figure in the trace
 * viewer by hand. Note the floor at 1: a real but sub-micro cost rounds *up*
 * to the smallest representable amount rather than to zero, so a cheap span is
 * never recorded as free.
 */
export function nanosToMicros(nanos: number): number {
  if (!Number.isSafeInteger(nanos) || nanos < 0) {
    throw new TypeError(
      `cost: nanos must be a non-negative safe integer, got ${String(nanos)}`,
    );
  }
  if (nanos === 0) return 0;
  return Math.max(1, Math.round(nanos / 1_000));
}

/** Format micro-dollars for the `numeric(12,6)` column Drizzle expects. */
export function microsToUsdString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}
