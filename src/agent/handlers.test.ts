import { describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY } from "@/policy/refund";

import { NotImplementedError, TOOLS } from "./tools";
import { buildRegistry, type ToolContext } from "./registry";
import type { OpsData } from "./data";

/**
 * The tool handlers.
 *
 * These are the nine tools' bodies — the half that was deliberately absent on
 * Day 1, when only schemas, safety classes and boot validation existed.
 *
 * **Why they take a repository rather than a database.** `npm test` must never
 * need Postgres, and that rule is what keeps CI green without a service
 * container. So handlers depend on `OpsData`, a narrow interface over exactly
 * the reads and writes the tools perform, and the tests hand them a fake. It
 * is the same seam the agent loop uses for the Anthropic client, for the same
 * reason: the interesting logic is in the handler, and the part that needs a
 * network or a socket belongs on the other side of a boundary.
 *
 * **`OpsData` is workspace-bound by construction.** No method takes a
 * workspace id, because the production implementation closes over one. A
 * handler therefore cannot read across the sandbox boundary by forgetting a
 * `where` clause — the type does not let it express the mistake. Day 8 gives
 * every demo visitor their own workspace, and that is exactly when a forgotten
 * scope stops being theoretical.
 *
 * **Two handlers stay stubs on purpose.** `issue_refund` and
 * `update_subscription` are `confirm_write`, so the loop pauses *before*
 * calling them and hands the tool call to the approval queue. Their bodies run
 * on resume, which is Day 5's gate. Implementing them now would mean shipping
 * code no path reaches.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CUSTOMER = {
  externalId: "cus_0007",
  name: "Tobias Fell",
  email: "tobias@northwind.example",
  company: "Northwind Data",
  lifetimeValueCents: 148_800,
};

const INVOICE = {
  number: "INV-2002",
  status: "paid" as const,
  amountCents: 29_900,
  refundedCents: 0,
  paidAt: new Date("2026-07-22T00:00:00Z"),
  description: "Scale plan — monthly",
};

function fakeData(over: Partial<OpsData> = {}): OpsData {
  return {
    findCustomer: vi.fn(async () => CUSTOMER),
    getSubscription: vi.fn(async () => ({
      plan: "scale" as const,
      status: "active",
      seats: 12,
      monthlyPriceCents: 29_900,
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    })),
    listInvoices: vi.fn(async () => [INVOICE]),
    findInvoice: vi.fn(async () => INVOICE),
    searchKb: vi.fn(async () => [
      { slug: "rotate-api-key", title: "Rotating an API key", body: "…", rank: 0.9 },
    ]),
    saveDraft: vi.fn(async () => ({ draftId: "draft_1" })),
    escalateTicket: vi.fn(async () => ({ ticketId: "tkt_1", status: "escalated" })),
    resolveTicket: vi.fn(async () => ({ ticketId: "tkt_1", status: "resolved" })),
    recordRefund: vi.fn(async () => ({
      refundedCents: 0,
      status: "partially_refunded",
      duplicate: false,
    })),
    ...over,
  };
}

function ctx(data: OpsData): ToolContext {
  return {
    workspaceId: "ws_demo",
    runId: "run_1",
    ticketId: "tkt_1",
    now: new Date("2026-08-13T00:00:00Z"),
    data,
    policyConfig: DEFAULT_POLICY,
  };
}

const registry = buildRegistry(TOOLS);

function call(name: string, input: unknown, data: OpsData) {
  return registry.get(name)!.handler(input as never, ctx(data));
}

/* -------------------------------------------------------------------------- */
/* Read tools                                                                 */
/* -------------------------------------------------------------------------- */

