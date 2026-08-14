import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_RATES,
  costOf,
  nanosToMicros,
  type RateCard,
  type TokenUsage,
} from "./cost";

/**
 * Cost accounting is on CLAUDE.md's test-first list for the same reason the
 * policy engine is: it is pure, it is arithmetic about money, and it feeds a
 * number the product is built to report — *cost per resolved ticket*, the
 * headline Mission Control KPI.
 *
 * Two decisions this suite pins.
 *
 * **Money is never a float.** The policy engine holds refunds in integer cents;
 * this holds cost in integer **nano-dollars** and converts to micro-dollars
 * only at the storage boundary, because `cost_usd` is `numeric(12,6)` — six
 * decimal places, i.e. micro-dollars. Nanos are the working unit rather than
 * micros because the cache multipliers land off the micro grid: a 1.25x cache
 * write on Haiku's $1/MTok is 1.25 micro-dollars per token, which is not an
 * integer. In nanos every price and every multiplier is exact.
 *
 * **Prices are per MTok, and 1 nano-dollar/token == $1/MTok.** A million
 * tokens at 1000 nanos each is 10^9 nanos, which is exactly $1. That identity
 * is why the table below can be read straight off the pricing page with no
 * conversion arithmetic to get wrong.
 *
 * Rates verified against the `claude-api` skill on 2026-08-13:
 * Haiku 4.5 $1/$5 · Sonnet 5 $3/$15 · Opus 5 $5/$25 per MTok.
 */
describe("ANTHROPIC_RATES", () => {
  it("prices the three models the project actually runs", () => {
    expect(Object.keys(ANTHROPIC_RATES).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it.each([
    ["claude-haiku-4-5", 1_000, 5_000],
    ["claude-sonnet-5", 3_000, 15_000],
    ["claude-opus-5", 5_000, 25_000],
  ] as const)(
    "%s costs the published per-MTok rate, in nanos per token",
    (model, inputNanos, outputNanos) => {
      expect(ANTHROPIC_RATES[model].inputNanosPerToken).toBe(inputNanos);
      expect(ANTHROPIC_RATES[model].outputNanosPerToken).toBe(outputNanos);
    },
  );

  /**
   * The multipliers are the part most likely to be mis-set, because they are
   * the part nobody quotes. Cache reads are ~0.1x base input; a 5-minute cache
   * write is 1.25x; a 1-hour write is 2x. Asserted as exact integers so a
   * float multiplier cannot creep in unnoticed.
   */
  it.each(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"] as const)(
    "%s derives cache rates from its input rate exactly",
    (model) => {
      const p = ANTHROPIC_RATES[model];
      expect(p.cacheReadNanosPerToken).toBe(p.inputNanosPerToken / 10);
      expect(p.cacheWrite5mNanosPerToken).toBe(
        (p.inputNanosPerToken * 5) / 4,
      );
      expect(p.cacheWrite1hNanosPerToken).toBe(p.inputNanosPerToken * 2);
      // Every rate lands on the integer grid — no float anywhere. Only the
      // numeric fields; a rate card also carries its provenance as strings.
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "number") {
          expect(Number.isInteger(v), `${k} must be an integer`).toBe(true);
        }
      }
    },
  );

  /**
   * Provenance is data, not a comment. `verifiedOn` is what makes a cost an
   * assertion rather than an estimate — the first-party card has a date
   * because these rates were read off the claude-api skill today.
   */
  it.each(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"] as const)(
    "%s records when and where its rates were verified",
    (model) => {
      expect(ANTHROPIC_RATES[model].verifiedOn).toBe("2026-08-13");
      expect(ANTHROPIC_RATES[model].source).toMatch(/claude-api skill/i);
    },
  );

  it("prices a first-party run as measured, not estimated", () => {
    expect(
      costOf(ANTHROPIC_RATES["claude-haiku-4-5"], usage({ inputTokens: 1 }))
        .estimated,
    ).toBe(false);
  });

  /**
   * The complement, and the reason `estimated` exists: a card with no
   * `verifiedOn` — Bedrock's, today — taints every figure derived from it.
   */
  it("flags a run priced with an unverified card as an estimate", () => {
    const unverified: RateCard = {
      ...ANTHROPIC_RATES["claude-haiku-4-5"],
      verifiedOn: null,
      source: "UNVERIFIED placeholder",
    };

    expect(costOf(unverified, usage({ inputTokens: 1 })).estimated).toBe(true);
  });
});

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...over,
  };
}

