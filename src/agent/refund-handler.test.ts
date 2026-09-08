import { describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY, type PolicyConfig } from "@/policy/refund";

import type { InvoiceRecord, OpsData } from "./data";
import { buildRegistry, type ToolContext } from "./registry";
import { OutOfPolicyRefundError, TOOLS } from "./tools";

/**
 * The second of the two enforcement points.
 *
 * `CLAUDE.md` has said since Day 1 that refund limits are enforced twice — in
 * the SOP so the model knows them, and in this handler so the code guarantees
 * them — under the heading *Never trust the model*. Until now that was an
 * architectural claim with no live counterexample and no implementation:
 * `issue_refund` was `pending()`, so `evaluateRefund` had no production caller
 * and `policy_config` constrained only what the model was *told*.
 *
 * FAILURES #21 supplied the counterexample. With the window narrowed to 14 days
 * and the run verifiably pinned to that version, the model read the document,
 * read an invoice paid 22.2 days earlier, and requested the full refund anyway.
 * The prompt is not the guarantee. This is.
 *
 * The tests below are that case, made deterministic.
 */

const NOW = new Date("2026-08-15T12:00:00Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

/** INV-2002, the demo fixture: $49.00, paid 22 days before `NOW`. */
const INV_2002: InvoiceRecord = {
  number: "INV-2002",
  status: "paid",
  amountCents: 4_900,
  refundedCents: 0,
  paidAt: daysAgo(22),
  description: "Pro plan — monthly",
};

function fakeData(invoice: InvoiceRecord | null = INV_2002): OpsData {
  return {
    findCustomer: vi.fn(async () => null),
    getSubscription: vi.fn(async () => null),
    listInvoices: vi.fn(async () => (invoice ? [invoice] : [])),
    findInvoice: vi.fn(async () => invoice),
    searchKb: vi.fn(async () => []),
    saveDraft: vi.fn(async () => ({ draftId: "draft_1" })),
    escalateTicket: vi.fn(async () => ({ ticketId: "tkt_1", status: "escalated" })),
    resolveTicket: vi.fn(async () => ({ ticketId: "tkt_1", status: "resolved" })),
    recordRefund: vi.fn(async () => ({
      refundedCents: 4_900,
      status: "refunded",
      duplicate: false,
    })),
  };
}

function ctx(data: OpsData, policyConfig: PolicyConfig): ToolContext {
  return {
    workspaceId: "ws_demo",
    runId: "run_1",
    ticketId: "tkt_1",
    now: NOW,
    data,
    policyConfig,
  };
}

const registry = buildRegistry(TOOLS);

function issueRefund(
  input: Record<string, unknown>,
  policyConfig: PolicyConfig,
  data: OpsData = fakeData(),
) {
  return registry.get("issue_refund")!.handler(input as never, ctx(data, policyConfig));
}

const validCall = {
  invoice_id: "INV-2002",
  amount_cents: 4_900,
  reason: "service_issue" as const,
  idempotency_key: "tkt_1-INV-2002",
};

function withWindow(days: number): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    refund: { ...DEFAULT_POLICY.refund, windowDays: days },
  };
}

