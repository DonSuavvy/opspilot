/**
 * What a refused run says to the person who clicked the button.
 *
 * The route already answers correctly. It returns 429 or 402, it sets
 * `Retry-After`, and it puts `budget: refused (rate_limited)` in the body,
 * which is exactly what a `curl` pipeline or a log line wants. A browser
 * wants something else: whether waiting helps, and whose limit was reached.
 *
 * The second question only became a question with per-visitor sandboxes.
 * Before them every `rate_limited` meant the same thing. Now two people can
 * be refused in the same second for opposite reasons, one clicking faster
 * than their own sandbox allows and one queued behind everybody else, and the
 * sentence has to tell them apart. `budget-response.ts` is what puts `scope`
 * on the wire; the two field names have to agree and once did not. Telling the second to slow down is a lie;
 * telling the first that the demo is busy hands them an excuse.
 *
 * Pure, and separate from the component that renders it, for the same reason
 * `approval-copy.ts` is: a sentence a stranger reads is worth a test, and a
 * test that has to mount React to read one is a test nobody runs.
 */
import type { BudgetRefusal, RateLimitScope } from "@/agent/budget";

const REASONS: ReadonlySet<string> = new Set<BudgetRefusal>([
  "kill_switch",
  "daily_cap_reached",
  "run_would_exceed_cap",
  "rate_limited",
]);

const SCOPES: ReadonlySet<string> = new Set<RateLimitScope>([
  "workspace",
  "global",
]);

export interface BudgetRefusalView {
  reason: BudgetRefusal;
  /**
   * Null when the body did not say, which is every refusal that is not a rate
   * limit and every response from a deploy older than this field.
   */
  scope: RateLimitScope | null;
  retryAfterSeconds: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn `/api/agent/run`'s JSON body into a refusal, or into nothing.
 *
 * Nothing is the important half. A 500 from a broken provider and a 402 from
 * a spent cap both arrive here as a parsed body, and rendering budget copy
 * over the first would tell a visitor the demo is out of money when it is
 * actually out of order. So an unrecognised reason returns null and the
 * caller keeps whatever error handling it already had.
 */
export function readBudgetRefusal(body: unknown): BudgetRefusalView | null {
  if (!isRecord(body)) return null;

  const reason = body.reason;
  if (typeof reason !== "string" || !REASONS.has(reason)) return null;

  const scope = body.scope;
  const retryAfter = body.retry_after_seconds;

  return {
    reason: reason as BudgetRefusal,
    scope:
      typeof scope === "string" && SCOPES.has(scope)
        ? (scope as RateLimitScope)
        : null,
    retryAfterSeconds:
      typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? retryAfter
        : null,
  };
}

/**
 * The rate-limit sentence, by whose ceiling answered.
 *
 * An absent scope names neither. The money refusals carry none, and an older
 * deploy answers without one — guessing between two opposite explanations to
 * make the sentence feel complete is how a demo tells a stranger something
 * false.
 */
function describeRateLimit(scope: RateLimitScope | null | undefined): string {
  if (scope === "workspace") {
    return "This sandbox is starting runs too fast. Wait a minute and run it again.";
  }
  if (scope === "global") {
    return (
      "The demo is busy. Runs are arriving from every sandbox at once, " +
      "faster than the shared account allows. Wait a minute and run it again."
    );
  }
  return "Runs are arriving too fast. Wait a minute and run it again.";
}

/**
 * One refusal, one sentence.
 *
 * The three money refusals never suggest retrying, because retrying into an
 * exhausted cap makes things worse and a person who does it twice learns
 * nothing. Each says instead what would have to change: midnight, or a person
 * turning the switch back off.
 */
export function describeBudgetRefusal(refusal: {
  reason: BudgetRefusal;
  scope?: RateLimitScope | null;
}): string {
  switch (refusal.reason) {
    case "rate_limited":
      return describeRateLimit(refusal.scope);
    case "kill_switch":
      return "Intake is paused. Someone pulled the kill switch, so no run may start.";
    case "daily_cap_reached":
      return "Intake is paused. The demo has spent today's budget, which clears at midnight UTC.";
    case "run_would_exceed_cap":
      return "Intake is paused. What is left of today's budget will not cover a run. It clears at midnight UTC.";
  }
}
