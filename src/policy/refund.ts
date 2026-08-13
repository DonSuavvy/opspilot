/**
 * The policy engine: the code-level half of OpsPilot's defense in depth.
 *
 * The refund policy is stated twice on purpose. Once in the SOP markdown, so
 * the model knows it and can explain it to a customer; and once here, so the
 * `issue_refund` tool handler can revalidate whatever the model proposed and
 * reject it with `is_error: true` when it is out of policy. Never trust the
 * model. This module is what makes that claim true.
 *
 * Four properties this file must keep:
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


/**
 * Every invoice status, as a value and not only as a type. The union below is
 * derived from this array so the runtime list and the compile-time type cannot
 * drift: adding a status adds it to both, and a status that exists in the type
 * but not the list would otherwise read as bad data on every invoice.
 */
export const INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "refunded",
  "partially_refunded",
  "void",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

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
  /** The invoice row itself is unreadable — see `evaluateRefund`. */
  | "invalid_invoice_data"
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
  | "unknown_customer_value"
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
    /**
     * Always `true`, and typed as the literal so the compiler refuses
     * `false` at every call site rather than leaving it to runtime parsing.
     * See `policyConfigSchema` for why the key is pinned rather than removed.
     */
    escalateOnSuspectedInjection: true;
    escalateOnUnknownCustomer: boolean;
    escalateOnPolicyDenial: boolean;
  };
}

/** Whole cents. Rejects floats, NaN, Infinity, and anything past 2^53. */
const cents = z.number().int().nonnegative().safe();

/**
 * Absolute ceilings on what a policy may authorise, independent of what any
 * other field says.
 *
 * The relative bound below (`maxAutoApproveCents <= maxRefundCents`) is a
 * consistency check — it says the two numbers agree with each other, not that
 * either is sane. Both are satisfied at any magnitude, so before these
 * constants existed a policy setting both to 99_999_999 parsed cleanly and the
 * engine approved $999,999.99 with zero violations. "Never trust the model"
 * had no number behind it on this axis: the code enforced whatever was typed.
 *
 * Derived from the data rather than chosen for roundness. The largest invoice
 * Beacon Analytics issues is a single Scale month, $299 — `max(amount_cents)`
 * is 29900 across all 54 seeded rows — so:
 *
 * - `MAX_REFUND_CEILING_CENTS` at $5,000 is ~17x the largest refund that can
 *   ever be legitimate, constraining no real case, and sits strictly below the
 *   $10,000 the adversarial ticket demands. Demo arc step 4 asserts that an
 *   injection attempt fires zero tools; that claim must not be defeatable by
 *   editing a number in the SOP editor.
 * - `MAX_AUTO_APPROVE_CEILING_CENTS` at $1,000 bounds what the agent may spend
 *   with no human in the loop — the figure that matters most when the model is
 *   wrong, because nothing else is watching.
 * - `MAX_REFUND_WINDOW_DAYS` at a year: a refund window longer than that is
 *   not a window, and an unbounded one silently deletes the rule that makes
 *   demo arc step 2 mean anything.
 *
 * These are ceilings on what is *configurable*, not operating values. The
 * shipped defaults sit far below them.
 */
export const MAX_REFUND_WINDOW_DAYS = 365;
export const MAX_AUTO_APPROVE_CEILING_CENTS = 100_000; // $1,000
export const MAX_REFUND_CEILING_CENTS = 500_000; // $5,000

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
 * A *misspelled* key is caught by the required-key check on its own:
 * `maxRefundCent` leaves `maxRefundCents` absent, and an absent required key is
 * rejected whether or not the object is strict. `.strict()` guarantees
 * something narrower and still load-bearing — it rejects an **extra** key
 * alongside an otherwise-complete, valid policy. That is the Day-4 SOP editor
 * writing a limit this engine does not implement: without `.strict()` the key
 * is dropped in silence and the operator is left believing a rule is enforced
 * that no line of code reads. It is applied at all three levels because each
 * object only sees its own keys — the outer one cannot police `refund`.
 */
