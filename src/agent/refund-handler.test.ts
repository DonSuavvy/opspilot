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

    expect(result).toMatchObject({ status: "pending_approval" });
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

    expect(result).toMatchObject({ status: "pending_approval" });
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
    ).resolves.toMatchObject({ status: "pending_approval" });
  });
});
