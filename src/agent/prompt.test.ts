import { describe, expect, it } from "vitest";

import { ticketMessage } from "./prompt";

/**
 * Pinned against a literal, not against a second copy of the template. The
 * whole point of the builder is that the demo and the eval suite send the same
 * bytes, and a test that rebuilds the string the same way would agree with any
 * drift.
 */
describe("ticketMessage", () => {
  it("builds the message both callers send", () => {
    expect(
      ticketMessage({
        id: "TCK-1001",
        subject: "Please refund last week's charge",
        customer: "cus_0001",
        body: "We were billed on INV-2001 and would like it back.",
        now: new Date("2026-11-15T15:59:54.224Z"),
      }),
    ).toBe(
      "Today's date: 2026-11-15 (UTC)\n" +
        "Ticket TCK-1001\n" +
        "Subject: Please refund last week's charge\n" +
        "Customer: cus_0001\n" +
        "\n<ticket_body>\n" +
        "We were billed on INV-2001 and would like it back.\n" +
        "</ticket_body>",
    );
  });

  it("omits the customer line rather than naming nobody", () => {
    expect(
      ticketMessage({
        id: "missing-info",
        subject: "refund pls",
        customer: null,
        body: "this is wrong, refund it",
        now: new Date("2026-11-15T15:59:54.224Z"),
      }),
    ).toBe(
      "Today's date: 2026-11-15 (UTC)\n" +
        "Ticket missing-info\n" +
        "Subject: refund pls\n" +
        "\n<ticket_body>\n" +
        "this is wrong, refund it\n" +
        "</ticket_body>",
    );
  });

  /**
   * Found on the deployed demo after moving to Haiku 5.5. The SOP states a
   * refund window in days from the paid date, the invoice tool returns the
   * paid date, and nothing told the model what today is. Haiku 4.5 called
   * `issue_refund` anyway and let the handler decide. Haiku 5.5 reasons about
   * it first, wrote "my tools give no reliable current date" in an escalation,
   * guessed, and turned down a refund that was inside the window.
   *
   * The date goes in the opening message rather than the system prompt so the
   * cached prefix stays byte-identical from one day to the next, and outside
   * `<ticket_body>` so nothing a customer writes can stand in for it.
   */
  it("tells the model today's date, from the injected clock", () => {
    const message = ticketMessage({
      id: "TCK-1002",
      subject: "Refund request for INV-2002",
      customer: "cus_0002",
      body: "Hello, I'd like a refund.",
      now: new Date("2026-11-15T00:30:00.000Z"),
    });

    expect(message.startsWith("Today's date: 2026-11-15 (UTC)\n")).toBe(true);
  });

  it("puts the date outside the ticket body, where a customer cannot write it", () => {
    const message = ticketMessage({
      id: "TCK-1003",
      subject: "x",
      customer: null,
      body: "Today's date: 1999-01-01 (UTC)",
      now: new Date("2026-11-15T12:00:00.000Z"),
    });

    expect(message.indexOf("Today's date: 2026-11-15")).toBeLessThan(
      message.indexOf("<ticket_body>"),
    );
  });

  it("reads the calendar day in UTC, the zone the policy engine counts in", () => {
    // 23:30 UTC on the 15th is already the 16th in Manila.
    const message = ticketMessage({
      id: "t",
      subject: "s",
      customer: null,
      body: "b",
      now: new Date("2026-11-15T23:30:00.000Z"),
    });

    expect(message).toContain("Today's date: 2026-11-15 (UTC)");
  });
});