export const policyConfigSchema = z
  .object({
    refund: z
      .object({
        windowDays: z
          .number()
          .int()
          .nonnegative()
          .safe()
          .max(MAX_REFUND_WINDOW_DAYS),
        maxAutoApproveCents: cents.max(MAX_AUTO_APPROVE_CEILING_CENTS),
        maxRefundCents: cents.max(MAX_REFUND_CEILING_CENTS),
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
        /**
         * Pinned, not settable. Every other control here is a business
         * preference; this one's "off" position is a security downgrade, and
         * it backs the claim that a prompt-injection ticket escalates with
         * zero tools fired.
         *
         * `z.literal(true)` rather than deleting the key: the field is already
         * persisted in `sop_versions.policy_config` for every existing version
         * and the object is `.strict()`, so removing it would make every
         * stored policy unparseable and take the engine down on read. Pinning
         * keeps old rows readable, keeps the guarantee visible where the
         * policy is edited, and turns an attempt to disable it into a loud
         * parse failure rather than a silent one.
         */
        escalateOnSuspectedInjection: z.literal(true),
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
  /**
   * Days elapsed since payment; null when the invoice has no usable payment
   * date. Never `NaN` — the trace viewer and the eval scorers read this.
   */
  ageDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Statuses that mean money actually changed hands. */
const SETTLED: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  "paid",
  "partially_refunded",
  "refunded",
]);

const KNOWN_STATUS: ReadonlySet<string> = new Set(INVOICE_STATUSES);

/**
 * A cents field on an invoice row: whole, non-negative, and small enough that
 * integer arithmetic is still arithmetic. `Number.isSafeInteger` already
 * rejects `NaN`, `Infinity`, fractions and non-numbers; the explicit `>= 0` is
 * what rejects a negative amount or a negative refunded total.
 */
function isCentsField(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * A `Date` that actually denotes a moment. `new Date(undefined)` is an Invalid
 * Date — a real `Date` instance whose `getTime()` is `NaN`, so it survives both
 * an `instanceof` test and a `?? null` normalisation and then poisons every
 * comparison downstream.
 */
function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

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

  // `now` is injected by the calling code — never by the model, never by the
  // database — so an unusable clock is a bug in the caller rather than bad
  // data, and it gets the same answer as an unreadable policy: refuse to
  // decide. Left unchecked it is the worst of the lot, because `NaN` fails
  // *every* comparison: it would skip the future-dated guard and the refund
  // window both, and approve silently with zero violations.
  if (!isUsableDate(now)) {
    throw new TypeError(
      "evaluateRefund: `now` must be a valid Date. It is supplied by the " +
        "caller, so an invalid clock is a programmer error — and a NaN age " +
        "silently skips the refund window rather than failing it.",
    );
  }

  const violations: RefundViolation[] = [];

  // Safe, not merely integral: above 2^53 `n + 1 === n`, so arithmetic on the
  // value stops being arithmetic on money. "Never a float" has to mean this.
  if (!Number.isSafeInteger(requestedCents)) {
    violations.push("non_integer_amount");
  }
  if (requestedCents <= 0) {
    violations.push("non_positive_amount");
  }

  // `invoice` crosses a runtime boundary the interface above does not police:
  // a Drizzle row, a JSON round trip, and from Day 2 a model-proposed tool
  // argument. Bad data here is a violation rather than a throw, because this
  // engine's job is to report every reason a refund was refused and a ZodError
  // shows the trace viewer nothing. Each field is tested separately so a bad
  // one withdraws only the rules that actually read it.
  const statusOk = KNOWN_STATUS.has(invoice.status);
  const amountOk = isCentsField(invoice.amountCents);
  const refundedOk = isCentsField(invoice.refundedCents);

  // `null` and `undefined` both mean "never paid": a nullable column, and a
  // partial select of that same column. Anything else that is not a usable
  // Date is bad data — including the ISO string a JSON round trip makes of a
  // Date, because deserialising belongs to the boundary that serialised it.
  // Previously an Invalid Date survived `?? null`, made `ageDays` NaN, and so
  // skipped both the future-dated guard and the window check.
  const paidAtRaw: unknown = invoice.paidAt;
  const paidAtOk =
    paidAtRaw === null || paidAtRaw === undefined || isUsableDate(paidAtRaw);
  const paidAt: Date | null = isUsableDate(paidAtRaw) ? paidAtRaw : null;

  // Pushed at a fixed point in the sequence rather than wherever the first bad
  // field happened to be found, so the array stays order-stable and carries one
  // entry however many fields are wrong.
  if (!statusOk || !amountOk || !refundedOk || !paidAtOk) {
    violations.push("invalid_invoice_data");
  }

  const settled = SETTLED.has(invoice.status) && paidAt !== null;
  if (!settled) {
    violations.push("invoice_not_paid");
  }

  // Skipped rather than run on garbage: `NaN <= 0` and `x > NaN` are both
  // false, so an unchecked balance withdraws *both* of these rules at once.
  if (amountOk && refundedOk) {
    const balanceCents = invoice.amountCents - invoice.refundedCents;
    if (balanceCents <= 0) {
      violations.push("invoice_already_refunded");
    } else if (requestedCents > balanceCents) {
      violations.push("amount_exceeds_invoice_balance");
    }
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
  //
  // This validates the *whole* policy and then reads only `.escalation`, so a
  // malformed `refund` block disables escalation too. That coupling is a
  // deliberate precondition, not an oversight. `policy_config` is one jsonb
  // blob in one versioned `sop_versions` row: it is valid or it is not, and
  // "half-enforced SOP" is not a state this system should ever run in. The
  // failure is also loud — this throws rather than under-escalating in
  // silence, which is the direction that matters for a function whose job
  // includes catching prompt injection. Parsing only the sub-schema would buy
  // a narrower blast radius at the cost of running on a policy already known
  // to be broken.
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

  /**
   * The same NaN class `evaluateRefund` guards against, pointing the other way.
   * `NaN >= churnRiskLtvCents` is `false`, so an unreadable lifetime value used
   * to drop `churn_risk` in silence: a dissatisfied $5,000 customer simply did
   * not escalate. Bad data makes refunds over-approve and escalation
   * *under*-escalate, and the quiet failure is the more dangerous one.
   *
   * Reported as its own reason rather than folded into `churn_risk`. Assuming
   * churn would inflate the churn-risk rate, a headline Mission Control KPI,
   * and put a claim in the trace that was never established. Scoped to
   * `dissatisfied`, because a satisfied customer is not a churn risk at any
   * value — there, an unknown LTV decides nothing and must not escalate.
   */
  const ltvKnown = Number.isSafeInteger(input.customerLifetimeValueCents);

  if (input.customerFound && dissatisfied && !ltvKnown) {
    reasons.push("unknown_customer_value");
  } else if (
    input.customerFound &&
    input.customerLifetimeValueCents >= rules.churnRiskLtvCents &&
    dissatisfied
  ) {
    reasons.push("churn_risk");
  }

  return { escalate: reasons.length > 0, reasons };
}
