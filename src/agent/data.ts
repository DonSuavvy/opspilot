/**
 * The data seam the tool handlers run against.
 *
 * `OpsData` is a narrow interface over exactly the reads and writes the nine
 * tools perform — not a general repository, and deliberately not Drizzle. Two
 * things fall out of that.
 *
 * **`npm test` never needs Postgres.** The handlers hold the interesting logic
 * (shaping what the model sees, deciding what counts as a business outcome
 * rather than a failure); the part that needs a socket sits on the other side
 * of this boundary and gets exercised by `scripts/verify-*.ts` instead. Same
 * seam, same reasoning, as the agent loop's `MessageCreator`.
 *
 * **Workspace scope is bound once, not passed.** No method here takes a
 * workspace id, because the production implementation closes over one. A
 * handler therefore cannot read another tenant's rows by forgetting a `where`
 * clause — the type gives it no way to express the mistake. That matters from
 * Day 8, when every demo visitor gets their own lazily-seeded workspace and a
 * missed scope becomes one reviewer seeing another's sandbox.
 *
 * Dates cross this boundary as `Date`. The handlers serialize them, because
 * the model sees JSON and an unlabelled timestamp is worse than useless when
 * the refund window is measured in days.
 */
import type { InvoiceStatus } from "../policy/refund";

export interface CustomerRecord {
  externalId: string;
  name: string;
  email: string;
  company: string;
  /** Drives the SOP's retention-offer branch on churn-risk tickets. */
  lifetimeValueCents: number;
}

export interface SubscriptionRecord {
  plan: "free" | "pro" | "scale";
  status: string;
  seats: number;
  monthlyPriceCents: number;
  currentPeriodEnd: Date;
}

export interface InvoiceRecord {
  number: string;
  status: InvoiceStatus;
  amountCents: number;
  refundedCents: number;
  /** The refund window is measured from here, never from creation. */
  paidAt: Date | null;
  description: string;
}

export interface KbHit {
  slug: string;
  title: string;
  body: string;
  /** Postgres FTS rank. Deliberately not a vector score — see docs/PLAN.md. */
  rank: number;
}

/** The structured output of the forced terminal tool. */
export interface TicketOutcome {
  action: string;
  refund_amount_cents: number;
  reply: string;
  confidence: string;
}

export interface OpsData {
  /** By external id or email. Null is a legitimate answer, not an error. */
  findCustomer(query: string): Promise<CustomerRecord | null>;
  getSubscription(customerExternalId: string): Promise<SubscriptionRecord | null>;
  listInvoices(
    customerExternalId: string,
    limit: number,
  ): Promise<InvoiceRecord[]>;
  /** By invoice number. Null is a legitimate answer — the model can invent one. */
  findInvoice(number: string): Promise<InvoiceRecord | null>;
  searchKb(query: string): Promise<KbHit[]>;
  saveDraft(ticketId: string, body: string): Promise<{ draftId: string }>;
  escalateTicket(
    ticketId: string,
    reason: string,
    summary: string,
  ): Promise<{ ticketId: string; status: string }>;
  resolveTicket(
    ticketId: string,
    outcome: TicketOutcome,
  ): Promise<{ ticketId: string; status: string }>;
  /**
   * Move the money. Called by `issue_refund` only after a human approved,
   * because confirm-write pauses the loop before dispatch.
   *
   * `idempotencyKey` is what makes a *retried* resume safe: the same key twice
   * returns the first call's numbers with `duplicate: true` and writes
   * nothing. It is not what makes a *concurrent* one safe — two simultaneous
   * resumes both find no prior row and both write. The guard against that is
   * the `status = 'pending'` predicate on the approval decision, which
   * `scripts/verify-resume.ts` proves; this is the belt to that pair of
   * braces, not a substitute for it.
   *
   * Throws when the invoice is not in this workspace, rather than reporting a
   * refund that had nothing to land on.
   */
  recordRefund(input: {
    invoiceNumber: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundedCents: number; status: string; duplicate: boolean }>;
}
