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

function pricing(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  const input = inputPerMTok * 1_000;
  return {
    inputNanosPerToken: input,
    outputNanosPerToken: outputPerMTok * 1_000,
    cacheReadNanosPerToken: input / 10,
    cacheWrite5mNanosPerToken: (input * 5) / 4,
    cacheWrite1hNanosPerToken: input * 2,
  };
}

/**
 * Derived rather than transcribed: every cache rate is a multiple of the input
 * rate, so writing them out by hand would create four more places for a typo
 * to hide. The multipliers are the part nobody quotes and therefore the part
 * most likely to be wrong.
 */
export const MODEL_PRICING: Readonly<Record<ModelId, ModelPricing>> = {
  "claude-haiku-4-5": pricing(1, 5),
  "claude-sonnet-5": pricing(3, 15),
  "claude-opus-5": pricing(5, 25),
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

export function costOf(
  model: ModelId,
  usage: TokenUsage,
  options: { cacheTtl?: CacheTtl } = {},
): CostBreakdown {
  const rates = MODEL_PRICING[model];
  if (!rates) {
    throw new RangeError(
      `cost: no pricing for model "${model}" — add it to MODEL_PRICING ` +
        `before running it, so a run can never be silently free`,
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
