/**
 * The eval suite's write barrier.
 *
 * An eval case has to run against the *real* workspace to be worth anything —
 * the same customers, the same invoice ages, the same KB the demo uses. Run
 * against fixtures it would prove that the fixtures are consistent, which
 * nobody is asking about. But the agent's job ends in writes: it refunds
 * INV-2001, escalates a ticket, resolves it. Eight cases a day against the
 * seeded inbox and demo arc step 1 has nothing left to resolve, `INV-2002` is
 * already refunded, and `verify:seed` goes red for a reason that looks like a
 * seeding bug.
 *
 * So reads go through and writes stop here, recorded rather than performed.
 * The scorer reads spans and the terminal outcome, neither of which needs the
 * write to have landed, and `writes` is available to any caller that wants to
 * assert on side effects directly.
 *
 * **The canned answers are plausible on purpose.** They are tool results, and
 * the agent reads them before deciding what to do next. A refund answered with
 * `refundedCents: 0` reads as a partial failure and pushes the model into
 * retrying or escalating — the case would then score a behaviour this wrapper
 * invented rather than one the SOP produced.
 *
 * **One read is not passed through as it is: an invoice's refund state.** The
 * barrier keeps the suite from changing the sandbox, and for months nothing
 * kept the sandbox from changing the suite. A visitor who approved the
 * INV-2001 refund in the inbox and then ran the suite got `refund-in-window`
 * red, because the agent read `refundedCents: 4900` and rightly did not refund
 * it twice. Haiku 4.5 hid this by asking for the refund without reading the
 * balance. Every case is written against the seeded scenario, and the seed
 * refunds nothing, so an eval read shows each invoice unrefunded and `paid`.
 * The SOP is still the visitor's own, which is the thing the suite is for.
 *
 * This is *not* the guarantee that keeps money still — that is the approval
 * pause, which stops `issue_refund` before dispatch in every case here. This
 * is the second layer, for the resumed and auto-write paths where nothing
 * pauses.
 */
import type { InvoiceRecord, OpsData, TicketOutcome } from "@/agent/data";

export type RecordedWriteMethod =
  | "saveDraft"
  | "escalateTicket"
  | "resolveTicket"
  | "recordRefund";

export interface RecordedWrite {
  method: RecordedWriteMethod;
  args: unknown[];
}

export interface RecordedWrites {
  data: OpsData;
  /** In call order. The same array the wrapper appends to, not a copy. */
  writes: RecordedWrite[];
}

/**
 * An invoice as the seed wrote it: nothing refunded, and so `paid`.
 *
 * Only a paid invoice can be refunded, so any refunded amount means the row
 * was `paid` when it was seeded. An invoice nobody refunded is returned as the
 * same object, whatever its status.
 */
function asSeeded(invoice: InvoiceRecord): InvoiceRecord {
  return invoice.refundedCents > 0
    ? { ...invoice, refundedCents: 0, status: "paid" }
    : invoice;
}

export function withRecordedWrites(real: OpsData): RecordedWrites {
  const writes: RecordedWrite[] = [];
  let drafts = 0;

  const record = (method: RecordedWriteMethod, args: unknown[]) => {
    writes.push({ method, args });
  };

  const data: OpsData = {
    /* --------------------------- reads: through -------------------------- */
    findCustomer: (query) => real.findCustomer(query),
    getSubscription: (customerExternalId) =>
      real.getSubscription(customerExternalId),
    listInvoices: async (customerExternalId, limit) =>
      (await real.listInvoices(customerExternalId, limit)).map(asSeeded),
    findInvoice: async (number) => {
      const invoice = await real.findInvoice(number);
      return invoice === null ? null : asSeeded(invoice);
    },
    searchKb: (query) => real.searchKb(query),

    /* -------------------------- writes: recorded ------------------------- */
    saveDraft: async (ticketId: string, body: string) => {
      record("saveDraft", [ticketId, body]);
      // Distinct per call: the model may draft twice in one run, and two
      // results with the same id read as "the second one did not save".
      drafts += 1;
      return { draftId: `eval_draft_${drafts}` };
    },

    escalateTicket: async (ticketId: string, reason: string, summary: string) => {
      record("escalateTicket", [ticketId, reason, summary]);
      return { ticketId, status: "escalated" };
    },

    resolveTicket: async (ticketId: string, outcome: TicketOutcome) => {
      record("resolveTicket", [ticketId, outcome]);
      return { ticketId, status: "resolved" };
    },

    recordRefund: async (input) => {
      record("recordRefund", [input]);
      // The amount that was asked for, in full and not a duplicate — the
      // answer a healthy refund gives, so the agent proceeds to resolve
      // rather than adapting to a failure this wrapper manufactured.
      return {
        refundedCents: input.amountCents,
        status: "refunded",
        duplicate: false,
      };
    },
  };

  return { data, writes };
}
