import { describe, expect, it } from "vitest";

import { toResumeDecisions, type ApprovalRow } from "./approvals";

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
