import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  evaluateEscalation,
  evaluateRefund,
  parsePolicyConfig,
  policyConfigSchema,
  type PolicyConfig,
  type RefundEvaluationInput,
} from "./refund";

/**
 * A fixed clock. The engine must never read the wall clock itself — every
 * time-dependent rule takes `now` as an argument, which is what makes the
 * refund-window tests deterministic and the eval suite reproducible.
 */
const NOW = new Date("2026-08-11T12:00:00.000Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function input(overrides: {
  invoice?: Partial<RefundEvaluationInput["invoice"]>;
  requestedCents?: number;
  reason?: RefundEvaluationInput["reason"];
  policy?: Partial<PolicyConfig>;
}): RefundEvaluationInput {
  return {
    invoice: {
      id: "inv_1",
      status: "paid",
      amountCents: 4900,
      refundedCents: 0,
      paidAt: daysAgo(5),
      ...overrides.invoice,
    },
    requestedCents: overrides.requestedCents ?? 4900,
    reason: overrides.reason ?? "service_issue",
    now: NOW,
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
  };
}

describe("evaluateRefund", () => {
  it("approves a full refund inside the window and under the auto-approve cap", () => {
    const decision = evaluateRefund(input({}));

    expect(decision.outcome).toBe("approve");
    expect(decision.approvedCents).toBe(4900);
    expect(decision.violations).toEqual([]);
  });

  it("is a pure function of its arguments — never reads the wall clock", () => {
    // Same input evaluated twice must be identical, and an invoice paid
    // "5 days before NOW" must not drift as real time passes.
    const a = evaluateRefund(input({}));
    const b = evaluateRefund(input({}));
    expect(a).toEqual(b);
  });

  describe("refund window", () => {
    it("denies a refund past the window", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: daysAgo(45) } }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("outside_refund_window");
    });

    it("treats the window boundary as inclusive", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: daysAgo(30) } }),
      );
      expect(decision.outcome).toBe("approve");
    });

    it("denies one day past the boundary", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: daysAgo(31) } }),
      );
      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("outside_refund_window");
    });

    /**
     * This is demo arc step 2. The same ticket, re-run after the SOP edit,
     * must flip from approve to deny purely because the policy changed.
     * If this test ever stops flipping, the headline demo is broken.
     */
    it("flips a 22-day-old invoice from approve to deny when the window narrows 30 -> 14", () => {
      const invoice = { paidAt: daysAgo(22) };

      const under30 = evaluateRefund(
        input({ invoice, policy: { refund: { ...DEFAULT_POLICY.refund, windowDays: 30 } } }),
      );
      const under14 = evaluateRefund(
        input({ invoice, policy: { refund: { ...DEFAULT_POLICY.refund, windowDays: 14 } } }),
      );

      expect(under30.outcome).toBe("approve");
      expect(under14.outcome).toBe("deny");
      expect(under14.violations).toContain("outside_refund_window");
    });

    it("refunds a duplicate charge even outside the window", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: daysAgo(90) }, reason: "duplicate_charge" }),
      );

      expect(decision.outcome).toBe("approve");
      expect(decision.violations).toEqual([]);
    });

    it("still honours the window for duplicate charges when the bypass is disabled", () => {
      const decision = evaluateRefund(
        input({
          invoice: { paidAt: daysAgo(90) },
          reason: "duplicate_charge",
          policy: {
            refund: {
              ...DEFAULT_POLICY.refund,
              duplicateChargeBypassesWindow: false,
            },
          },
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("outside_refund_window");
    });
  });

  describe("amount limits", () => {
    it("requires human approval above the auto-approve threshold", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: 29900 },
          requestedCents: 29900,
          policy: {
            refund: { ...DEFAULT_POLICY.refund, maxAutoApproveCents: 10000 },
          },
        }),
      );

      expect(decision.outcome).toBe("requires_approval");
      expect(decision.approvedCents).toBe(29900);
      expect(decision.violations).toContain("exceeds_auto_approve_threshold");
    });

    it("denies above the hard ceiling rather than escalating", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: 500000 },
          requestedCents: 500000,
          policy: {
            refund: { ...DEFAULT_POLICY.refund, maxRefundCents: 50000 },
          },
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("exceeds_max_refund");
    });

    it("denies a refund larger than the unrefunded balance", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: 4900, refundedCents: 3000 },
          requestedCents: 4900,
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("amount_exceeds_invoice_balance");
    });

    it("approves a partial refund within the remaining balance", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: 4900, refundedCents: 3000 },
          requestedCents: 1900,
        }),
      );

      expect(decision.outcome).toBe("approve");
      expect(decision.approvedCents).toBe(1900);
    });

    it.each([0, -1, -4900])("denies a non-positive amount (%i)", (cents) => {
      const decision = evaluateRefund(input({ requestedCents: cents }));

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("non_positive_amount");
    });

    it("rejects a non-integer amount rather than silently rounding money", () => {
      const decision = evaluateRefund(input({ requestedCents: 49.5 }));

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("non_integer_amount");
    });
  });

  describe("invoice state", () => {
    it.each(["open", "void", "draft"] as const)(
      "denies a refund against a %s invoice",
      (status) => {
        const decision = evaluateRefund(
          input({ invoice: { status, paidAt: null } }),
        );

        expect(decision.outcome).toBe("deny");
        expect(decision.violations).toContain("invoice_not_paid");
      },
    );

    it("denies when the invoice is already fully refunded", () => {
      const decision = evaluateRefund(
        input({
          invoice: {
            status: "refunded",
            amountCents: 4900,
            refundedCents: 4900,
          },
          requestedCents: 100,
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invoice_already_refunded");
    });

    it("allows a further refund against a partially refunded invoice", () => {
      const decision = evaluateRefund(
        input({
          invoice: {
            status: "partially_refunded",
            amountCents: 4900,
            refundedCents: 1000,
          },
          requestedCents: 500,
        }),
      );

      expect(decision.outcome).toBe("approve");
    });

    it("denies when a paid invoice has no paidAt timestamp", () => {
      const decision = evaluateRefund(
        input({ invoice: { status: "paid", paidAt: null } }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invoice_not_paid");
    });
  });

  it("reports every applicable violation, not just the first", () => {
    const decision = evaluateRefund(
      input({
        invoice: { paidAt: daysAgo(90), amountCents: 999999 },
        requestedCents: 999999,
        policy: { refund: { ...DEFAULT_POLICY.refund, maxRefundCents: 50000 } },
      }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.violations).toContain("outside_refund_window");
    expect(decision.violations).toContain("exceeds_max_refund");
  });
});

describe("evaluateEscalation", () => {
  it("does not escalate an ordinary resolved ticket", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 10000,
      refundOutcome: "approve",
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("escalates a suspected prompt injection", () => {
    const decision = evaluateEscalation({
      suspectedInjection: true,
      customerFound: true,
      customerLifetimeValueCents: 10000,
      refundOutcome: null,
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toContain("suspected_injection");
  });

  it("escalates when the customer cannot be identified", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: false,
      customerLifetimeValueCents: 0,
      refundOutcome: null,
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toContain("unknown_customer");
  });

  it("escalates a high-value customer whose refund was denied", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 500000,
      refundOutcome: "deny",
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toContain("churn_risk");
  });

  /**
   * Regression. A churn risk is a *dissatisfied* high-value customer. A
   * refundOutcome of null means no refund was even requested — a big customer
   * asking a how-to question is not a churn risk, and escalating them would
   * inflate the escalation rate, which is a headline Mission Control KPI.
   */
  it("does not treat a high-value customer with no refund request as a churn risk", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 500000,
      refundOutcome: null,
      policy: DEFAULT_POLICY,
    });

    expect(decision.reasons).not.toContain("churn_risk");
    expect(decision.escalate).toBe(false);
  });

  it("does not treat a pending-approval refund as churn on its own", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 500000,
      refundOutcome: "requires_approval",
      policy: DEFAULT_POLICY,
    });

    expect(decision.reasons).not.toContain("churn_risk");
  });

  /**
   * Dissatisfaction that isn't a refund denial — the seeded churn fixture is a
   * past_due Scale customer threatening to leave, with no refund requested at
   * all. The model reads that from the ticket; the policy engine takes it as
   * an input rather than trying to infer it.
   */
  it("escalates a dissatisfied high-value customer even with no refund involved", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 500000,
      refundOutcome: null,
      customerDissatisfied: true,
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toContain("churn_risk");
  });

  it("does not treat a dissatisfied low-value customer as a churn risk", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 1000,
      refundOutcome: null,
      customerDissatisfied: true,
      policy: DEFAULT_POLICY,
    });

    expect(decision.reasons).not.toContain("churn_risk");
  });

  it("escalates whenever the policy engine denied a refund", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 100,
      refundOutcome: "deny",
      policy: DEFAULT_POLICY,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toContain("refund_denied_by_policy");
  });

  /**
   * The four escalation toggles are configuration, and configuration that is
   * never exercised is indistinguishable from configuration that is ignored.
   */
  it("honours escalateOnUnknownCustomer: false", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: false,
      customerLifetimeValueCents: 0,
      refundOutcome: null,
      policy: {
        ...DEFAULT_POLICY,
        escalation: {
          ...DEFAULT_POLICY.escalation,
          escalateOnUnknownCustomer: false,
        },
      },
    });

    expect(decision.reasons).not.toContain("unknown_customer");
  });

  it("honours escalateOnPolicyDenial: false", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 100,
      refundOutcome: "deny",
      policy: {
        ...DEFAULT_POLICY,
        escalation: {
          ...DEFAULT_POLICY.escalation,
          escalateOnPolicyDenial: false,
        },
      },
    });

    expect(decision.reasons).not.toContain("refund_denied_by_policy");
  });

  it("honours escalateOnSuspectedInjection: false", () => {
    const decision = evaluateEscalation({
      suspectedInjection: true,
      customerFound: true,
      customerLifetimeValueCents: 100,
      refundOutcome: null,
      policy: {
        ...DEFAULT_POLICY,
        escalation: {
          ...DEFAULT_POLICY.escalation,
          escalateOnSuspectedInjection: false,
        },
      },
    });

    expect(decision.reasons).not.toContain("suspected_injection");
  });

  it("treats the churn LTV threshold as inclusive", () => {
    const at = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: DEFAULT_POLICY.escalation.churnRiskLtvCents,
      refundOutcome: null,
      customerDissatisfied: true,
      policy: DEFAULT_POLICY,
    });
    const below = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents:
        DEFAULT_POLICY.escalation.churnRiskLtvCents - 1,
      refundOutcome: null,
      customerDissatisfied: true,
      policy: DEFAULT_POLICY,
    });

    expect(at.reasons).toContain("churn_risk");
    expect(below.reasons).not.toContain("churn_risk");
  });

  it("does not treat an unknown customer as a churn risk", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: false,
      customerLifetimeValueCents: 500000,
      refundOutcome: "deny",
      policy: DEFAULT_POLICY,
    });

    expect(decision.reasons).not.toContain("churn_risk");
  });

  /**
   * `customerDissatisfied` is set by the model from ticket tone. A model that
   * emits the string "false" must not be read as dissatisfied — the strict
   * `=== true` is what prevents that, and only a truthy non-boolean pins it.
   */
  it("requires a real boolean for customerDissatisfied, not a truthy value", () => {
    const decision = evaluateEscalation({
      suspectedInjection: false,
      customerFound: true,
      customerLifetimeValueCents: 500000,
      refundOutcome: null,
      customerDissatisfied: "false" as never,
      policy: DEFAULT_POLICY,
    });

    expect(decision.reasons).not.toContain("churn_risk");
  });
});

