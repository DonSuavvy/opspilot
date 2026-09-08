import { describe, expect, it } from "vitest";

import {
  describeApproval,
  toResumeDecisions,
  type ApprovalRow,
} from "./approvals";

/**
 * The approvals table is the human's half of the loop. These tests cover the
 * pure mapping between its rows and what `runAgentLoop` consumes; the
 * transitions themselves are SQL and are exercised by
 * `scripts/verify-resume.ts` against a real database, because `npm test` must
 * never need Postgres.
 */

function row(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr_1",
    toolUseId: "toolu_refund",
    toolName: "issue_refund",
    toolInput: { invoice_id: "INV-2002", amount_cents: 4900 },
    status: "approved",
    decisionReason: null,
    ...over,
  };
}

describe("toResumeDecisions", () => {
  it("maps an approved row to an approving decision", () => {
    expect(toResumeDecisions([row()])).toEqual([
      { toolUseId: "toolu_refund", approved: true, reason: null },
    ]);
  });

  it("carries the reviewer's reason through a denial", () => {
    const decisions = toResumeDecisions([
      row({ status: "denied", decisionReason: "Outside the window." }),
    ]);

    expect(decisions).toEqual([
      {
        toolUseId: "toolu_refund",
        approved: false,
        reason: "Outside the window.",
      },
    ]);
  });

  /**
   * The load-bearing one. A pending row carries no answer, and the loop reads
   * this list as "these calls have been decided" — `firstCallAwaitingApproval`
   * skips any id it finds here. Letting a pending row through would therefore
   * stop the run pausing for a call nobody has answered, and send it into
   * dispatch with a decision that does not exist.
   */
  it("drops undecided rows rather than treating them as answers", () => {
    const decisions = toResumeDecisions([
      row({ status: "pending" }),
      row({ id: "apr_2", toolUseId: "toolu_other", status: "denied" }),
    ]);

    expect(decisions.map((d) => d.toolUseId)).toEqual(["toolu_other"]);
  });
});

/**
 * What the queue shows a reviewer.
 *
 * The two confirm-write tools get a sentence each; everything else falls back
 * to the raw payload rather than to a lie. The fallback matters more than it
 * looks: a tenth tool added later renders as ugly JSON, which is a prompt to
 * write it a sentence — not a silently wrong summary of a call nobody read.
 */
describe("describeApproval", () => {
  it("renders a refund as an amount, an invoice and a reason", () => {
    expect(
      describeApproval({
        toolName: "issue_refund",
        toolInput: {
          invoice_id: "INV-2002",
          amount_cents: 4900,
          reason: "service_issue",
        },
      }),
    ).toBe("Refund $49.00 against INV-2002 (service_issue)");
  });

  /**
   * The live shape, not the minimal one. `issue_refund` also takes
   * `idempotency_key`, and the queue reads `approvals.tool_input` exactly as
   * the model sent it — so a describer that insisted on the three fields it
   * uses would pass every test above and render raw JSON in the browser.
   */
  it("ignores fields it does not need rather than falling back", () => {
    expect(
      describeApproval({
        toolName: "issue_refund",
        toolInput: {
          invoice_id: "INV-2004",
          amount_cents: 12000,
          reason: "duplicate_charge",
          idempotency_key: "tkt_1:INV-2004",
        },
      }),
    ).toBe("Refund $120.00 against INV-2004 (duplicate_charge)");
  });

  it("renders a subscription change as a plan and a seat count", () => {
    expect(
      describeApproval({
        toolName: "update_subscription",
        toolInput: {
          customer_id: "cust_123",
          new_plan: "pro",
          seats: 5,
          effective: "immediately",
        },
      }),
    ).toBe("Move cust_123 to pro, 5 seats");
  });

  it("falls back to the raw payload for a tool it has no sentence for", () => {
    expect(
      describeApproval({
        toolName: "delete_account",
        toolInput: { customer_id: "cust_9" },
      }),
    ).toBe('delete_account with {"customer_id":"cust_9"}');
  });

  it("falls back when a known tool's input is missing a field it needs", () => {
    expect(
      describeApproval({
        toolName: "issue_refund",
        toolInput: { invoice_id: "INV-2002", reason: "service_issue" },
      }),
    ).toBe('issue_refund with {"invoice_id":"INV-2002","reason":"service_issue"}');
  });
});
