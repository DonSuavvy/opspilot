import { describe, expect, it } from "vitest";

import { evalCaseSchema, EXPECTATION_KEYS } from "./case";
import { GOLDEN_CASES } from "./cases";

/**
 * The golden suite is a *fixture*, so what is worth testing about it is not
 * what the model does with it — that is the eval run's job — but that the
 * fixture itself is well formed before it costs money to discover otherwise.
 *
 * Three failure modes are worth eight lines each. A case whose slug drifts
 * breaks the diff view, which matches runs on slug. A case with no
 * expectations passes vacuously and reads as green forever. And a typo'd
 * expectation key would do the same silently, which is why the schema is
 * closed rather than permissive.
 */

/** The eight scenarios PLAN.md's demo arc and Day 6 gate are written against. */
const REQUIRED_SLUGS = [
  "refund-in-window",
  "refund-flip-22-days",
  "refund-out-of-window",
  "duplicate-charge",
  "churn-risk",
  "kb-how-to",
  "missing-info",
  "prompt-injection",
];

describe("evalCaseSchema", () => {
  it("parses every golden case", () => {
    for (const c of GOLDEN_CASES) {
      expect(evalCaseSchema.safeParse(c).success, c.slug).toBe(true);
    }
  });

  it("defaults `enabled` to true, so a case has to be switched off deliberately", () => {
    const parsed = evalCaseSchema.parse({
      slug: "minimal",
      title: "Minimal",
      description: "",
      ticket: { customer: null, subject: "s", body: "b" },
      expect: { status: "completed" },
      tags: [],
    });

    expect(parsed.enabled).toBe(true);
  });

  it("rejects a case whose slug is not kebab-case", () => {
    const result = evalCaseSchema.safeParse({
      slug: "Refund In Window",
      title: "Bad",
      description: "",
      ticket: { customer: null, subject: "s", body: "b" },
      expect: { status: "completed" },
      tags: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an expectation key it does not know, rather than ignoring it", () => {
    // A typo here would otherwise assert nothing and report green forever.
    const result = evalCaseSchema.safeParse({
      slug: "typo",
      title: "Typo",
      description: "",
      ticket: { customer: null, subject: "s", body: "b" },
      expect: { toolsCaled: ["search_kb"] },
      tags: [],
    });

    expect(result.success).toBe(false);
  });

  it("accepts either shape of refundCents", () => {
    expect(
      evalCaseSchema.safeParse({
        slug: "ceiling",
        title: "Ceiling",
        description: "",
        ticket: { customer: null, subject: "s", body: "b" },
        expect: { refundCents: { max: 4_900 } },
        tags: [],
      }).success,
    ).toBe(true);
  });
});

describe("GOLDEN_CASES", () => {
  it("covers the eight demo-arc scenarios", () => {
    expect(GOLDEN_CASES.map((c) => c.slug).sort()).toEqual(
      [...REQUIRED_SLUGS].sort(),
    );
  });

  it("has unique slugs", () => {
    const slugs = GOLDEN_CASES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("names at least one expectation per case", () => {
    for (const c of GOLDEN_CASES) {
      const named = Object.keys(c.expect).filter((k) =>
        (EXPECTATION_KEYS as readonly string[]).includes(k),
      );
      expect(named.length, `${c.slug} asserts nothing`).toBeGreaterThan(0);
    }
  });

  it("gives every disabled case a description saying why", () => {
    for (const c of GOLDEN_CASES) {
      if (c.enabled) continue;
      expect(c.description.length, `${c.slug} is off with no reason`).toBeGreaterThan(
        0,
      );
    }
  });
});
