/**
 * The Drizzle implementation of `OpsData`.
 *
 * This is the other side of the seam the tool handlers were written against.
 * Everything above it is pure and unit-tested without Postgres; everything here
 * is SQL, and it gets its evidence from `scripts/verify-*.ts` and the Day-2
 * end-to-end gate rather than from `npm test`.
 *
 * **Workspace scope is bound once, here.** `createOpsData` closes over a
 * workspace id and no method exposes one, so a handler cannot read across a
 * sandbox boundary by forgetting a `where` clause — every query below carries
 * the scope because there is no other way to build one.
 *
 * **The run is bound the same way, and for the same reason.** Every write here
 * lands in `audit_log`, and an audit row that cannot say which run made the
 * change is most of the way to no audit row at all — FAILURES #24 found 15 of
 * them. Passing the run per call would make forgetting it possible; closing
 * over it means no write below *can* omit it.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";

import { applyRefund } from "../policy/refund";

import type {
  CustomerRecord,
  InvoiceRecord,
  KbHit,
  OpsData,
  SubscriptionRecord,
  TicketOutcome,
} from "../agent/data";
import type { Db } from "./client";
import {
  auditLog,
  customers,
  invoices,
  subscriptions,
  tickets,
} from "./schema";

/** Ranked KB hits returned to the model. Small on purpose: the corpus is ~20 */
const KB_LIMIT = 5;

export interface OpsDataScope {
  workspaceId: string;
  /** The run every write below is attributed to. */
  runId: string;
}

