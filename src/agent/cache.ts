/**
 * Prompt caching: marking the prefix, and reporting honestly on what happened.
 *
 * Caching fails silently. Miss the model's minimum cacheable prefix and the
 * request still succeeds — it simply reports `cache_creation_input_tokens: 0`,
 * and a hit-rate metric built on top reads zero forever. That is
 * indistinguishable from a caching bug, so the failure gets debugged instead of
 * explained.
 *
 * Demo mode runs Haiku 4.5, whose floor is the highest of the three at 4096
 * tokens, so the SOP prefix is exactly the thing most likely to sit under it.
 *
 * Decided 2026-08-14: display the shortfall rather than padding the
 * constitution to clear the floor. The floor is not monotonic across models —
 * 512 / 1024 / 4096 on Opus 5 / Sonnet 5 / Haiku 4.5 — so a pad sized for Haiku
 * is pure noise on Opus, and padding that isn't genuine policy content is
 * theatre a reviewer can spot. If the SOP later grows past 4096 on its own the
 * cache starts hitting and the same display reports it, with no code change.
 */
import type { LogicalModel } from "./provider";
import type { TokenUsage } from "./cost";

/**
 * The minimum cacheable prefix, per model, in tokens.
 *
 * Not monotonic across generations, which is why this is a lookup and not a
 * constant: a 3K-token prompt caches on Opus 5 and Sonnet 5 and silently does
 * not on Haiku 4.5.
 */
export const CACHE_MINIMUM_TOKENS: Readonly<Record<LogicalModel, number>> =
  Object.freeze({
    haiku: 4096,
    sonnet: 1024,
    opus: 512,
  });

export interface CacheEligibility {
  eligible: boolean;
  minimumTokens: number;
  shortfallTokens: number;
}

/**
 * Whether a prefix of `promptTokens` can cache on `model`.
 *
 * Exactly the minimum is eligible — the documented rule is a minimum, not an
 * exclusive bound.
 */
export function cacheEligibility({
  model,
  promptTokens,
}: {
  model: LogicalModel;
  promptTokens: number;
}): CacheEligibility {
  const minimumTokens = CACHE_MINIMUM_TOKENS[model];
  const eligible = promptTokens >= minimumTokens;
  return {
    eligible,
    minimumTokens,
    shortfallTokens: eligible ? 0 : minimumTokens - promptTokens,
  };
}

/* -------------------------------------------------------------------------- */
/* Marking the prefix                                                         */
/* -------------------------------------------------------------------------- */

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Wrap the compiled SOP as a cacheable system prefix.
 *
 * Explicit `cache_control` rather than the top-level auto-placement
 * convenience: that one is unsupported on Bedrock, which is where OpsPilot
 * runs. It would not error there — it would simply not cache, which is the
 * exact silent failure this module exists to surface.
 *
 * The text is passed through untouched. Caching is a prefix match on bytes, so
 * trimming or re-wrapping here would change the cache key and drop the hit rate
 * for a reason nothing in the trace would explain.
 */
export function cachedSystem(prompt: string): SystemBlock[] {
  return [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }];
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

export type CacheStatus = "hit" | "write" | "below_threshold" | "miss";

export interface CacheReport {
  status: CacheStatus;
  /** Tokens served from cache on this call, at ~0.1x input price. */
  readTokens: number;
  /** Tokens written to cache on this call, at ~1.25x input price. */
  writtenTokens: number;
  /** The whole prompt, summing all three disjoint token classes. */
  promptTokens: number;
  /** This model's floor, for display beside the verdict. */
  minimumTokens: number;
  /** How far under the floor, or 0 when the prompt was eligible. */
  shortfallTokens: number;
  /** Trace-ready, and never claims a hit that did not happen. */
  label: string;
}

/**
 * Describe what the cache actually did on one model call.
 *
 * Measured, not predicted. The three token classes are disjoint — the API does
 * not double-count a cached token as input — so their sum is the true prompt
 * size, and when nothing cached, `inputTokens` alone *is* the whole prompt.
 * That makes "below threshold" an observation rather than an estimate, and
 * costs no `count_tokens` round trip.
 *
 * Per call rather than per run: a multi-iteration run typically writes on the
 * first call and reads on the rest, and averaging that into one number would
 * hide the write. Callers aggregate across spans.
 */
export function describeCache({
  model,
  usage,
}: {
  model: LogicalModel;
  usage: TokenUsage;
}): CacheReport {
  const readTokens = usage.cacheReadInputTokens ?? 0;
  const writtenTokens = usage.cacheCreationInputTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + readTokens + writtenTokens;

  const { minimumTokens, shortfallTokens, eligible } = cacheEligibility({
    model,
    promptTokens,
  });

  if (readTokens > 0) {
    return {
      status: "hit",
      readTokens,
      writtenTokens,
      promptTokens,
      minimumTokens,
      shortfallTokens: 0,
      label: `cache hit — ${readTokens.toLocaleString("en-US")} tokens read`,
    };
  }

  if (writtenTokens > 0) {
    return {
      status: "write",
      readTokens,
      writtenTokens,
      promptTokens,
      minimumTokens,
      shortfallTokens: 0,
      label: `cache written — ${writtenTokens.toLocaleString("en-US")} tokens cached`,
    };
  }

  if (!eligible) {
    return {
      status: "below_threshold",
      readTokens,
      writtenTokens,
      promptTokens,
      minimumTokens,
      shortfallTokens,
      label:
        `below cache threshold — prompt is ${promptTokens.toLocaleString("en-US")} ` +
        `tokens, ${model} needs ${minimumTokens.toLocaleString("en-US")}`,
    };
  }

  return {
    status: "miss",
    readTokens,
    writtenTokens,
    promptTokens,
    minimumTokens,
    shortfallTokens: 0,
    label: "cache miss — prefix was eligible but not cached",
  };
}
