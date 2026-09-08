/**
 * What the approvals queue says about a call nobody has answered yet.
 *
 * Its own module, away from `src/db/approvals.ts`, for one reason: the run
 * console is a client component and renders this in the browser. Importing it
 * from the DB module would drag `drizzle-orm` and all fifteen table
 * definitions into the client bundle to produce one sentence — the tables are
 * constructed at import, so nothing tree-shakes them away. `src/db/approvals`
 * re-exports it, so every server-side caller is unaffected.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One sentence naming what a reviewer is being asked to approve.
 *
 * The two confirm-write tools get a sentence each; anything else renders its
 * raw payload. The fallback is the deliberate part. A summary is only ever as
 * true as the fields it read, so a tenth tool added later shows ugly JSON —
 * which reads as a prompt to write it a sentence — rather than a confident
 * line about a call nobody described. The same reasoning covers a known tool
 * whose input is missing a field the sentence needs: the payload is shown
 * whole instead of a sentence with a hole in it.
 *
 * Pure, and pure on purpose: it renders on the server for the queue page and
 * in the browser for the run console, from the `tool_input` the model sent.
 */
export function describeApproval(input: {
  toolName: string;
  toolInput: unknown;
}): string {
  const fields = asRecord(input.toolInput);

  if (fields && input.toolName === "issue_refund") {
    const { invoice_id: invoice, amount_cents: cents, reason } = fields;
    // `typeof`, not truthiness: a zero amount is a real value the reviewer
    // should see, and an absent one is what "missing a field" means.
    if (
      typeof invoice === "string" &&
      typeof cents === "number" &&
      typeof reason === "string"
    ) {
      return `Refund $${(cents / 100).toFixed(2)} against ${invoice} (${reason})`;
    }
  }

  if (fields && input.toolName === "update_subscription") {
    const { customer_id: customer, new_plan: plan, seats } = fields;
    if (
      typeof customer === "string" &&
      typeof plan === "string" &&
      typeof seats === "number"
    ) {
      return `Move ${customer} to ${plan}, ${seats} seats`;
    }
  }

  return `${input.toolName} with ${JSON.stringify(input.toolInput)}`;
}
