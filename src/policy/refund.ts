/**
 * The policy engine: the code-level half of OpsPilot's defense in depth.
 *
 * The refund policy is stated twice on purpose. Once in the SOP markdown, so
 * the model knows it and can explain it to a customer; and once here, so the
 * `issue_refund` tool handler can revalidate whatever the model proposed and
 * reject it with `is_error: true` when it is out of policy. Never trust the
 * model. This module is what makes that claim true.
 *
 * Three properties this file must keep:
 *
 * 1. **Pure.** No database access, no `Date.now()`, no I/O. `now` is an
 *    argument. This is what lets the eval suite be deterministic even though
 *    temperature is not available on Sonnet/Opus 5 — determinism lives in the
 *    scorers and the policy, not in sampling.
 * 2. **Integer cents.** Money is never a float.
 * 3. **Exhaustive violations.** Every applicable rule is reported, not just
 *    the first one that fires, so the trace viewer can show the full reason
 *    a refund was refused.
 */

export type InvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "void";

export type RefundReason =
  | "duplicate_charge"
  | "service_issue"
  | "cancellation"
  | "billing_error"
  | "other";

export type RefundOutcome = "approve" | "requires_approval" | "deny";

export type RefundViolation =
  | "non_integer_amount"
  | "non_positive_amount"
  | "invoice_not_paid"
  | "invoice_already_refunded"
  | "amount_exceeds_invoice_balance"
  | "outside_refund_window"
  | "exceeds_max_refund"
  | "exceeds_auto_approve_threshold";

export type EscalationReason =
  | "suspected_injection"
  | "unknown_customer"
  | "churn_risk"
  | "refund_denied_by_policy";

/**
 * The machine-readable policy. Persisted as `sop_versions.policy_config`
 * alongside the human-readable markdown, in the same versioned row, so an SOP
 * edit updates what the model reads and what the code enforces atomically.
 */
export interface PolicyConfig {
  refund: {
    /** Days after `paidAt` during which a refund is in policy. Inclusive. */
    windowDays: number;
    /** At or below this, the agent may refund without a human. */
    maxAutoApproveCents: number;
    /** Hard ceiling. Above this the request is denied, not escalated. */
    maxRefundCents: number;
    /** Duplicate charges are a billing error we caused, so the clock shouldn't apply. */
    duplicateChargeBypassesWindow: boolean;
  };
  escalation: {
    /** Lifetime value at or above which a dissatisfied customer is a churn risk. */
    churnRiskLtvCents: number;
    escalateOnSuspectedInjection: boolean;
    escalateOnUnknownCustomer: boolean;
    escalateOnPolicyDenial: boolean;
  };
}

export const DEFAULT_POLICY: PolicyConfig = {
  refund: {
    windowDays: 30,
    maxAutoApproveCents: 10_000, // $100
    maxRefundCents: 50_000, // $500
    duplicateChargeBypassesWindow: true,
  },
  escalation: {
    churnRiskLtvCents: 250_000, // $2,500
    escalateOnSuspectedInjection: true,
    escalateOnUnknownCustomer: true,
    escalateOnPolicyDenial: true,
  },
};

export interface RefundEvaluationInput {
  invoice: {
    id: string;
    status: InvoiceStatus;
    amountCents: number;
    refundedCents: number;
    paidAt: Date | null;
  };
  requestedCents: number;
  reason: RefundReason;
  /** Injected, never read from the wall clock. See the file header. */
  now: Date;
  policy: PolicyConfig;
}

export interface RefundDecision {
  outcome: RefundOutcome;
  /** Zero on denial; the requested amount otherwise. */
  approvedCents: number;
  violations: RefundViolation[];
  /** Days elapsed since payment, or null when the invoice was never paid. */
  ageDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Statuses that mean money actually changed hands. */
const SETTLED: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  "paid",
  "partially_refunded",
  "refunded",
]);

/**
 * The only violation that escalates rather than denies. Everything else is a
 * hard no — that asymmetry is the whole point of the auto-approve threshold.
 */
const ESCALATING_VIOLATION: RefundViolation = "exceeds_auto_approve_threshold";

export function evaluateRefund(input: RefundEvaluationInput): RefundDecision {
  const { invoice, requestedCents, reason, now, policy } = input;
  const rules = policy.refund;
  const violations: RefundViolation[] = [];

  if (!Number.isInteger(requestedCents)) {
    violations.push("non_integer_amount");
  }
  if (requestedCents <= 0) {
    violations.push("non_positive_amount");
  }

  const settled = SETTLED.has(invoice.status) && invoice.paidAt !== null;
  if (!settled) {
    violations.push("invoice_not_paid");
  }

  const balanceCents = invoice.amountCents - invoice.refundedCents;
  if (balanceCents <= 0) {
    violations.push("invoice_already_refunded");
  } else if (requestedCents > balanceCents) {
    violations.push("amount_exceeds_invoice_balance");
  }

  const ageDays = invoice.paidAt
    ? (now.getTime() - invoice.paidAt.getTime()) / MS_PER_DAY
    : null;

  const windowWaived =
    reason === "duplicate_charge" && rules.duplicateChargeBypassesWindow;

  if (!windowWaived && ageDays !== null && ageDays > rules.windowDays) {
    violations.push("outside_refund_window");
  }

  // Ceiling before threshold: an amount over the hard cap is denied outright
  // and must not also be reported as merely needing approval.
  if (requestedCents > rules.maxRefundCents) {
    violations.push("exceeds_max_refund");
  } else if (requestedCents > rules.maxAutoApproveCents) {
    violations.push(ESCALATING_VIOLATION);
  }

  const denying = violations.filter((v) => v !== ESCALATING_VIOLATION);
  const outcome: RefundOutcome =
    denying.length > 0
      ? "deny"
      : violations.length > 0
        ? "requires_approval"
        : "approve";

  return {
    outcome,
    approvedCents: outcome === "deny" ? 0 : requestedCents,
    violations,
    ageDays,
  };
}

export interface EscalationEvaluationInput {
  /** Set by the heuristic pre-scan before the ticket body reaches the model. */
  suspectedInjection: boolean;
  customerFound: boolean;
  customerLifetimeValueCents: number;
  /** The refund decision for this ticket, or null when none was requested. */
  refundOutcome: RefundOutcome | null;
  policy: PolicyConfig;
}

export interface EscalationDecision {
  escalate: boolean;
  reasons: EscalationReason[];
}

export function evaluateEscalation(
  input: EscalationEvaluationInput,
): EscalationDecision {
  const rules = input.policy.escalation;
  const reasons: EscalationReason[] = [];

  if (input.suspectedInjection && rules.escalateOnSuspectedInjection) {
    reasons.push("suspected_injection");
  }
  if (!input.customerFound && rules.escalateOnUnknownCustomer) {
    reasons.push("unknown_customer");
  }
  if (input.refundOutcome === "deny" && rules.escalateOnPolicyDenial) {
    reasons.push("refund_denied_by_policy");
  }
  // A churn risk is a *dissatisfied* high-value customer. A high-value
  // customer whose refund sailed through is a happy customer.
  if (
    input.customerFound &&
    input.customerLifetimeValueCents >= rules.churnRiskLtvCents &&
    input.refundOutcome !== "approve"
  ) {
    reasons.push("churn_risk");
  }

  return { escalate: reasons.length > 0, reasons };
}
