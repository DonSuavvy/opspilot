import { describe, expect, it } from "vitest";

import {
  budgetConfigSchema,
  checkBudget,
  UNVERIFIED_RATE_SAFETY_FACTOR,
  type BudgetConfig,
} from "./budget";

/**
 * The spend guard, pulled forward from Day 7 to Day 2.
 *
 * PLAN.md schedules budget guardrails for Day 7, and that was the right order
 * when the agent was going to run against a dedicated API key. It stopped
 * being right the moment OpsPilot pointed at the **covara** Bedrock account:
 * that account is what currently serves Causa's live Claude generation for a
 * working law firm, and the vault's own note flags its Claude TPD/TPM ceiling
 * as unvalidated at sustained volume, with the failure mode "answers stall
 * mid-day".
 *
 * So this is not a cost feature. It is the thing that makes it structurally
 * impossible for a demo loop — or a runaway eval, or a stranger clicking the
 * scenario injector — to spend an unbounded amount against an account someone
 * else's business depends on. It lands before the agent loop for that reason.
 *
 * Pure, like the policy engine: state is injected, nothing is read from a
 * clock or a database, and the decision is a value rather than a side effect.
 */
function config(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return { dailyCapNanos: 5_000_000_000, killSwitch: false, ...over }; // $5.00
}

describe("checkBudget", () => {
  it("allows a run that fits well inside the cap", () => {
    const d = checkBudget({
      spentTodayNanos: 0,
      estimatedRunNanos: 60_000_000, // ~$0.06, a Haiku run
      rateVerified: true,
      config: config(),
    });

    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
  });

  /**
   * The kill switch is the env-var escape hatch an operator reaches for when
   * something is visibly wrong. It has to outrank every other consideration,
   * including a completely unspent budget — otherwise "stop everything" means
   * "stop everything except the next run".
   */
  it("refuses on the kill switch even with the whole budget unspent", () => {
    const d = checkBudget({
      spentTodayNanos: 0,
      estimatedRunNanos: 1,
      rateVerified: true,
      config: config({ killSwitch: true }),
    });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("kill_switch");
  });

  it("reports the kill switch ahead of an exhausted budget", () => {
    const d = checkBudget({
      spentTodayNanos: 9_000_000_000,
      estimatedRunNanos: 1,
      rateVerified: true,
      config: config({ killSwitch: true }),
    });

    // Both conditions hold; the operator action is the more useful answer.
    expect(d.reason).toBe("kill_switch");
  });

  it("refuses once the day's spend has reached the cap", () => {
    const d = checkBudget({
      spentTodayNanos: 5_000_000_000,
      estimatedRunNanos: 1,
      rateVerified: true,
      config: config(),
    });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("daily_cap_reached");
  });

  /**
   * The check is a **pre-flight** gate, not a post-hoc audit. A run whose
   * estimate would cross the cap is refused before it starts rather than
   * discovered afterwards — the point is to never spend the money, and a
   * budget you can only detect breaching is not a budget.
   */
  it("refuses a run that would cross the cap, before it starts", () => {
    const d = checkBudget({
      spentTodayNanos: 4_900_000_000,
      estimatedRunNanos: 200_000_000, // would land at $5.10
      rateVerified: true,
      config: config(),
    });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("run_would_exceed_cap");
  });

  it("allows a run that lands exactly on the cap", () => {
    const d = checkBudget({
      spentTodayNanos: 4_900_000_000,
      estimatedRunNanos: 100_000_000,
      rateVerified: true,
      config: config(),
    });

    expect(d.allowed).toBe(true);
  });

  /**
   * The covara-specific safeguard, and the reason this module knows about rate
   * verification at all.
   *
   * Bedrock's Claude rates are unconfirmed, and the single data point that
   * could be retrieved from AWS showed a retired model priced at **2x** the
   * first-party rate. A budget enforced with rates that might be half the real
   * ones is not a budget — it is a cap that silently permits double the spend
   * against an account a law firm depends on.
   *
   * So an unverified rate card is charged at the pessimistic multiple for
   * gating purposes. The guard errs toward refusing a run that would have been
   * affordable, which is the cheap direction to be wrong in.
   */
  it("charges an unverified rate card at the pessimistic multiple", () => {
    const shared = {
      spentTodayNanos: 0,
      estimatedRunNanos: 3_000_000_000, // $3.00 nominal, under a $5 cap
      config: config(),
    };

    expect(checkBudget({ ...shared, rateVerified: true }).allowed).toBe(true);
    // x2 -> $6.00 against a $5.00 cap.
    expect(checkBudget({ ...shared, rateVerified: false }).allowed).toBe(false);
    expect(checkBudget({ ...shared, rateVerified: false }).reason).toBe(
      "run_would_exceed_cap",
    );
  });

  it("uses a safety factor greater than one", () => {
    expect(UNVERIFIED_RATE_SAFETY_FACTOR).toBeGreaterThan(1);
  });

  it("reports what is left, so a caller can show a budget bar", () => {
    const d = checkBudget({
      spentTodayNanos: 1_000_000_000,
      estimatedRunNanos: 1,
      rateVerified: true,
      config: config(),
    });

    expect(d.remainingNanos).toBe(4_000_000_000);
  });

  it("never reports negative headroom once overspent", () => {
    const d = checkBudget({
      spentTodayNanos: 7_000_000_000,
      estimatedRunNanos: 1,
      rateVerified: true,
      config: config(),
    });

    expect(d.remainingNanos).toBe(0);
  });

  /**
   * Same lesson as the policy engine's evaluation input (FAILURES entry 13):
   * every rule here is a `>` comparison, and every comparison against NaN is
   * false — so a poisoned number would not refuse, it would silently *allow*.
   * That is the dangerous direction for a spend guard.
   */
  it.each([
    ["NaN spend", { spentTodayNanos: Number.NaN }],
    ["Infinite estimate", { estimatedRunNanos: Number.POSITIVE_INFINITY }],
    ["negative spend", { spentTodayNanos: -1 }],
  ])("throws rather than allowing on %s", (_label, patch) => {
    expect(() =>
      checkBudget({
        spentTodayNanos: 0,
        estimatedRunNanos: 1,
        rateVerified: true,
        config: config(),
        ...patch,
      }),
    ).toThrow();
  });
});

