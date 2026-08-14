/**
 * The spend guard.
 *
 * PLAN.md schedules budget guardrails for Day 7. That ordering was right while
 * the agent was going to run against a dedicated API key, and wrong the moment
 * it pointed at the **covara** Bedrock account — which currently serves a
 * working law firm's live Claude generation, and whose Claude TPD/TPM ceiling
 * the vault records as *unvalidated at sustained volume*, failure mode
 * "answers stall mid-day".
 *
 * So this is not a cost feature. It is what makes it structurally impossible
 * for a demo loop, a runaway eval, or a stranger clicking the scenario
 * injector to spend an unbounded amount against an account someone else's
 * business depends on. It lands before the agent loop for exactly that reason:
 * the loop should never have been able to run without it.
 *
 * Pure, on the same terms as the policy engine — state is injected, nothing is
 * read from a clock or a database, and the decision is a returned value rather
 * than a side effect. That is what makes it testable without a database and
 * deterministic in the eval suite.
 */
import { z } from "zod";

const NANOS_PER_USD = 1_000_000_000;

/**
 * How much a run priced with an **unverified** rate card is charged for gating
 * purposes.
 *
 * Bedrock's Claude rates are unconfirmed, and the single comparable figure
 * retrievable from AWS showed a retired model at 2x the first-party rate.
 * Enforcing a cap using rates that might be half the real ones is not a cap —
 * it silently permits double the spend. Charging the pessimistic multiple errs
 * toward refusing a run that would have been affordable, which is the cheap
 * direction to be wrong in when the account is shared with production.
 *
 * Drop this to 1 once a provider's rates carry a `verifiedOn` date.
 */
export const UNVERIFIED_RATE_SAFETY_FACTOR = 2;

export interface BudgetConfig {
  dailyCapNanos: number;
  killSwitch: boolean;
}

const TRUTHY = new Set(["true", "1", "yes", "on"]);

/**
 * `OPSPILOT_DAILY_BUDGET_USD` and `OPSPILOT_KILL_SWITCH` have sat in
 * `.env.local` since Day 1 with no code reading them. Parsing rather than
 * trusting is the same call the policy engine made about `policy_config`: a
 * limit that cannot be parsed is a limit that cannot be enforced.
 *
 * It **fails closed**. An absent, empty, non-numeric, zero or negative cap
 * throws instead of defaulting to unlimited — because "unlimited" is the exact
 * outcome this module exists to prevent, and it would arrive by the most
 * ordinary route there is: one missing line in a `.env` on a fresh machine.
 */
export const budgetConfigSchema = z
  .object({
    OPSPILOT_DAILY_BUDGET_USD: z
      .string()
      .min(1, "OPSPILOT_DAILY_BUDGET_USD is required — refusing to run uncapped")
      .transform((s, ctx) => {
        const usd = Number(s);
        if (!Number.isFinite(usd) || usd <= 0) {
          ctx.addIssue({
            code: "custom",
            message: `OPSPILOT_DAILY_BUDGET_USD must be a positive number, got "${s}"`,
          });
          return z.NEVER;
        }
        return usd;
      }),
    OPSPILOT_KILL_SWITCH: z.string().optional(),
  })
  .transform(
    (env): BudgetConfig => ({
      dailyCapNanos: Math.round(env.OPSPILOT_DAILY_BUDGET_USD * NANOS_PER_USD),
      killSwitch: TRUTHY.has((env.OPSPILOT_KILL_SWITCH ?? "").toLowerCase()),
    }),
  );

export type BudgetRefusal =
  | "kill_switch"
  | "daily_cap_reached"
  | "run_would_exceed_cap";

export interface BudgetDecision {
  allowed: boolean;
  reason: BudgetRefusal | null;
  /** Headroom left today, floored at zero. Drives the Mission Control bar. */
  remainingNanos: number;
}

export interface BudgetCheck {
  spentTodayNanos: number;
  estimatedRunNanos: number;
  /** False when the rate card had no `verifiedOn` — see the safety factor. */
  rateVerified: boolean;
  config: BudgetConfig;
}

/**
 * Same lesson as the policy engine's evaluation input (FAILURES entry 13):
 * every rule below is a `>` comparison, and every comparison against NaN is
 * false. A poisoned number would therefore not refuse — it would *allow*,
 * which for a spend guard is the dangerous direction. Throw instead.
 */
function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `budget: ${field} must be a finite non-negative number, got ${String(value)}`,
    );
  }
  return value;
}

export function checkBudget(input: BudgetCheck): BudgetDecision {
  const spent = finiteNonNegative(input.spentTodayNanos, "spentTodayNanos");
  const estimate = finiteNonNegative(
    input.estimatedRunNanos,
    "estimatedRunNanos",
  );
  const cap = finiteNonNegative(input.config.dailyCapNanos, "dailyCapNanos");

  const remainingNanos = Math.max(0, cap - spent);

  // Ordered by how fundamental the refusal is: an operator pulling the kill
  // switch wants to hear about the kill switch, not about arithmetic.
  if (input.config.killSwitch) {
    return { allowed: false, reason: "kill_switch", remainingNanos };
  }

  if (spent >= cap) {
    return { allowed: false, reason: "daily_cap_reached", remainingNanos };
  }

  const charged = input.rateVerified
    ? estimate
    : estimate * UNVERIFIED_RATE_SAFETY_FACTOR;

  // Pre-flight, not post-hoc: refuse before the money is spent. A budget you
  // can only detect breaching is not a budget.
  if (spent + charged > cap) {
    return { allowed: false, reason: "run_would_exceed_cap", remainingNanos };
  }

  return { allowed: true, reason: null, remainingNanos };
}
