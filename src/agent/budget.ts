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

/**
 * What one run is charged for, up front, before it is allowed to start — and
 * the same figure the loop uses as its per-call estimate.
 *
 * ~15k input + ~500 output on Haiku's $1/$5 card, rounded up. Measured runs
 * land between **$0.004 and $0.018**, so one call's estimate comfortably
 * covers a whole run. That is deliberate: the reservation is written to
 * `agent_runs.cost_usd` the moment a run starts, so it is what every
 * *concurrent* run sees as spend-in-flight, and a figure that under-states a
 * run would let a burst through. Over-stating it refuses a run that would have
 * been affordable, which is the cheap direction to be wrong in against an
 * account someone else's business depends on.
 *
 * Named here rather than in each of the three routes that need it, so the
 * reservation and the pre-flight can never drift apart.
 */
export const ESTIMATED_RUN_NANOS = 20_000_000; // $0.02

/** The rate-limit window. One minute, and the longest a caller must wait. */
const RATE_WINDOW_SECONDS = 60;

export interface BudgetConfig {
  dailyCapNanos: number;
  killSwitch: boolean;
  /** Runs allowed to *start* in any 60-second window, per workspace. */
  runsPerMinute: number;
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
    /**
     * Defaults rather than failing closed, unlike the cap above, and the
     * asymmetry is the point. An absent cap means *unlimited money*, which is
     * the failure this module exists to prevent. An absent rate limit means a
     * default that already holds — ten runs a minute is well outside anything
     * the demo does — so refusing to boot over it would be theatre. A *set but
     * unreadable* one still throws: someone wrote it down for a reason.
     */
    OPSPILOT_RUNS_PER_MINUTE: z
      .string()
      .optional()
      .transform((s, ctx) => {
        if (s === undefined) return DEFAULT_RUNS_PER_MINUTE;
        const n = Number(s);
        if (!Number.isSafeInteger(n) || n <= 0) {
          ctx.addIssue({
            code: "custom",
            message: `OPSPILOT_RUNS_PER_MINUTE must be a positive integer, got "${s}"`,
          });
          return z.NEVER;
        }
        return n;
      }),
  })
  .transform(
    (env): BudgetConfig => ({
      dailyCapNanos: Math.round(env.OPSPILOT_DAILY_BUDGET_USD * NANOS_PER_USD),
      killSwitch: TRUTHY.has((env.OPSPILOT_KILL_SWITCH ?? "").toLowerCase()),
      runsPerMinute: env.OPSPILOT_RUNS_PER_MINUTE,
    }),
  );

const DEFAULT_RUNS_PER_MINUTE = 10;

export type BudgetRefusal =
  | "kill_switch"
  | "daily_cap_reached"
  | "run_would_exceed_cap"
  | "rate_limited";

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

export interface ReservationCheck extends BudgetCheck {
  /** Runs already *started* in this workspace inside the rate window. */
  runsInLastMinute: number;
}

export interface ReservationDecision extends BudgetDecision {
  /** Set only on `rate_limited`, so a 429 can carry `Retry-After`. */
  retryAfterSeconds?: number;
}

/**
 * What a *starting* run is asked, as opposed to what an in-flight one is asked
 * before each call.
 *
 * `checkBudget` prices one call. It cannot see the shape of the danger here:
 * what makes a burst harmful is not its price but its concurrency. Ten runs
 * costing two cents each are eight cents inside a five-dollar cap and still
 * enough to trip Bedrock's 429 on an account shared with a law firm's live
 * generation — the exact failure the eval suite hit and CLAUDE.md logs. So the
 * arrival rate is a second axis, checked once when a run asks to start rather
 * than on every call: a run refused for arriving too fast should never have
 * opened a row, spent a token, or reserved a cent.
 *
 * Ordered below money on purpose. The cap and the kill switch are about an
 * account balance someone else depends on and are not retryable; a rate limit
 * is a "come back in a minute". Telling a caller to retry into an exhausted
 * budget would be worse than useless.
 */
export function decideReservation(
  input: ReservationCheck,
): ReservationDecision {
  const inWindow = finiteNonNegative(
    input.runsInLastMinute,
    "runsInLastMinute",
  );

  // The money questions first, so their answers are never masked by a
  // retryable one — and so the kill switch keeps outranking everything.
  const budget = checkBudget(input);
  if (!budget.allowed) return budget;

  if (inWindow >= finiteNonNegative(input.config.runsPerMinute, "runsPerMinute")) {
    return {
      allowed: false,
      reason: "rate_limited",
      remainingNanos: budget.remainingNanos,
      retryAfterSeconds: RATE_WINDOW_SECONDS,
    };
  }

  return budget;
}
