import { describe, expect, it } from "vitest";

import { describeBudgetRefusal, readBudgetRefusal } from "./budget-copy";

/**
 * The sentence a visitor reads when the spend guard says no.
 *
 * `/api/agent/run` answers a refusal with `budget: refused (rate_limited)`,
 * which is the right thing to put in a log and the wrong thing to put in a
 * browser. It names an internal enum, it does not say whether waiting helps,
 * and once per-visitor sandboxes exist it does not say whose fault it is.
 *
 * That last part is why the scope has to reach the copy. Two people can be
 * refused for `rate_limited` in the same second for opposite reasons: one is
 * clicking faster than their own sandbox allows, the other is queued behind
 * every other visitor. Telling the second person to slow down is a lie, and
 * telling the first that the demo is busy is an excuse.
 *
 * Pure, so it is tested without a database, a browser or a model call.
 */
describe("describeBudgetRefusal", () => {
  it("names this sandbox when the sandbox's own limit refused", () => {
    const copy = describeBudgetRefusal({
      reason: "rate_limited",
      scope: "workspace",
    });

    expect(copy).toMatch(/this sandbox/i);
    expect(copy).not.toMatch(/the demo/i);
  });

  it("names the demo when every sandbox together refused", () => {
    const copy = describeBudgetRefusal({
      reason: "rate_limited",
      scope: "global",
    });

    expect(copy).toMatch(/the demo/i);
    expect(copy).not.toMatch(/this sandbox/i);
  });

  /**
   * The refusal body does not carry a scope yet. Blaming one of the two on a
   * coin flip would be worse than saying only what is known, so an absent
   * scope names neither.
   */
  it("blames neither when the scope is missing", () => {
    const copy = describeBudgetRefusal({ reason: "rate_limited" });

    expect(copy).not.toMatch(/this sandbox/i);
    expect(copy).not.toMatch(/the demo/i);
  });

  it("tells a rate-limited caller that waiting helps", () => {
    for (const scope of ["workspace", "global", undefined] as const) {
      expect(describeBudgetRefusal({ reason: "rate_limited", scope })).toMatch(
        /minute/i,
      );
    }
  });

  /**
   * The three money refusals are not retryable, so none of them may suggest
   * trying again. A cap clears at midnight and a kill switch clears when a
   * person clears it, and the copy says which.
   */
  it("separates the switch a person pulled from the cap a day spent", () => {
    const killed = describeBudgetRefusal({ reason: "kill_switch" });
    const spent = describeBudgetRefusal({ reason: "daily_cap_reached" });

    expect(killed).toMatch(/kill switch/i);
    expect(killed).not.toMatch(/midnight/i);
    expect(spent).toMatch(/midnight/i);
    expect(spent).not.toMatch(/kill switch/i);
  });

  it("says a run no longer fits rather than that the cap is reached", () => {
    const copy = describeBudgetRefusal({ reason: "run_would_exceed_cap" });

    expect(copy).toMatch(/midnight/i);
    expect(copy).not.toMatch(/try again/i);
  });
});

/**
 * Reading the route's JSON body, defensively.
 *
 * The client cannot trust a shape it did not build. A body that is not a
 * refusal, or carries a reason this build has never heard of, must fall back
 * to whatever error handling was there before rather than render a confident
 * sentence about a refusal that may not have happened.
 */
describe("readBudgetRefusal", () => {
  it("reads the body the run route sends", () => {
    const refusal = readBudgetRefusal({
      error: "budget: refused (rate_limited)",
      reason: "rate_limited",
      retry_after_seconds: 60,
    });

    expect(refusal).toEqual({
      reason: "rate_limited",
      scope: null,
      retryAfterSeconds: 60,
    });
  });

  /**
   * Forward compatible on purpose. `scope` is not in the body today: the one
   * line that would add it belongs to a route this change may not touch. The
   * reader accepts it now so the copy lights up the day it arrives.
   */
  it("takes the scope when the body carries one", () => {
    expect(
      readBudgetRefusal({ reason: "rate_limited", scope: "global" })?.scope,
    ).toBe("global");
  });

  it.each([
    ["a plain error", { error: "boom" }],
    ["an unknown reason", { reason: "teapot" }],
    ["nothing at all", null],
    ["a string", "rate_limited"],
  ])("returns null for %s", (_label, body) => {
    expect(readBudgetRefusal(body)).toBeNull();
  });

  it("drops a scope it does not recognise rather than passing it on", () => {
    expect(
      readBudgetRefusal({ reason: "kill_switch", scope: "planet" })?.scope,
    ).toBeNull();
  });
});
