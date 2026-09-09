import { describe, expect, it, vi } from "vitest";

import type { InvoiceRecord, OpsData } from "@/agent/data";

import { withRecordedWrites } from "./recorded-data";

/**
 * The eval suite runs the real agent against the real seeded workspace,
 * because a case that ran against fixtures would prove nothing about the demo
 * a reviewer watches. That leaves exactly one problem: the writes.
 *
 * Eight cases a day, each one refunding INV-2001 and resolving a seeded
 * ticket, and the inbox the demo depends on is gone by the second run —
 * invoices marked refunded, tickets closed, `verify:seed` red. This wrapper is
 * the answer: reads hit the real workspace, writes are recorded and go
 * nowhere.
 */

const INVOICE: InvoiceRecord = {
  number: "INV-2001",
  status: "paid",
  amountCents: 4_900,
  refundedCents: 0,
  paidAt: new Date("2026-09-03T00:00:00.000Z"),
  description: "Pro plan — monthly subscription",
};

function realData(): OpsData {
  return {
    findCustomer: vi.fn(async () => ({
      externalId: "cus_0001",
      name: "Maya Okonkwo",
      email: "maya@northwind.com",
      company: "Northwind Retail",
      lifetimeValueCents: 29_400,
    })),
    getSubscription: vi.fn(async () => null),
    listInvoices: vi.fn(async () => [INVOICE]),
    findInvoice: vi.fn(async () => INVOICE),
    searchKb: vi.fn(async () => []),
    saveDraft: vi.fn(async () => ({ draftId: "real_draft" })),
    escalateTicket: vi.fn(async () => ({
      ticketId: "real",
      status: "escalated",
    })),
    resolveTicket: vi.fn(async () => ({ ticketId: "real", status: "resolved" })),
    recordRefund: vi.fn(async () => ({
      refundedCents: 4_900,
      status: "refunded",
      duplicate: false,
    })),
  };
}

describe("withRecordedWrites — reads", () => {
  it("delegates every read to the real seam, arguments intact", async () => {
    const real = realData();
    const { data } = withRecordedWrites(real);

    await data.findCustomer("cus_0001");
    await data.getSubscription("cus_0001");
    await data.listInvoices("cus_0001", 12);
    await data.findInvoice("INV-2001");
    await data.searchKb("rotate api key");

    expect(real.findCustomer).toHaveBeenCalledWith("cus_0001");
    expect(real.getSubscription).toHaveBeenCalledWith("cus_0001");
    expect(real.listInvoices).toHaveBeenCalledWith("cus_0001", 12);
    expect(real.findInvoice).toHaveBeenCalledWith("INV-2001");
    expect(real.searchKb).toHaveBeenCalledWith("rotate api key");
  });

  it("returns what the real seam returned, unmodified", async () => {
    const { data } = withRecordedWrites(realData());

    await expect(data.findInvoice("INV-2001")).resolves.toEqual(INVOICE);
  });

  it("records nothing for a read", async () => {
    const { data, writes } = withRecordedWrites(realData());

    await data.searchKb("anything");

    expect(writes).toEqual([]);
  });
});

describe("withRecordedWrites — writes", () => {
  /**
   * The one that matters. `recordRefund` takes an invoice *number*, and the
   * seeded workspace has a row for every number a case can name — so an
   * incomplete wrapper does not fail loudly, it quietly refunds INV-2001 for
   * real, eight times a day.
   */
  it("never reaches the real seam", async () => {
    const real = realData();
    const { data } = withRecordedWrites(real);

    await data.saveDraft("tkt_1", "body");
    await data.escalateTicket("tkt_1", "policy_denial", "summary");
    await data.resolveTicket("tkt_1", {
      action: "escalated",
      refund_amount_cents: 0,
      reply: "reply",
      confidence: "high",
    });
    await data.recordRefund({
      invoiceNumber: "INV-2001",
      amountCents: 4_900,
      reason: "service_issue",
      idempotencyKey: "k",
    });

    expect(real.saveDraft).not.toHaveBeenCalled();
    expect(real.escalateTicket).not.toHaveBeenCalled();
    expect(real.resolveTicket).not.toHaveBeenCalled();
    expect(real.recordRefund).not.toHaveBeenCalled();
  });

  it("records each write in order, with its arguments", async () => {
    const { data, writes } = withRecordedWrites(realData());

    await data.saveDraft("tkt_1", "the draft");
    await data.escalateTicket("tkt_1", "suspected_injection", "saw an override");

    expect(writes).toEqual([
      { method: "saveDraft", args: ["tkt_1", "the draft"] },
      {
        method: "escalateTicket",
        args: ["tkt_1", "suspected_injection", "saw an override"],
      },
    ]);
  });

  /**
   * The canned answers have to be plausible, not merely well typed. The agent
   * reads each tool result and decides what to do next, so a refund that came
   * back `refundedCents: 0` would push it into retrying or escalating and the
   * case would score a behaviour the wrapper invented.
   */
  it("answers a refund with the amount that was asked for", async () => {
    const { data } = withRecordedWrites(realData());

    await expect(
      data.recordRefund({
        invoiceNumber: "INV-2004",
        amountCents: 4_900,
        reason: "duplicate_charge",
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({
      refundedCents: 4_900,
      status: "refunded",
      duplicate: false,
    });
  });

  it("answers escalate and resolve with the ticket they were given", async () => {
    const { data } = withRecordedWrites(realData());

    await expect(
      data.escalateTicket("tkt_9", "unknown_customer", "no account"),
    ).resolves.toEqual({ ticketId: "tkt_9", status: "escalated" });

    await expect(
      data.resolveTicket("tkt_9", {
        action: "escalated",
        refund_amount_cents: 0,
        reply: "r",
        confidence: "low",
      }),
    ).resolves.toEqual({ ticketId: "tkt_9", status: "resolved" });
  });

  it("gives each draft a distinct id", async () => {
    const { data } = withRecordedWrites(realData());

    const first = await data.saveDraft("tkt_1", "a");
    const second = await data.saveDraft("tkt_1", "b");

    expect(first.draftId).not.toBe(second.draftId);
  });
});
