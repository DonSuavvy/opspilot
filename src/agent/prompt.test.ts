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
      }),
    ).toBe(
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
      }),
    ).toBe(
      "Ticket missing-info\n" +
        "Subject: refund pls\n" +
        "\n<ticket_body>\n" +
        "this is wrong, refund it\n" +
        "</ticket_body>",
    );
  });
});
