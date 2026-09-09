import { describe, expect, it, vi } from "vitest";

import type { InvoiceRecord, OpsData } from "@/agent/data";
import { rateCard } from "@/agent/cost";
import {
  type AssistantTurn,
  type ContentBlock,
  type MessageCreator,
} from "@/agent/loop";
import { buildRegistry } from "@/agent/registry";
import { TOOLS } from "@/agent/tools";
import { DEFAULT_POLICY } from "@/policy/refund";

import type { EvalCase } from "./case";
import { runCase, type RunCaseDeps } from "./runner";

/**
 * One case, end to end, against a scripted model.
 *
 * This is the seam that makes the Eval Lab testable at all: `runCase` is the
 * only place the loop, the write barrier and the scorer meet, and all three of
 * its collaborators are injected. No key, no Postgres, no cost.
 */

const NOW = new Date("2026-09-08T12:00:00.000Z");

/** Paid 5 days before NOW: inside every window the policy has ever had. */
const INV_2001: InvoiceRecord = {
  number: "INV-2001",
  status: "paid",
  amountCents: 4_900,
  refundedCents: 0,
  paidAt: new Date("2026-09-03T12:00:00.000Z"),
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
    listInvoices: vi.fn(async () => [INV_2001]),
    findInvoice: vi.fn(async () => INV_2001),
    searchKb: vi.fn(async () => []),
    saveDraft: vi.fn(async () => ({ draftId: "real_draft" })),
    escalateTicket: vi.fn(async () => ({ ticketId: "real", status: "escalated" })),
    resolveTicket: vi.fn(async () => ({ ticketId: "real", status: "resolved" })),
    recordRefund: vi.fn(async () => ({
      refundedCents: 4_900,
      status: "refunded",
      duplicate: false,
    })),
  };
}

function toolUse(name: string, input: unknown) {
  return { type: "tool_use" as const, id: `toolu_${name}`, name, input };
}