describe("read handlers", () => {
  it("get_customer returns the customer the repository found", async () => {
    const data = fakeData();
    const out = await call("get_customer", { query: "cus_0007" }, data);

    expect(data.findCustomer).toHaveBeenCalledWith("cus_0007");
    expect(out).toMatchObject({ found: true, customer: { externalId: "cus_0007" } });
  });

  /**
   * A customer who cannot be found is a *business* outcome, not a tool
   * failure. The policy engine has an `unknown_customer` escalation reason and
   * the SOP tells the agent to escalate on it — which it can only do if it
   * gets a readable answer back. Throwing would surface as `is_error`, which
   * reads to the model as "the tool is broken, try something else".
   */
  it("get_customer reports a miss as data rather than throwing", async () => {
    const data = fakeData({ findCustomer: vi.fn(async () => null) });
    const out = await call("get_customer", { query: "nobody@example.com" }, data);

    expect(out).toMatchObject({ found: false });
    expect(out).not.toHaveProperty("customer.externalId");
  });

  /**
   * The period end is serialized for the same reason `paidAt` is: the model
   * sees JSON, and a `Date` that has been through `JSON.stringify` is only
   * accidentally readable. Asserted explicitly because mutation testing caught
   * this one unpinned — the invoice handler's `paidAt` had a test and this did
   * not, so dropping the conversion here changed nothing that any test noticed.
   */
  it("get_subscription returns the plan and serializes the period end", async () => {
    const data = fakeData();
    const out = (await call(
      "get_subscription",
      { customer_id: "cus_0007" },
      data,
    )) as { subscription: { currentPeriodEnd: string } };

    expect(data.getSubscription).toHaveBeenCalledWith("cus_0007");
    expect(out).toMatchObject({ found: true, subscription: { plan: "scale", seats: 12 } });
    expect(out.subscription.currentPeriodEnd).toBe("2026-09-01T00:00:00.000Z");
  });

  it("get_subscription reports a miss as data rather than throwing", async () => {
    const data = fakeData({ getSubscription: vi.fn(async () => null) });
    const out = await call("get_subscription", { customer_id: "cus_0007" }, data);

    expect(out).toMatchObject({ found: false });
  });

  /**
   * The refund window is measured from `paidAt`, so an invoice that reaches
   * the model without one cannot be reasoned about. Passing the field through
   * as an ISO string keeps it readable in the trace viewer and unambiguous to
   * the model, which sees JSON rather than a Date.
   */
  it("get_invoices passes the model's limit through and serializes paidAt", async () => {
    const data = fakeData();
    const out = (await call(
      "get_invoices",
      { customer_id: "cus_0007", limit: 12 },
      data,
    )) as { invoices: { number: string; paidAt: string }[] };

    expect(data.listInvoices).toHaveBeenCalledWith("cus_0007", 12);
    expect(out.invoices[0]!.number).toBe("INV-2002");
    expect(out.invoices[0]!.paidAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("get_invoices returns an empty list rather than failing when there are none", async () => {
    const data = fakeData({ listInvoices: vi.fn(async () => []) });
    const out = await call("get_invoices", { customer_id: "cus_0007", limit: 12 }, data);

    expect(out).toMatchObject({ invoices: [] });
  });

  it("search_kb returns ranked articles for the query", async () => {
    const data = fakeData();
    const out = (await call("search_kb", { query: "rotate api key" }, data)) as {
      articles: { slug: string }[];
    };

    expect(data.searchKb).toHaveBeenCalledWith("rotate api key");
    expect(out.articles[0]!.slug).toBe("rotate-api-key");
  });

  /**
   * An empty corpus hit is the case that makes the agent hallucinate if it is
   * reported as an error, because the model then retries with different terms
   * instead of concluding the KB has nothing. Say so plainly.
   */
  it("search_kb says it found nothing rather than erroring", async () => {
    const data = fakeData({ searchKb: vi.fn(async () => []) });
    const out = await call("search_kb", { query: "quantum tunnelling" }, data);

    expect(out).toMatchObject({ articles: [], found: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* Auto-write tools                                                           */
/* -------------------------------------------------------------------------- */

describe("auto-write handlers", () => {
  it("draft_reply stores the draft and returns its id", async () => {
    const data = fakeData();
    const out = await call(
      "draft_reply",
      { ticket_id: "tkt_1", body: "We've refunded INV-2002." },
      data,
    );

    expect(data.saveDraft).toHaveBeenCalledWith("tkt_1", "We've refunded INV-2002.");
    expect(out).toMatchObject({ draftId: "draft_1" });
  });

  it("escalate hands the ticket over with its reason and summary", async () => {
    const data = fakeData();
    const out = await call(
      "escalate",
      {
        ticket_id: "tkt_1",
        reason: "refund_denied_by_policy",
        summary: "Outside the 14-day window.",
      },
      data,
    );

    expect(data.escalateTicket).toHaveBeenCalledWith(
      "tkt_1",
      "refund_denied_by_policy",
      "Outside the 14-day window.",
    );
    expect(out).toMatchObject({ status: "escalated" });
  });

  /**
   * `resolve_ticket` is the forced terminal tool and the eval scorers read its
   * output, so the handler must persist the *whole* structured outcome rather
   * than a status flag. A scorer that cannot see `refund_amount_cents` cannot
   * tell an approved refund from a denied one.
   *
   * Note what is *not* in its schema: a ticket id. The run already knows which
   * ticket it is about, so the terminal tool takes it from the context rather
   * than from model output — the model cannot close a ticket it was not
   * dispatched for.
   */
  it("resolve_ticket persists the full structured outcome against the run's ticket", async () => {
    const data = fakeData();
    const outcome = {
      action: "refunded",
      refund_amount_cents: 29_900,
      reply: "Refunded in full.",
      confidence: "high",
    };

    const out = await call("resolve_ticket", outcome, data);

    expect(data.resolveTicket).toHaveBeenCalledWith("tkt_1", outcome);
    expect(out).toMatchObject({ status: "resolved" });
  });
});

/* -------------------------------------------------------------------------- */
/* Still gated                                                                */
/* -------------------------------------------------------------------------- */

describe("confirm-write handlers stay unimplemented until resume exists", () => {
  /**
   * `issue_refund` left this list on Day 5. Its body is the policy
   * revalidation — the second of the two enforcement points — and it is
   * reachable and tested independently of the approval queue, because rejecting
   * an out-of-policy call has to happen *before* anything is queued for a human
   * to approve. See `refund-handler.test.ts`, and FAILURES #21 for why the
   * prompt alone was not enough.
   *
   * `update_subscription` stays stubbed for the original reason: the loop pauses
   * on a confirm-write call and never invokes the handler, so a body written now
   * would be unreachable through any real path and would read as shipped
   * capability.
   */
  it.each(["update_subscription"])(
    "%s still throws NotImplementedError",
    async (name) => {
      await expect(call(name, {}, fakeData())).rejects.toBeInstanceOf(
        NotImplementedError,
      );
    },
  );

  it("both of them are the confirm-write pair, so the loop pauses first", () => {
    expect(registry.requiresApproval("issue_refund")).toBe(true);
    expect(registry.requiresApproval("update_subscription")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

describe("workspace scoping", () => {
  /**
   * The invariant that keeps Day 8's per-visitor sandboxes from leaking into
   * each other: no `OpsData` method accepts a workspace id, so a handler
   * cannot pass the wrong one or forget it. Scope is bound where the
   * repository is built, once, instead of at every call site.
   *
   * Asserted against the arguments the handlers actually pass, so a method
   * that grows a workspace parameter later fails here.
   */
  it("no handler passes a workspace id to the repository", async () => {
    const data = fakeData();
    await call("get_customer", { query: "cus_0007" }, data);
    await call("get_subscription", { customer_id: "cus_0007" }, data);
    await call("get_invoices", { customer_id: "cus_0007", limit: 12 }, data);
    await call("search_kb", { query: "refund" }, data);

    const everyArg = [
      data.findCustomer,
      data.getSubscription,
      data.listInvoices,
      data.searchKb,
    ].flatMap((fn) => vi.mocked(fn).mock.calls.flat());

    expect(everyArg).not.toContain("ws_demo");
  });
});
