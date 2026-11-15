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
 * The minimum cacheable prefix per tier, for the current first-party
 * generation: Haiku 5.5, Sonnet 5.5 and Opus 5.5 all take 512 tokens.
 *
 * This is the fallback. The floor really belongs to the model generation, so
 * `CACHE_MINIMUM_BY_MODEL_ID` below is consulted first.
 */
export const CACHE_MINIMUM_TOKENS: Readonly<Record<LogicalModel, number>> =
  Object.freeze({
    haiku: 512,
    sonnet: 512,
    opus: 512,
  });

/**
 * The minimum cacheable prefix, by the wire id a model call was made with.
 *
 * Not monotonic across generations, which is why this is a lookup and not a
 * constant: a 3K-token prompt caches on Haiku 5.5 and silently does not on
 * Haiku 4.5. Both run in this project, because the Bedrock path is pinned to
 * the previous generation, and the tier name "haiku" cannot tell them apart.
 * The wire id can, and every `llm_call` span carries it.
 *
 * Plain strings rather than an import from `provider.ts`: the run console is a
 * client component and reads this module, and the provider module pulls in
 * both SDKs.
 */
export const CACHE_MINIMUM_BY_MODEL_ID: Readonly<Record<string, number>> =
  Object.freeze({
    "claude-haiku-5-5": 512,
    "claude-sonnet-5-5": 512,
    "claude-opus-5-5": 512,
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": 4096,
    "global.anthropic.claude-sonnet-4-6": 1024,
    "global.anthropic.claude-opus-4-6-v1": 4096,
  });

/** The floor for one call: by wire id when it is known, by tier otherwise. */
function minimumFor(model: LogicalModel, modelId?: string): number {
  if (modelId !== undefined && Object.hasOwn(CACHE_MINIMUM_BY_MODEL_ID, modelId)) {
    return CACHE_MINIMUM_BY_MODEL_ID[modelId]!;
  }
  return CACHE_MINIMUM_TOKENS[model];
}

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
  modelId,
  promptTokens,
}: {
  model: LogicalModel;
  /** The wire id the call was made with, when the caller has it. */
  modelId?: string;
  promptTokens: number;
}): CacheEligibility {
  const minimumTokens = minimumFor(model, modelId);
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
  modelId,
  usage,
}: {
  model: LogicalModel;
  modelId?: string;
  usage: TokenUsage;
}): CacheReport {
  const readTokens = usage.cacheReadInputTokens ?? 0;
  const writtenTokens = usage.cacheCreationInputTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + readTokens + writtenTokens;

  const { minimumTokens, shortfallTokens, eligible } = cacheEligibility({
    model,
    modelId,
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

/**
 * One verdict for a whole run, from its per-call usages.
 *
 * **Combine verdicts, never tokens.** Token counts sum across calls;
 * eligibility does not, because it is a property of each individual prefix.
 * Summing first is how the console came to render "prefix was eligible but not
 * cached" for a Haiku run whose two prompts were 2618 and 2945 tokens — neither
 * eligible, but 5563 together, describing a prompt that never existed.
 *
 * Precedence is hit > write > below_threshold > miss: a read is the outcome
 * worth reporting, and a run that wrote but never read has still done something
 * a later run benefits from.
 *
 * When nothing cached, the report names the **largest** prompt. It is the one
 * closest to clearing the floor, so its shortfall is the smallest true
 * shortfall — the honest answer to "how much more would it take".
 */
export function describeRunCache({
  model,
  modelId,
  usages,
}: {
  model: LogicalModel;
  modelId?: string;
  usages: readonly TokenUsage[];
}): CacheReport | null {
  if (usages.length === 0) return null;

  const reports = usages.map((usage) =>
    describeCache({ model, modelId, usage }),
  );

  const readTokens = reports.reduce((sum, r) => sum + r.readTokens, 0);
  if (readTokens > 0) {
    const writtenTokens = reports.reduce((sum, r) => sum + r.writtenTokens, 0);
    return {
      ...reports.find((r) => r.status === "hit")!,
      readTokens,
      writtenTokens,
      label: `cache hit — ${readTokens.toLocaleString("en-US")} tokens read`,
    };
  }

  const writtenTokens = reports.reduce((sum, r) => sum + r.writtenTokens, 0);
  if (writtenTokens > 0) {
    return {
      ...reports.find((r) => r.status === "write")!,
      writtenTokens,
      label: `cache written — ${writtenTokens.toLocaleString("en-US")} tokens cached`,
    };
  }

  // Nothing cached anywhere. The largest prompt is the most informative one.
  return reports.reduce((largest, r) =>
    r.promptTokens > largest.promptTokens ? r : largest,
  );
}
