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
 *    scorers and the policy, not in sampling. (Zod is a pure dependency: it
 *    validates the policy blob, it does not go and fetch one.)
 * 2. **Integer cents.** Money is never a float.
 * 3. **Exhaustive violations.** Every applicable rule is reported, not just
 *    the first one that fires, so the trace viewer can show the full reason
 *    a refund was refused.
 * 4. **The policy itself is parsed, never assumed.** `PolicyConfig` is erased
 *    at build time; `policyConfigSchema` is what survives to runtime, where
 *    the blob actually arrives from the database.
 */
import { z } from "zod";


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
  | "paid_in_the_future"
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

/** Whole cents. Rejects floats, NaN, Infinity, and anything past 2^53. */
const cents = z.number().int().nonnegative().safe();

/**
 * The runtime half of `PolicyConfig`.
 *
 * The interface above is erased at build time, but the value it describes
 * arrives at runtime from `sop_versions.policy_config` — a jsonb blob the
 * Day-4 SOP editor writes. Every rule in this engine is a `>` comparison, and
 * `x > undefined` is `false`, so an absent or misspelled key does not throw:
 * it silently deletes that limit. A `refund: {}` blob approved a $99,999.99
 * refund on a 400-day-old invoice with zero violations.
 *
 * `.strict()` is what catches the misspelling — without it, `maxRefundCent`
 * would be dropped as an unknown key and `maxRefundCents` would read as
 * missing, which is the same silent failure wearing a different hat.
 */
export const policyConfigSchema = z
  .object({
    refund: z
      .object({
        windowDays: z.number().int().nonnegative().safe(),
        maxAutoApproveCents: cents,
        maxRefundCents: cents,
        duplicateChargeBypassesWindow: z.boolean(),
      })
      .strict()
      .refine((r) => r.maxAutoApproveCents <= r.maxRefundCents, {
        message:
          "maxAutoApproveCents must not exceed maxRefundCents — an auto-approve " +
          "threshold above the hard ceiling can never be reached",
      }),
    escalation: z
      .object({
        churnRiskLtvCents: cents,
        escalateOnSuspectedInjection: z.boolean(),
        escalateOnUnknownCustomer: z.boolean(),
        escalateOnPolicyDenial: z.boolean(),
      })
      .strict(),
  })
  .strict();

/**
 * Parse a stored policy blob, throwing on anything malformed.
 *
 * Call this at the boundary — when an SOP version is written, and again when
 * it is read back for enforcement. Failing loudly on a bad policy is the whole
 * point: a policy that cannot be parsed is a policy that cannot be enforced,
 * and enforcing nothing must never be the quiet default.
 */
export function parsePolicyConfig(raw: unknown): PolicyConfig {
  return policyConfigSchema.parse(raw);
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
  const { invoice, requestedCents, reason, now } = input;
  // Parsed here, not merely at the boundary. `PolicyConfig` is a compile-time
  // claim about a value that arrives from jsonb at runtime, and every rule
  // below is a `>` comparison — where a missing key reads as `false` and
  // deletes the limit in silence. Refusing to decide is the only safe answer
  // to a policy that cannot be read.
  const rules = parsePolicyConfig(input.policy).refund;
  const violations: RefundViolation[] = [];

  // Safe, not merely integral: above 2^53 `n + 1 === n`, so arithmetic on the
  // value stops being arithmetic on money. "Never a float" has to mean this.
  if (!Number.isSafeInteger(requestedCents)) {
    violations.push("non_integer_amount");
  }
  if (requestedCents <= 0) {
    violations.push("non_positive_amount");
  }

  // Normalised once. `settled` used `!== null` while the age used truthiness,
  // and they disagreed on `undefined` — which a Drizzle row or a JSON round
  // trip can produce — so an invoice with no payment date was "settled" and
  // skipped the window check entirely. A nullable field gets one null test.
  const paidAt = invoice.paidAt ?? null;

  const settled = SETTLED.has(invoice.status) && paidAt !== null;
  if (!settled) {
    violations.push("invoice_not_paid");
  }

  const balanceCents = invoice.amountCents - invoice.refundedCents;
  if (balanceCents <= 0) {
    violations.push("invoice_already_refunded");
  } else if (requestedCents > balanceCents) {
    violations.push("amount_exceeds_invoice_balance");
  }

  const ageDays =
    paidAt !== null ? (now.getTime() - paidAt.getTime()) / MS_PER_DAY : null;

  const windowWaived =
    reason === "duplicate_charge" && rules.duplicateChargeBypassesWindow;

  // `age > windowDays` bounds one side only, so a negative age — clock skew, a
  // timezone bug, a handler passing the wrong column — read as comfortably
  // inside every window and bought an unlimited refund period. An invoice
  // cannot have been paid in the future; that is bad data, not a fresh charge,
  // and the window bypass must not launder it either.
  if (ageDays !== null && ageDays < 0) {
    violations.push("paid_in_the_future");
  } else if (!windowWaived && ageDays !== null && ageDays > rules.windowDays) {
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
  /**
   * Whether the customer expressed dissatisfaction — cancellation threats,
   * repeated complaints, escalating tone. The model reads this from the ticket
   * body; the policy engine takes it as an input rather than trying to infer
   * sentiment itself. Absent means "no signal", not "satisfied".
   */
  customerDissatisfied?: boolean;
  policy: PolicyConfig;
}

export interface EscalationDecision {
  escalate: boolean;
  reasons: EscalationReason[];
}

export function evaluateEscalation(
  input: EscalationEvaluationInput,
): EscalationDecision {
  // Same reasoning as evaluateRefund: an unreadable policy silently disables
  // every toggle below, which here means quietly *not* escalating.
  const rules = parsePolicyConfig(input.policy).escalation;
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
  /**
   * A churn risk is a *dissatisfied* high-value customer, so dissatisfaction
   * must be positively established. `refundOutcome === null` means no refund
   * was requested at all — a big customer asking a how-to question is not a
   * churn risk, and treating them as one inflates the escalation rate, which
   * is a headline Mission Control KPI. `requires_approval` is a refund still
   * in flight, not a refusal, so it doesn't count either.
   */
  const dissatisfied =
    input.refundOutcome === "deny" || input.customerDissatisfied === true;

  if (
    input.customerFound &&
    input.customerLifetimeValueCents >= rules.churnRiskLtvCents &&
    dissatisfied
  ) {
    reasons.push("churn_risk");
  }

  return { escalate: reasons.length > 0, reasons };
}
