import { describe, expect, it } from "vitest";

import { readBudgetRefusal } from "./budget-copy";
import { budgetRefusalResponse } from "./budget-response";

/**
 * The round trip, deliberately, rather than two tests either side of a gap.
 *
 * `reserveRun` returns `rateLimitScope`; `readBudgetRefusal` reads `scope`.
 * Asserting on the body alone would let the two names drift apart again and
 * still pass, because each half would be checked against the shape its own
 * author had in mind. Building the response and then parsing it with the
 * reader the browser actually uses is the only assertion that proves the copy
 * is reachable.
 */
async function roundTrip(response: Response) {
  return readBudgetRefusal(await response.json());
}

describe("budgetRefusalResponse", () => {
  it("carries the workspace scope through to the copy layer", async () => {
    const response = budgetRefusalResponse({
      reason: "rate_limited",
      retryAfterSeconds: 42,
      rateLimitScope: "workspace",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await roundTrip(response)).toEqual({
      reason: "rate_limited",
      scope: "workspace",
      retryAfterSeconds: 42,
    });
  });

  it("carries the global scope through to the copy layer", async () => {
    const response = budgetRefusalResponse({
      reason: "rate_limited",
      retryAfterSeconds: 7,
      rateLimitScope: "global",
    });

    expect(await roundTrip(response)).toEqual({
      reason: "rate_limited",
      scope: "global",
      retryAfterSeconds: 7,
    });
  });

  it("says nothing about scope when the reservation named none", async () => {
    // The three money refusals have no scope, and inventing one to make the
    // body look uniform would hand a visitor a sentence about a ceiling that
    // did not refuse them.
    const response = budgetRefusalResponse({ reason: "daily_cap_reached" });

    expect(response.status).toBe(402);
    expect(response.headers.get("Retry-After")).toBeNull();

    const body = (await response.clone().json()) as Record<string, unknown>;
    expect("scope" in body).toBe(false);
    expect("retry_after_seconds" in body).toBe(false);
    expect(await roundTrip(response)).toEqual({
      reason: "daily_cap_reached",
      scope: null,
      retryAfterSeconds: null,
    });
  });

  it("keeps the line a curl pipeline greps for", async () => {
    const body = (await budgetRefusalResponse({
      reason: "kill_switch",
    }).json()) as Record<string, unknown>;

    expect(body.error).toBe("budget: refused (kill_switch)");
  });

  it("answers 402 for every reason that is not a rate limit", async () => {
    // 429 says "come back in a minute" and 402 says "not today". A caller that
    // retries into an exhausted cap makes it worse, so the two must not blur.
    expect(budgetRefusalResponse({ reason: "kill_switch" }).status).toBe(402);
    expect(budgetRefusalResponse({ reason: "run_would_exceed_cap" }).status).toBe(
      402,
    );
    expect(
      budgetRefusalResponse({ reason: "rate_limited", retryAfterSeconds: 1 })
        .status,
    ).toBe(429);
  });
});