/**
 * `OPSPILOT_DAILY_BUDGET_USD` and `OPSPILOT_KILL_SWITCH` have existed in
 * `.env.local` since Day 1 with no code reading them. Parsing them rather than
 * trusting them is the same call the policy engine made about
 * `sop_versions.policy_config`: a limit that cannot be parsed is a limit that
 * cannot be enforced, and enforcing nothing must never be the quiet default.
 */
describe("budgetConfigSchema", () => {
  it("reads a well-formed environment", () => {
    const c = budgetConfigSchema.parse({
      OPSPILOT_DAILY_BUDGET_USD: "5",
      OPSPILOT_KILL_SWITCH: "false",
    });

    expect(c.dailyCapNanos).toBe(5_000_000_000);
    expect(c.killSwitch).toBe(false);
  });

  it.each(["true", "1", "yes", "TRUE"])("treats %s as engaged", (v) => {
    expect(
      budgetConfigSchema.parse({
        OPSPILOT_DAILY_BUDGET_USD: "5",
        OPSPILOT_KILL_SWITCH: v,
      }).killSwitch,
    ).toBe(true);
  });

  /**
   * Fails closed. An absent or unreadable budget must not mean "unlimited" —
   * that is precisely the failure this module exists to prevent, and it would
   * arrive through the most ordinary route there is: a missing line in a
   * `.env` file on a new machine.
   */
  it.each([
    ["missing", {}],
    ["empty", { OPSPILOT_DAILY_BUDGET_USD: "" }],
    ["not a number", { OPSPILOT_DAILY_BUDGET_USD: "five" }],
    ["negative", { OPSPILOT_DAILY_BUDGET_USD: "-1" }],
    ["zero", { OPSPILOT_DAILY_BUDGET_USD: "0" }],
  ])("refuses a %s daily cap rather than defaulting to unlimited", (_l, env) => {
    expect(() => budgetConfigSchema.parse(env)).toThrow();
  });
});