export function createOpsData(db: Db, scope: OpsDataScope): OpsData {
  const { workspaceId, runId } = scope;

  /**
   * External id → internal uuid. Every tool addresses customers by the
   * external id the model saw in the ticket, never by a uuid it would have to
   * invent.
   */
  async function customerIdFor(externalId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.workspaceId, workspaceId),
          eq(customers.externalId, externalId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  return {
    async findCustomer(query: string): Promise<CustomerRecord | null> {
      // Either identifier the SOP tells the agent to try. Both are indexed.
      const [row] = await db
        .select({
          externalId: customers.externalId,
          name: customers.name,
          email: customers.email,
          company: customers.company,
          lifetimeValueCents: customers.lifetimeValueCents,
        })
        .from(customers)
        .where(
          and(
            eq(customers.workspaceId, workspaceId),
            or(
              eq(customers.externalId, query),
              eq(customers.email, query.toLowerCase()),
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getSubscription(
      customerExternalId: string,
    ): Promise<SubscriptionRecord | null> {
      const customerId = await customerIdFor(customerExternalId);
      if (customerId === null) return null;

      const [row] = await db
        .select({
          plan: subscriptions.plan,
          status: subscriptions.status,
          seats: subscriptions.seats,
          monthlyPriceCents: subscriptions.monthlyPriceCents,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.workspaceId, workspaceId),
            eq(subscriptions.customerId, customerId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listInvoices(
      customerExternalId: string,
      limit: number,
    ): Promise<InvoiceRecord[]> {
      const customerId = await customerIdFor(customerExternalId);
      if (customerId === null) return [];

      // Newest first, as the tool description promises — the agent reasons
      // about "last week's charge" and reads from the top.
      return db
        .select({
          number: invoices.number,
          status: invoices.status,
          amountCents: invoices.amountCents,
          refundedCents: invoices.refundedCents,
          paidAt: invoices.paidAt,
          description: invoices.description,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.workspaceId, workspaceId),
            eq(invoices.customerId, customerId),
          ),
        )
        .orderBy(desc(invoices.paidAt))
        .limit(Math.max(1, Math.min(limit, 50)));
    },

    /**
     * Postgres full-text search, deliberately not vectors: a 20-document
     * corpus answering exact-match product questions is where FTS wins, and
     * the reasoning is itself part of the write-up (PLAN.md, pillar 1).
     *
     * `plainto_tsquery` rather than `to_tsquery` because the argument is model
     * output — `to_tsquery` would raise a syntax error on an unbalanced quote
     * or a bare `&`, turning a search into a failed tool call.
     */
    /** By number, scoped to the workspace — the handler has no customer id. */
    async findInvoice(number: string) {
      const [row] = await db
        .select({
          number: invoices.number,
          status: invoices.status,
          amountCents: invoices.amountCents,
          refundedCents: invoices.refundedCents,
          paidAt: invoices.paidAt,
          description: invoices.description,
        })
        .from(invoices)
        .where(
          and(eq(invoices.workspaceId, workspaceId), eq(invoices.number, number)),
        )
        .limit(1);
      return row ?? null;
    },

    async searchKb(query: string): Promise<KbHit[]> {
      const rows = await db.execute<{
        slug: string;
        title: string;
        body: string;
        rank: number;
      }>(sql`
        SELECT slug, title, body, ts_rank(search_vector, q) AS rank
        FROM kb_articles, plainto_tsquery('english', ${query}) AS q
        WHERE workspace_id = ${workspaceId} AND search_vector @@ q
        ORDER BY rank DESC
        LIMIT ${KB_LIMIT}
      `);
      return rows.rows.map((r) => ({ ...r, rank: Number(r.rank) }));
    },

    /**
     * Drafts live in `audit_log`. There is no `drafts` table by design: a
     * draft is a logged, reversible side effect, which is exactly what the
     * audit log is for, and PLAN.md wants every side effect recorded there
     * anyway. The row id is the draft id.
     */
    async saveDraft(ticketId: string, body: string) {
      const [row] = await db
        .insert(auditLog)
        .values({
          workspaceId,
          runId,
          actorType: "agent",
          action: "draft_reply",
          entityType: "ticket",
          entityId: ticketId,
          after: { body },
        })
        .returning({ id: auditLog.id });
      return { draftId: row!.id };
    },

    async escalateTicket(ticketId: string, reason: string, summary: string) {
      await db
        .update(tickets)
        .set({ status: "escalated" })
        .where(
          and(eq(tickets.workspaceId, workspaceId), eq(tickets.id, ticketId)),
        );

      await db.insert(auditLog).values({
        workspaceId,
        runId,
        actorType: "agent",
        action: "escalate",
        entityType: "ticket",
        entityId: ticketId,
        after: { reason, summary },
      });

      return { ticketId, status: "escalated" };
    },

    /**
     * The write FAILURES #24 was about: a refund a human approved, actually
     * landing on the invoice and in the audit log.
     *
     * One transaction, and the invoice row is locked for the length of it.
     * Without the lock two refunds against the same invoice can both read the
     * same `refunded_cents` and both write their own total, so the second
     * silently erases the first — an invoice refunded twice that reads as
     * refunded once.
     *
     * The idempotency key is looked up in `audit_log` rather than in a table
     * of its own. The audit row is already the record that the refund
     * happened, so a second store would be a second source of truth about the
     * same fact, and the one that could drift is the one money is decided on.
     */
    async recordRefund(input: {
      invoiceNumber: string;
      amountCents: number;
      reason: string;
      idempotencyKey: string;
    }) {
      return db.transaction(async (tx) => {
        // Asked first, so a replay never reaches the arithmetic — an already
        // fully-refunded invoice would otherwise throw out of `applyRefund`
        // on the retry that should have been a no-op.
        const [seen] = await tx
          .select({ after: auditLog.after })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.workspaceId, workspaceId),
              eq(auditLog.action, "issue_refund"),
              // Scoped to the invoice, not just the key. The key is written by
              // the model, so two refunds can carry the same string — a
              // customer charged twice, one key reused across both invoices —
              // and matching on the key alone would swallow the second refund
              // and report the first invoice's totals for it.
              eq(auditLog.entityId, input.invoiceNumber),
              sql`${auditLog.after}->>'idempotency_key' = ${input.idempotencyKey}`,
            ),
          )
          .limit(1);

        if (seen) {
          const recorded = seen.after as {
            refundedCents: number;
            status: string;
          };
          return {
            refundedCents: recorded.refundedCents,
            status: recorded.status,
            duplicate: true,
          };
        }

        const [invoice] = await tx
          .select({
            id: invoices.id,
            amountCents: invoices.amountCents,
            refundedCents: invoices.refundedCents,
            status: invoices.status,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.workspaceId, workspaceId),
              eq(invoices.number, input.invoiceNumber),
            ),
          )
          .limit(1)
          .for("update");

        if (!invoice) {
          throw new Error(
            `no invoice ${input.invoiceNumber} in this workspace — refused ` +
              `rather than recording a refund against nothing`,
          );
        }

        // The second guard. `evaluateRefund` already rejected an over-refund
        // upstream; this one runs against the row as it is *now*, inside the
        // lock, which is the only place the check can be true when it matters.
        const ledger = applyRefund(
          {
            amountCents: invoice.amountCents,
            refundedCents: invoice.refundedCents,
          },
          input.amountCents,
        );

        await tx
          .update(invoices)
          .set({
            refundedCents: ledger.refundedCents,
            status: ledger.status,
          })
          .where(eq(invoices.id, invoice.id));

        await tx.insert(auditLog).values({
          workspaceId,
          runId,
          actorType: "agent",
          action: "issue_refund",
          entityType: "invoice",
          entityId: input.invoiceNumber,
          before: {
            refundedCents: invoice.refundedCents,
            status: invoice.status,
          },
          after: {
            refundedCents: ledger.refundedCents,
            status: ledger.status,
            // This refund's own amount, not the invoice's — the running
            // total lives in `refundedCents` beside it.
            amountCents: input.amountCents,
            reason: input.reason,
            // Snake case on purpose: the duplicate lookup above reads
            // `after->>'idempotency_key'` and tidying one spelling without
            // the other turns idempotency off in silence.
            idempotency_key: input.idempotencyKey,
          },
        });

        return {
          refundedCents: ledger.refundedCents,
          status: ledger.status,
          duplicate: false,
        };
      });
    },

    async resolveTicket(ticketId: string, outcome: TicketOutcome) {
      // `escalated` is a resolution of the run, not of the ticket — a human
      // still owns it, so the ticket must not be closed underneath them.
      const status = outcome.action === "escalated" ? "escalated" : "resolved";

      await db
        .update(tickets)
        .set({ status, resolvedAt: new Date() })
        .where(
          and(eq(tickets.workspaceId, workspaceId), eq(tickets.id, ticketId)),
        );

      await db.insert(auditLog).values({
        workspaceId,
        runId,
        actorType: "agent",
        action: "resolve_ticket",
        entityType: "ticket",
        entityId: ticketId,
        after: outcome,
      });

      return { ticketId, status };
    },
  };
}