describe("issue_refund revalidation", () => {
  /**
   * FAILURES #21, deterministic. The model asked for exactly this and the
   * prompt did not stop it; the handler must.
   */
  it("rejects the refund the model asked for outside the narrowed window", async () => {
    await expect(issueRefund(validCall, withWindow(14))).rejects.toThrow(
      OutOfPolicyRefundError,
    );
  });

  it("accepts the same call under the wider window that was active before", async () => {
    const result = await issueRefund(validCall, withWindow(30));

    expect(result).toMatchObject({ status: "refunded", recorded: true });
  });

  /**
   * The whole point of the rejection is that the agent can act on it. A thrown
   * error the loop turns into `is_error: true` gives the model something to
   * adapt to; a silent denial gives it nothing, and the run stalls.
   */
  it("names the window and the invoice age so the model can escalate accurately", async () => {
    await expect(issueRefund(validCall, withWindow(14))).rejects.toThrow(/14/);
    await expect(issueRefund(validCall, withWindow(14))).rejects.toThrow(/22/);
  });

  it("rejects an amount above the refund ceiling", async () => {
    await expect(
      issueRefund(
        { ...validCall, amount_cents: 4_900 },
        {
          ...withWindow(30),
          refund: {
            ...withWindow(30).refund,
            maxRefundCents: 1_000,
            maxAutoApproveCents: 500,
          },
        },
      ),
    ).rejects.toThrow(OutOfPolicyRefundError);
  });

  it("rejects a refund larger than the unrefunded balance", async () => {
    await expect(
      issueRefund({ ...validCall, amount_cents: 9_999 }, withWindow(30)),
    ).rejects.toThrow(OutOfPolicyRefundError);
  });

  /**
   * A duplicate charge is our billing error, so the clock does not apply — the
   * one case where an old invoice is still refundable. Without this the guard
   * would be correct and the product wrong.
   */
  it("allows a duplicate charge outside the window, because the SOP says so", async () => {
    const result = await issueRefund(
      { ...validCall, reason: "duplicate_charge" },
      withWindow(14),
    );

    expect(result).toMatchObject({ status: "refunded", recorded: true });
  });

  it("rejects a refund against an invoice that was never paid", async () => {
    const unpaid: InvoiceRecord = { ...INV_2002, status: "open", paidAt: null };

    await expect(
      issueRefund(validCall, withWindow(30), fakeData(unpaid)),
    ).rejects.toThrow(OutOfPolicyRefundError);
  });

  it("rejects an invoice the workspace does not have", async () => {
    await expect(
      issueRefund(validCall, withWindow(30), fakeData(null)),
    ).rejects.toThrow(OutOfPolicyRefundError);
  });

  /**
   * The handler must never read the wall clock — same rule as the policy
   * engine. A guard whose verdict depends on when it ran cannot be replayed by
   * the eval suite, and the refund-window cases would drift and go flaky.
   */
  it("decides from the injected clock, not the wall clock", async () => {
    const data = fakeData({ ...INV_2002, paidAt: daysAgo(13) });

    await expect(
      issueRefund(validCall, withWindow(14), data),
    ).resolves.toMatchObject({ status: "refunded", recorded: true });
  });
});

/**
 * FAILURES #24: the approval worked, the trace was green, the customer was
 * told the money was on its way, and `refunded_cents` stayed at zero. The
 * handler validated the refund and returned; nothing wrote anything.
 *
 * Confirm-write means this handler runs only after a human said yes, so by the
 * time it is reached "authorized" is not the answer any more — recording it is.
 */
describe("issue_refund recording", () => {
  it("records the approved refund through the seam, exactly once", async () => {
    const data = fakeData();
    await issueRefund(validCall, withWindow(30), data);

    expect(data.recordRefund).toHaveBeenCalledTimes(1);
    expect(data.recordRefund).toHaveBeenCalledWith({
      invoiceNumber: "INV-2002",
      // The *approved* amount, not the requested one. They agree here and
      // the distinction is the point: the policy decision is what moves.
      amountCents: 4_900,
      reason: "service_issue",
      idempotencyKey: "tkt_1-INV-2002",
    });
  });

  /**
   * Four fields, three different sources: `status` is the handler's own word
   * for "the refund happened"; `amount_cents` is this refund, from the policy
   * decision; `refunded_cents_total` and `invoice_status` describe the invoice
   * afterwards and come from the seam. The fixture makes all four disagree on
   * purpose — a partly refunded invoice topped up by 3,000 to 4,000 of its
   * 4,900, so it is still only partly refunded. With the obvious full-refund
   * fixture the four collapse to two values and the test passes even if the
   * handler reports the request where the row belongs, or hardcodes the
   * invoice status it hopes for.
   */
  it("reports what the seam recorded, not what the model asked for", async () => {
    const data = fakeData({ ...INV_2002, refundedCents: 1_000 });
    vi.mocked(data.recordRefund).mockResolvedValue({
      refundedCents: 4_000,
      status: "partially_refunded",
      duplicate: false,
    });

    const result = await issueRefund(
      { ...validCall, amount_cents: 3_000 },
      withWindow(30),
      data,
    );

    expect(result).toMatchObject({
      status: "refunded",
      recorded: true,
      duplicate: false,
      invoice_id: "INV-2002",
      amount_cents: 3_000,
      refunded_cents_total: 4_000,
      invoice_status: "partially_refunded",
      idempotency_key: "tkt_1-INV-2002",
    });
  });

  /**
   * The whole reason the key exists. A resume retried after a timeout must
   * tell the model the money already moved, not move it again — and not claim
   * a second refund happened either.
   */
  it("surfaces a duplicate from the seam rather than hiding it", async () => {
    const data = fakeData();
    vi.mocked(data.recordRefund).mockResolvedValue({
      refundedCents: 4_900,
      status: "refunded",
      duplicate: true,
    });

    const result = await issueRefund(validCall, withWindow(30), data);

    expect(result).toMatchObject({ recorded: true, duplicate: true });
  });

  it("never records a refund the policy denied", async () => {
    const data = fakeData();

    await expect(issueRefund(validCall, withWindow(14), data)).rejects.toThrow(
      OutOfPolicyRefundError,
    );
    expect(data.recordRefund).not.toHaveBeenCalled();
  });
});
