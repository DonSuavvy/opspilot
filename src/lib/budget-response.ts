/**
 * How a budget refusal leaves the server.
 *
 * The other half of `budget-copy.ts`. That module turns a body into a
 * sentence; this one turns a `Reservation` into the body, and they are kept
 * next to each other because the field names have to agree and once did not.
 *
 * Shared by `/api/agent/run` and `/api/agent/resume`, which had a copy each.
 * Two copies of a wire format is how a field gets added to one of them.
 *
 * 429 for a rate limit and 402 for the money reasons, because they mean
 * different things to a caller: one says "come back in a minute" and carries
 * `Retry-After`, the others say "not today" and retrying makes things worse.
 * Both are decided *before* the stream opens — once the 200 and the
 * event-stream headers are out there is no status code left to report with,
 * and a refusal delivered as an SSE `error` event is one a `curl` pipeline
 * reads as success.
 */
import type { BudgetRefusal, RateLimitScope } from "@/agent/budget";

export interface BudgetRefusalLike {
  reason: BudgetRefusal;
  retryAfterSeconds?: number;
  /** Present on `rate_limited` and nothing else, exactly as `reserveRun` sets it. */
  rateLimitScope?: RateLimitScope;
}

export function budgetRefusalResponse(refusal: BudgetRefusalLike): Response {
  const headers =
    refusal.retryAfterSeconds !== undefined
      ? { "Retry-After": String(refusal.retryAfterSeconds) }
      : undefined;

  return Response.json(
    {
      error: `budget: refused (${refusal.reason})`,
      reason: refusal.reason,
      ...(refusal.retryAfterSeconds !== undefined
        ? { retry_after_seconds: refusal.retryAfterSeconds }
        : {}),
    },
    { status: refusal.reason === "rate_limited" ? 429 : 402, headers },
  );
}
