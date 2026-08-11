import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  evaluateEscalation,
  evaluateRefund,
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
});