describe("evaluateRefund — boundaries the engine's own comments promise", () => {
  /**
   * `ageDays > windowDays` bounds one side only. A future-dated paidAt yields a
   * negative age, which is trivially "inside" every window — so a clock-skewed
   * or mis-mapped column silently buys an unlimited refund window.
   */
  it("does not treat a future-dated payment as inside the window", () => {
    const decision = evaluateRefund(
      input({ invoice: { paidAt: daysAgo(-400) } }),
    );

    expect(decision.outcome).toBe("deny");
  });

  /**
   * `settled` tests `paidAt !== null` while `ageDays` tests truthiness. They
   * disagree on `undefined`, which a Drizzle row or a JSON round-trip can
   * produce: settled passes, the window check is skipped, and an invoice with
   * no payment date at all is approved.
   */
  it("treats an undefined paidAt exactly like null", () => {
    const undef = evaluateRefund(
      input({ invoice: { paidAt: undefined as never } }),
    );
    const nul = evaluateRefund(input({ invoice: { paidAt: null } }));

    expect(undef.outcome).toBe("deny");
    expect(undef.violations).toContain("invoice_not_paid");
    expect(undef).toEqual(nul);
  });

  /** "Money is never a float" — above 2^53 integers stop behaving like integers. */
  it("rejects an amount above the safe-integer range", () => {
    const decision = evaluateRefund(
      input({
        requestedCents: 1e21,
        invoice: { amountCents: Number.MAX_SAFE_INTEGER },
        policy: {
          refund: {
            ...DEFAULT_POLICY.refund,
            maxRefundCents: Number.MAX_SAFE_INTEGER,
            maxAutoApproveCents: Number.MAX_SAFE_INTEGER,
          },
        },
      }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.violations).toContain("non_integer_amount");
  });

  /** The SOP quotes these to customers, so the exact cents are user-visible. */
  it.each([
    [10_000, "approve"],
    [10_001, "requires_approval"],
    [50_000, "requires_approval"],
    [50_001, "deny"],
  ])("pins the money thresholds: %i cents -> %s", (cents, outcome) => {
    const decision = evaluateRefund(
      input({ requestedCents: cents, invoice: { amountCents: 1_000_000 } }),
    );

    expect(decision.outcome).toBe(outcome);
  });

  /** ":169 — an amount over the hard cap must not ALSO read as merely needing approval." */
  it("denies over the ceiling without also reporting the approval threshold", () => {
    const decision = evaluateRefund(
      input({ requestedCents: 60_000, invoice: { amountCents: 1_000_000 } }),
    );

    expect(decision.violations).toContain("exceeds_max_refund");
    expect(decision.violations).not.toContain("exceeds_auto_approve_threshold");
  });

  /** ":112 — Zero on denial; the requested amount otherwise." */
  it.each([
    ["non-positive", { requestedCents: -1 }],
    ["non-integer", { requestedCents: 49.5 }],
    ["outside window", { invoice: { paidAt: daysAgo(90) } }],
    ["over the ceiling", { requestedCents: 60_000 }],
  ])("approves zero cents on the %s denial path", (_label, overrides) => {
    const decision = evaluateRefund(input(overrides as never));

    expect(decision.outcome).toBe("deny");
    expect(decision.approvedCents).toBe(0);
  });
});

/**
 * `policy` arrives from `sop_versions.policy_config`, a jsonb blob the Day-4 SOP
 * editor writes. It is typed but never validated, and every rule is a `>`
 * comparison — and `x > undefined` is `false`. A missing or misspelled key
 * therefore does not error: it silently deletes that limit. This is the code
 * half of "never trust the model" failing open.
 */
describe("parsePolicyConfig", () => {
  it("accepts the default policy unchanged", () => {
    expect(parsePolicyConfig(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });

  it("accepts a policy that arrived as JSON", () => {
    const roundTripped = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as unknown;
    expect(parsePolicyConfig(roundTripped)).toEqual(DEFAULT_POLICY);
  });

  it.each([
    ["refund block empty", { refund: {}, escalation: DEFAULT_POLICY.escalation }],
    ["refund block missing", { escalation: DEFAULT_POLICY.escalation }],
    ["escalation block missing", { refund: DEFAULT_POLICY.refund }],
    ["null", null],
    ["a string", "windowDays: 30"],
  ])("rejects a malformed policy (%s)", (_label, raw) => {
    expect(() => parsePolicyConfig(raw)).toThrow();
  });

  it("rejects a misspelled key rather than silently dropping the limit", () => {
    const typo = {
      refund: { ...DEFAULT_POLICY.refund, maxRefundCent: 50_000 },
      escalation: DEFAULT_POLICY.escalation,
    };
    delete (typo.refund as Record<string, unknown>).maxRefundCents;

    expect(() => parsePolicyConfig(typo)).toThrow();
  });

  it.each([
    ["non-integer cents", { maxRefundCents: 50_000.5 }],
    ["negative window", { windowDays: -1 }],
    ["NaN limit", { maxAutoApproveCents: Number.NaN }],
    ["non-boolean bypass", { duplicateChargeBypassesWindow: "yes" }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      parsePolicyConfig({
        refund: { ...DEFAULT_POLICY.refund, ...patch },
        escalation: DEFAULT_POLICY.escalation,
      }),
    ).toThrow();
  });

  /** A ceiling below the auto-approve threshold makes the threshold unreachable. */
  it("rejects an auto-approve threshold above the hard ceiling", () => {
    expect(() =>
      parsePolicyConfig({
        refund: {
          ...DEFAULT_POLICY.refund,
          maxAutoApproveCents: 60_000,
          maxRefundCents: 50_000,
        },
        escalation: DEFAULT_POLICY.escalation,
      }),
    ).toThrow();
  });
});

/**
 * A validator nothing is obliged to call is documentation, not enforcement —
 * the exact "guarantee claimed but not enforced in code" pattern this engine
 * exists to prevent. The refund limit is stated in the SOP *and* revalidated
 * here; the policy the revalidation reads gets the same treatment, at the
 * boundary when an SOP version is written and again at the point of decision.
 * Refusing to decide is the only safe answer to an unreadable policy.
 */
describe("the engine refuses to run on an unparseable policy", () => {
  const malformed = [
    ["refund block empty", { refund: {}, escalation: DEFAULT_POLICY.escalation }],
    ["refund block missing", { escalation: DEFAULT_POLICY.escalation }],
    ["ceiling misspelled", {
      refund: {
        windowDays: 30,
        maxAutoApproveCents: 10_000,
        maxRefundCent: 50_000,
        duplicateChargeBypassesWindow: true,
      },
      escalation: DEFAULT_POLICY.escalation,
    }],
  ] as const;

  it.each(malformed)(
    "evaluateRefund throws rather than approving (%s)",
    (_label, policy) => {
      // Built directly rather than via input(), whose shallow merge with
      // DEFAULT_POLICY would put back the very block under test.
      expect(() =>
        evaluateRefund({
          invoice: {
            id: "inv_1",
            status: "paid",
            amountCents: 4900,
            refundedCents: 0,
            paidAt: daysAgo(5),
          },
          requestedCents: 4900,
          reason: "service_issue",
          now: NOW,
          policy: policy as never,
        }),
      ).toThrow();
    },
  );

  it.each(malformed)(
    "evaluateEscalation throws rather than under-escalating (%s)",
    (_label, policy) => {
      expect(() =>
        evaluateEscalation({
          suspectedInjection: true,
          customerFound: true,
          customerLifetimeValueCents: 500_000,
          refundOutcome: "deny",
          policy: policy as never,
        }),
      ).toThrow();
    },
  );

  it("still evaluates a well-formed policy normally", () => {
    expect(evaluateRefund(input({})).outcome).toBe("approve");
  });
});

/**
 * `.strict()` guarantees exactly one thing: an otherwise-complete, valid policy
 * carrying an *extra* key is rejected instead of silently ignored. A
 * *misspelled* key is caught by the required-key check with or without it —
 * verified against Zod 4.4.3, where `maxRefundCent` (no trailing s) is rejected
 * either way as `invalid_type` on the absent `maxRefundCents`.
 *
 * That distinction is why these tests assert the extra-key case and the issue
 * path. A test written against the misspelling story passes with `.strict()`
 * removed, which is how all three of these calls survived a mutation run: 14
 * reversions, 11 killed, and the three survivors were precisely these.
 *
 * The path pins *which* level did the rejecting, so the outer test cannot pass
 * on an inner rejection if the schema is ever restructured.
 */
describe("policyConfigSchema rejects keys it does not recognise", () => {
  function unrecognizedKeyPaths(raw: unknown): PropertyKey[][] {
    const result = policyConfigSchema.safeParse(raw);
    if (result.success) return [];
    return result.error.issues
      .filter((issue) => issue.code === "unrecognized_keys")
      .map((issue) => [...issue.path]);
  }

  /**
   * The realistic failure: the Day-4 SOP editor writes a limit this engine
   * does not implement. Ignoring it silently would leave the operator believing
   * a floor is enforced that no line of code reads.
   */
  it("rejects an unknown key inside the refund block", () => {
    const raw = {
      refund: { ...DEFAULT_POLICY.refund, minRefundCents: 500 },
      escalation: DEFAULT_POLICY.escalation,
    };

    expect(unrecognizedKeyPaths(raw)).toEqual([["refund"]]);
    expect(() => parsePolicyConfig(raw)).toThrow();
  });

  it("rejects an unknown key inside the escalation block", () => {
    const raw = {
      refund: DEFAULT_POLICY.refund,
      escalation: {
        ...DEFAULT_POLICY.escalation,
        escalateOnRefundRequest: true,
      },
    };

    expect(unrecognizedKeyPaths(raw)).toEqual([["escalation"]]);
    expect(() => parsePolicyConfig(raw)).toThrow();
  });

  it("rejects an unknown key at the top level", () => {
    const raw = { ...DEFAULT_POLICY, subscription: { maxDowngrades: 1 } };

    expect(unrecognizedKeyPaths(raw)).toEqual([[]]);
    expect(() => parsePolicyConfig(raw)).toThrow();
  });
});

/**
 * `RefundEvaluationInput` is a TypeScript interface over values that arrive at
 * runtime — from Drizzle rows, from a JSON round trip, and from Day 2 onward
 * from model-proposed tool arguments. The interface is erased at build time and
 * guarantees nothing about any of them.
 *
 * Every rule below a bad field is a `>` comparison, and every comparison
 * against `NaN` is `false`. So a single poisoned number does not throw and does
 * not deny: it silently deletes the rules that depended on it. The reproduction
 * this suite was written against had `paidAt = new Date(undefined)` and
 * `amountCents = NaN` each auto-approving with *zero* violations.
 *
 * The split is deliberate. `now` is supplied by the calling code, never by the
 * model or the database, so an invalid clock is a programmer bug and throws.
 * `invoice.*` is external data, so a bad field is a violation — the engine's
 * job is exhaustive violations the trace viewer can render, and a ZodError
 * shows the reader nothing.
 */
describe("evaluateRefund — the evaluation input is data, not a type", () => {
  /** Exactly the reviewer's reproduction: an Invalid Date is still a Date. */
  const INVALID_DATE = new Date(undefined as never);

  /**
   * Matched against the deliberate message, not merely `/now/`. A bare
   * `now.getTime is not a function` also contains "now", so the looser regex
   * let a non-Date pass this test with the guard deleted — the assertion has
   * to distinguish a designed refusal from an incidental crash.
   */
  describe("`now` is the caller's responsibility, so it throws", () => {
    const DELIBERATE = /must be a valid Date/;

    it("throws on an Invalid Date rather than deleting every time-based rule", () => {
      expect(() => evaluateRefund({ ...input({}), now: INVALID_DATE })).toThrow(
        DELIBERATE,
      );
    });

    it("throws when `now` is not a Date at all", () => {
      expect(() =>
        evaluateRefund({ ...input({}), now: NOW.getTime() as never }),
      ).toThrow(DELIBERATE);
    });
  });

  describe("`invoice` is external data, so it becomes a violation", () => {
    it("flags an Invalid Date paidAt instead of approving it", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: INVALID_DATE } }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.approvedCents).toBe(0);
      expect(decision.violations).toContain("invalid_invoice_data");
      // Never NaN: the decision is consumed by the trace viewer and the scorers.
      expect(decision.ageDays).toBeNull();
    });

    /**
     * What a real JSON round trip produces from a `Date`. Deserialization is
     * the job of the boundary that serialized it; this engine's contract is
     * `Date | null` and it reports anything else rather than guessing.
     */
    it("flags an ISO-string paidAt instead of throwing a raw TypeError", () => {
      const decision = evaluateRefund(
        input({ invoice: { paidAt: NOW.toISOString() as never } }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invalid_invoice_data");
      expect(decision.ageDays).toBeNull();
    });

    /**
     * The one combination where the old code had *two* independent reasons to
     * skip the window check: the duplicate-charge bypass waives it outright,
     * and a NaN age would have skipped it anyway.
     */
    it("denies a duplicate charge with an unusable paidAt even though the window is waived", () => {
      const decision = evaluateRefund(
        input({
          invoice: { paidAt: INVALID_DATE },
          reason: "duplicate_charge",
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invalid_invoice_data");
    });

    it("flags a NaN amountCents instead of deleting both balance rules", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: Number.NaN },
          requestedCents: 3000,
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.approvedCents).toBe(0);
      expect(decision.violations).toContain("invalid_invoice_data");
    });

    /** A partial Drizzle select omits the column entirely. */
    it("flags an undefined refundedCents instead of approving", () => {
      const decision = evaluateRefund(
        input({
          invoice: { amountCents: 2000, refundedCents: undefined as never },
          requestedCents: 3000,
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invalid_invoice_data");
    });

    it("flags a NaN refundedCents on a fully refunded invoice", () => {
      const decision = evaluateRefund(
        input({
          invoice: {
            status: "refunded",
            amountCents: 2000,
            refundedCents: Number.NaN,
          },
          requestedCents: 3000,
        }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invalid_invoice_data");
    });

    /**
     * A negative amount is the case that proves the balance rules must be
     * *skipped* rather than merely left to fail: `-4900 - 0 <= 0` is true, so
     * running them on bad data invents a second, false reason — the invoice
     * reads as "already refunded" when nothing was ever refunded.
     */
    it("flags a negative amountCents without inventing a refund that never happened", () => {
      const decision = evaluateRefund(
        input({ invoice: { amountCents: -4900 }, requestedCents: 100 }),
      );

      expect(decision.violations).toContain("invalid_invoice_data");
      expect(decision.violations).not.toContain("invoice_already_refunded");
    });

    it("flags a fractional amountCents — money is never a float", () => {
      const decision = evaluateRefund(
        input({ invoice: { amountCents: 4900.5 }, requestedCents: 100 }),
      );

      expect(decision.violations).toContain("invalid_invoice_data");
    });

    /**
     * From Day 2 the status can arrive from a model-proposed tool argument.
     * An unrecognised one already failed closed via SETTLED; naming it makes
     * the trace say *why* rather than claiming the invoice was never paid.
     */
    it("flags an unrecognised invoice status", () => {
      const decision = evaluateRefund(
        input({ invoice: { status: "PAID" as never } }),
      );

      expect(decision.outcome).toBe("deny");
      expect(decision.violations).toContain("invalid_invoice_data");
    });

    it.each(["open", "void", "draft"] as const)(
      "does not flag the valid %s status as bad data",
      (status) => {
        const decision = evaluateRefund(
          input({ invoice: { status, paidAt: null } }),
        );

        expect(decision.violations).not.toContain("invalid_invoice_data");
        expect(decision.violations).toContain("invoice_not_paid");
      },
    );
  });

  it("reports invalid_invoice_data exactly once however many fields are bad", () => {
    const decision = evaluateRefund(
      input({
        invoice: {
          status: "nonsense" as never,
          amountCents: Number.NaN,
          refundedCents: undefined as never,
          paidAt: INVALID_DATE,
        },
      }),
    );

    expect(
      decision.violations.filter((v) => v === "invalid_invoice_data"),
    ).toHaveLength(1);
  });

  /**
   * Exhaustive violations, property 3 of the file header: a poisoned field
   * suppresses only the rules that read it. The window check does not read
   * `amountCents`, so it must still fire.
   */
  it("still reports the rules that do not depend on the bad field", () => {
    const decision = evaluateRefund(
      input({
        invoice: { amountCents: Number.NaN, paidAt: daysAgo(90) },
        requestedCents: 3000,
      }),
    );

    expect(decision.violations).toContain("invalid_invoice_data");
    expect(decision.violations).toContain("outside_refund_window");
    // The balance rules read amountCents, so they must not fire on garbage.
    expect(decision.violations).not.toContain("amount_exceeds_invoice_balance");
    expect(decision.violations).not.toContain("invoice_already_refunded");
  });
});