describe("costOf", () => {
  it("charges nothing for a run that used nothing", () => {
    expect(costOf(ANTHROPIC_RATES["claude-haiku-4-5"], usage()).totalNanos).toBe(0);
  });

  /**
   * The identity the whole table rests on: a million input tokens on a $1/MTok
   * model costs exactly one dollar — 10^9 nanos — with no rounding applied.
   */
  it("charges exactly $1.00 for 1M input tokens at $1/MTok", () => {
    const c = costOf(ANTHROPIC_RATES["claude-haiku-4-5"], usage({ inputTokens: 1_000_000 }));
    expect(c.inputNanos).toBe(1_000_000_000);
    expect(c.totalNanos).toBe(1_000_000_000);
  });

  it("charges each token class at its own rate and sums them", () => {
    const c = costOf(ANTHROPIC_RATES["claude-opus-5"],
      usage({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 2_000,
      }),
    );

    expect(c.inputNanos).toBe(1_000 * 5_000);
    expect(c.outputNanos).toBe(500 * 25_000);
    expect(c.cacheReadNanos).toBe(10_000 * 500);
    expect(c.cacheWriteNanos).toBe(2_000 * 6_250);
    expect(c.totalNanos).toBe(
      c.inputNanos + c.outputNanos + c.cacheReadNanos + c.cacheWriteNanos,
    );
  });

  /**
   * The economic claim the trace viewer will render: reading from cache is an
   * order of magnitude cheaper than paying full input price for the same
   * tokens. If this inverts, the cache badge is advertising a saving that
   * isn't there.
   */
  it("makes a cache read exactly a tenth of an uncached input token", () => {
    const cached = costOf(ANTHROPIC_RATES["claude-sonnet-5"],
      usage({ cacheReadInputTokens: 10_000 }),
    );
    const uncached = costOf(ANTHROPIC_RATES["claude-sonnet-5"], usage({ inputTokens: 10_000 }));

    expect(cached.totalNanos * 10).toBe(uncached.totalNanos);
  });

  it("charges a 1-hour cache write more than a 5-minute one", () => {
    const short = costOf(ANTHROPIC_RATES["claude-sonnet-5"],
      usage({ cacheCreationInputTokens: 1_000 }),
    );
    const long = costOf(ANTHROPIC_RATES["claude-sonnet-5"],
      usage({ cacheCreationInputTokens: 1_000 }),
      { cacheTtl: "1h" },
    );

    expect(short.cacheWriteNanos).toBe(1_000 * 3_750);
    expect(long.cacheWriteNanos).toBe(1_000 * 6_000);
  });

  /**
   * Integer arithmetic exists so that summing spans is exact. In floats,
   * accumulating a third of a cent ten thousand times drifts; the drift lands
   * in "cost per resolved ticket", which is the number on the dashboard.
   */
  it("sums ten thousand spans without drift", () => {
    const one = costOf(ANTHROPIC_RATES["claude-haiku-4-5"], usage({ outputTokens: 3 }));
    let total = 0;
    for (let i = 0; i < 10_000; i++) total += one.totalNanos;

    expect(total).toBe(10_000 * 3 * 5_000);
    expect(Number.isSafeInteger(total)).toBe(true);
  });

  /**
   * `usage` arrives from the Anthropic SDK — external data, exactly like the
   * Drizzle rows the policy engine learned not to trust (FAILURES entry 13).
   * A NaN token count must not silently produce a NaN cost that then poisons
   * every SUM over the column.
   */
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s token count rather than costing it", (_label, value) => {
    expect(() =>
      costOf(ANTHROPIC_RATES["claude-haiku-4-5"], usage({ inputTokens: value })),
    ).toThrow();
  });

  /**
   * Pricing moved to the provider, so the failure this guards changed shape:
   * not "unknown model" but "no rate card reached me". A run must never be
   * silently free because a lookup returned undefined.
   */
  it("rejects a missing rate card rather than costing a run at zero", () => {
    expect(() =>
      costOf(undefined as unknown as RateCard, usage({ inputTokens: 1 })),
    ).toThrow(/rate card/i);
  });
});

/**
 * `cost_usd` is `numeric(12,6)`, so nanos have to become micros at the storage
 * boundary. Rounding is stated and tested rather than left to whatever
 * `toFixed` does, because it runs on every span.
 */
describe("nanosToMicros", () => {
  it.each([
    [0, 0],
    [1_000, 1],
    [1_499, 1],
    [1_500, 2], // half rounds up
    [2_500, 3],
    [999, 1], // sub-micro cost is not silently dropped
    [1, 1],
  ])("rounds %i nanos to %i micros, half-up", (nanos, micros) => {
    expect(nanosToMicros(nanos)).toBe(micros);
  });

  /**
   * A real Haiku run: ~4k input, ~800 output. Pinned end to end so the number
   * a reader sees in the trace viewer is reproducible from the rates.
   */
  it("prices a realistic Haiku run to a stable micro figure", () => {
    const c = costOf(ANTHROPIC_RATES["claude-haiku-4-5"],
      usage({ inputTokens: 4_000, outputTokens: 800 }),
    );

    // 4000 * 1000 + 800 * 5000 = 8_000_000 nanos = $0.008
    expect(c.totalNanos).toBe(8_000_000);
    expect(nanosToMicros(c.totalNanos)).toBe(8_000);
  });
});
