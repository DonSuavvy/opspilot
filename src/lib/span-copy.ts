/**
 * One line saying what a span carried, for the row the reader opens.
 *
 * The trace already shows a span's name, its bar and its cost. What it could
 * not show was the *substance* — and for the guardrail spans the substance is
 * the whole feature. "injection_scan, 0ms" is a row; "Flagged: 5 signals,
 * withheld issue_refund and update_subscription" is demo arc step 4.
 *
 * Its own client-safe module for the same reason as `approval-copy.ts`: the
 * run console renders in the browser, and `summarizeGuardrail` in
 * `src/db/ops.ts` — which answers a nearby question for Mission Control —
 * cannot be imported here without dragging drizzle and fifteen table
 * definitions into the bundle to produce one sentence. The two are deliberately
 * not the same sentence anyway: Mission Control summarises a *stored* span in a
 * table cell, this names a live one the reader is about to expand.
 *
 * **Total, and never throwing.** Every branch reads `unknown` off the wire and
 * every one of them can fail, so each falls back to the span's own name. This
 * runs inside the streaming trace: a summary that threw on a shape a later
 * schema change started sending would take the console down mid-run, and the
 * thing lost would be the record of what the agent just did.
 */
import type { Span } from "@/lib/agent-stream";

/**
 * Pinned to `INJECTION_SCAN_SPAN` in `src/agent/guardrails.ts` and duplicated
 * rather than imported, because that module pulls the tool registry in behind
 * it. `span-copy.test.ts` imports the real constant and builds its spans from
 * it, so the two cannot drift without a test going red.
 */
const INJECTION_SCAN = "injection_scan";

/** The loop's own name for the pre-flight spend check. */
const BUDGET_GUARDRAIL = "budget";

/** Only the fields a summary reads. A full `Span` satisfies it. */
export type DescribableSpan = Pick<
  Span,
  "type" | "name" | "isError" | "input" | "output" | "usage"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Non-empty strings only — an array of numbers is not a list of tool names. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** `a`, `a and b`, `a, b and c` — read aloud, not printed as JSON. */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A span, as the sentence its summary row shows.
 *
 * Guardrails branch by name before they branch by error, because the budget
 * refusal is an error and the injection scan is not — and the generic
 * "refused by policy" line is for the third kind, a tool preflight, where the
 * span is named after the tool the policy engine turned down.
 */
export function describeSpan(span: DescribableSpan): string {
  const fallback = span.name;

  if (span.type === "guardrail") {
    if (span.name === INJECTION_SCAN) {
      const signals = stringList(asRecord(span.input)?.signals);
      const withheld = stringList(asRecord(span.output)?.restrictedTools);
      if (signals.length > 0 && withheld.length > 0) {
        const noun = signals.length === 1 ? "signal" : "signals";
        return `Flagged: ${signals.length} ${noun}, withheld ${joinWithAnd(withheld)}`;
      }
      return fallback;
    }

    const output = asRecord(span.output);

    if (span.name === BUDGET_GUARDRAIL && output?.allowed === false) {
      const reason = output.reason;
      // The raw reason, not a prettified one. `daily_cap_reached` is the
      // string in `BudgetDecision`, in the API's 402 body and in the logs;
      // rewriting it here would give the operator a phrase they cannot grep.
      if (typeof reason === "string" && reason.length > 0) {
        return `Budget refused: ${reason}`;
      }
      return fallback;
    }

    // A tool preflight. The span is named after the call the policy refused.
    if (span.isError) return `${span.name} refused by policy`;

    return fallback;
  }

  if (span.type === "approval_wait") {
    return span.name.length > 0
      ? `Waiting for approval: ${span.name}`
      : "Waiting for approval";
  }

  if (span.type === "llm_call") {
    const usage = span.usage;
    // The same `in/out tok` idiom the row's own cost column uses, so the
    // summary and the figure beside it cannot look like two measurements.
    return usage
      ? `${span.name} · ${usage.inputTokens}/${usage.outputTokens} tok`
      : fallback;
  }

  return span.isError ? `${span.name} (error)` : fallback;
}