function turn(content: ContentBlock[]): AssistantTurn {
  return {
    content,
    stop_reason: "tool_use",
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function scripted(turns: AssistantTurn[]) {
  const calls: Parameters<MessageCreator>[0][] = [];
  const create: MessageCreator = vi.fn(async (params) => {
    calls.push(structuredClone(params));
    const next = turns.shift();
    if (!next) throw new Error("scripted client ran out of turns");
    return next;
  });
  return { create, calls };
}

const CASE: EvalCase = {
  slug: "refund-in-window",
  title: "Refund inside the window",
  description: "",
  ticket: {
    customer: "cus_0001",
    subject: "Please refund last week's charge",
    body: "We were billed on INV-2001 and would like it back.",
  },
  expect: {
    status: "paused_for_approval",
    pausesFor: { tool: "issue_refund", amountCents: 4_900 },
    toolsCalled: ["get_invoices"],
  },
  tags: [],
  enabled: true,
};

function deps(
  createMessage: MessageCreator,
  data: OpsData,
  over: Partial<RunCaseDeps> = {},
): RunCaseDeps {
  return {
    registry: buildRegistry(TOOLS),
    createMessage,
    model: "test-model",
    rates: rateCard(1, 5, { verifiedOn: "2026-08-13", source: "test" }),
    system: "You are a support agent.",
    policyConfig: DEFAULT_POLICY,
    data,
    workspaceId: "ws_demo",
    runId: "run_1",
    now: NOW,
    budget: {
      config: {
        dailyCapNanos: 5_000_000_000,
        killSwitch: false,
        runsPerMinute: 10,
      },
      spentTodayNanos: 0,
    },
    estimatedCallNanos: 20_000_000,
    clock: () => NOW,
    ...over,
  };
}

/** The script that behaves: read the invoice, then ask to refund it. */
function refundScript() {
  return scripted([
    turn([toolUse("get_invoices", { customer_id: "cus_0001", limit: 12 })]),
    turn([
      toolUse("issue_refund", {
        invoice_id: "INV-2001",
        amount_cents: 4_900,
        reason: "service_issue",
        idempotency_key: "refund-in-window-INV-2001",
      }),
    ]),
  ]);
}

describe("runCase", () => {
  it("scores a pause as passing when the script asks for the refund", async () => {
    const data = realData();
    const { create } = refundScript();

    const outcome = await runCase(CASE, deps(create, data));

    expect(outcome.result.status).toBe("paused_for_approval");
    expect(outcome.score.passed).toBe(true);
    expect(outcome.score.failureReason).toBeNull();
    expect(outcome.score.assertions.map((a) => a.name)).toEqual([
      "status",
      "pausesFor.tool",
      "pausesFor.amountCents",
      "toolsCalled:get_invoices",
    ]);
  });

  it("fails with the sentence naming the terminal state, when the script escalates instead", async () => {
    const data = realData();
    const { create } = scripted([
      turn([
        toolUse("escalate", {
          ticket_id: "refund-in-window",
          reason: "policy_denial",
          summary: "not sure",
        }),
      ]),
      turn([
        toolUse("resolve_ticket", {
          action: "escalated",
          refund_amount_cents: 0,
          reply: "A colleague will follow up.",
          confidence: "medium",
        }),
      ]),
    ]);

    const outcome = await runCase(CASE, deps(create, data));

    expect(outcome.result.status).toBe("completed");
    expect(outcome.score.passed).toBe(false);
    expect(outcome.score.failureReason).toBe(
      'expected status "paused_for_approval", got "completed"',
    );
  });

  /**
   * The barrier is inside `runCase`, not the caller's job to remember. A
   * suite that had to wrap `data` itself would work until the day someone
   * added a second call site.
   */
  it("never lets a write reach the real seam, and reports what was attempted", async () => {
    const data = realData();
    const { create } = scripted([
      turn([
        toolUse("escalate", {
          ticket_id: "refund-in-window",
          reason: "unknown_customer",
          summary: "no account named",
        }),
      ]),
      turn([
        toolUse("resolve_ticket", {
          action: "escalated",
          refund_amount_cents: 0,
          reply: "Escalated.",
          confidence: "low",
        }),
      ]),
    ]);

    const outcome = await runCase(CASE, deps(create, data));

    expect(data.escalateTicket).not.toHaveBeenCalled();
    expect(data.resolveTicket).not.toHaveBeenCalled();
    expect(outcome.writes.map((w) => w.method)).toEqual([
      "escalateTicket",
      "resolveTicket",
    ]);
  });

  it("still lets reads through to the real seam", async () => {
    const data = realData();
    const { create } = refundScript();

    await runCase(CASE, deps(create, data));

    expect(data.listInvoices).toHaveBeenCalledWith("cus_0001", 12);
  });

  /**
   * Same shape as `/api/agent/run`'s opening message, with the slug standing
   * in for the ticket id — a case is not a row in `tickets`. If these two
   * drift, an eval measures a prompt the demo never sends.
   */
  it("builds the opening message the run route builds", async () => {
    const { create, calls } = refundScript();

    await runCase(CASE, deps(create, realData()));

    expect(calls[0]!.messages).toEqual([
      {
        role: "user",
        content:
          "Ticket refund-in-window\n" +
          "Subject: Please refund last week's charge\n" +
          "Customer: cus_0001\n" +
          "\n<ticket_body>\n" +
          "We were billed on INV-2001 and would like it back.\n" +
          "</ticket_body>",
      },
    ]);
  });

  it("omits the customer line when the case has no customer", async () => {
    const { create, calls } = scripted([
      turn([
        toolUse("resolve_ticket", {
          action: "escalated",
          refund_amount_cents: 0,
          reply: "Escalated.",
          confidence: "low",
        }),
      ]),
    ]);

    await runCase(
      { ...CASE, slug: "missing-info", ticket: { ...CASE.ticket, customer: null } },
      deps(create, realData()),
    );

    expect(calls[0]!.messages[0]!.content).toBe(
      "Ticket missing-info\n" +
        "Subject: Please refund last week's charge\n" +
        "\n<ticket_body>\n" +
        "We were billed on INV-2001 and would like it back.\n" +
        "</ticket_body>",
    );
  });

  it("collects every span and forwards them to an optional emit", async () => {
    const emit = vi.fn();
    const { create } = refundScript();

    const outcome = await runCase(
      CASE,
      deps(create, realData(), { emit }),
    );

    expect(outcome.spans.length).toBeGreaterThan(0);
    expect(emit).toHaveBeenCalledTimes(outcome.spans.length);
    expect(outcome.spans.map((s) => s.seq)).toEqual(
      outcome.spans.map((_, i) => i),
    );
  });
});
