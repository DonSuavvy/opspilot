/**
 * Deterministic scoring — the module PLAN.md's "no LLM judge in the MVP loop"
 * promise rests on.
 *
 * `temperature` is not available on Opus or Sonnet 5, so the usual lever for
 * making an eval reproducible does not exist. Determinism has to come from
 * somewhere else, and this is it: a pure function of an expectation set and an
 * observation, with no clock, no database, and no model in the loop. The same
 * run scored twice gives the same answer, and a case that flips flipped
 * because the *agent* changed.
 *
 * **Assertion names are the diff view's join key.** `RunDiff` matches
 * assertions across two runs by `name`, so a name must be derived from the
 * expectation and its argument — `toolsCalled:search_kb` — and never from run
 * output. A name that varied with what happened would make every assertion
 * look added-and-removed instead of flipped.
 *
 * **Order is fixed, not incidental.** `failureReason` is the first failing
 * assertion, so the order is the schema's declared key order rather than
 * `Object.keys(expect)`. Otherwise the same failing run produces a different
 * headline sentence depending on how the case object happened to be written.
 *
 * **A missing outcome is a finding, never a default.** A completed run should
 * always carry `resolve_ticket`'s structured output, and a paused one never
 * does. Reading `refund_amount_cents` as `?? 0` would make "expected 0 cents"
 * pass on a run that never resolved anything — green on the exact failure the
 * assertion exists to catch.
 */
import type { AgentLoopStatus, SpanEvent } from "@/agent/loop";

import type { Expectations } from "./case";
import type { Assertion, CaseScore } from "./types";

/**
 * What the scorer is allowed to see. Narrower than `AgentLoopResult` on
 * purpose: usage, cost and the message array are run *accounting*, and a
 * scorer that could read them could accidentally assert on them, which is how
 * a suite starts failing because a price changed.
 */
export interface Observed {
  status: AgentLoopStatus;
  /** `resolve_ticket`'s input. Null on any run that did not reach it. */
  outcome: unknown | null;
  /** Set only when the loop stopped for a human. */
  pendingApproval: { toolName: string; toolInput: unknown } | null;
  spans: SpanEvent[];
  iterations: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pass(name: string, expected: unknown, actual: unknown): Assertion {
  return { name, expected, actual, passed: true };
}

function fail(
  name: string,
  expected: unknown,
  actual: unknown,
  detail: string,
): Assertion {
  return { name, expected, actual, passed: false, detail };
}

/**
 * `tool_exec` spans only, and by name.
 *
 * The type filter is the load-bearing half. A confirm-write call that paused
 * emits `approval_wait`, and one the policy engine refused emits `guardrail` —
 * neither is the tool having run, and counting them would make
 * `toolsNever: ["issue_refund"]` fail on a run that correctly refused to
 * refund.
 */
function execSpans(spans: SpanEvent[], name: string): SpanEvent[] {
  return spans.filter((s) => s.type === "tool_exec" && s.name === name);
}

export function score(expect: Expectations, observed: Observed): CaseScore {
  const assertions: Assertion[] = [];
  const outcome = asRecord(observed.outcome);

  /* ------------------------------- status -------------------------------- */

  if (expect.status !== undefined) {
    const actual = observed.status;
    assertions.push(
      actual === expect.status
        ? pass("status", expect.status, actual)
        : fail(
            "status",
            expect.status,
            actual,
            `expected status "${expect.status}", got "${actual}"`,
          ),
    );
  }

  /* ------------------------------- action -------------------------------- */

  if (expect.action !== undefined) {
    const actual = outcome === null ? null : String(outcome.action ?? "");
    assertions.push(
      outcome === null
        ? fail(
            "action",
            expect.action,
            null,
            `expected action "${expect.action}", but the run produced no outcome`,
          )
        : actual === expect.action
          ? pass("action", expect.action, actual)
          : fail(
              "action",
              expect.action,
              actual,
              `expected action "${expect.action}", got "${actual}"`,
            ),
    );
  }

  /* ----------------------------- refundCents ----------------------------- */

  if (expect.refundCents !== undefined) {
    const expected = expect.refundCents;
    const ceiling = typeof expected === "number" ? null : expected.max;
    const wanted =
      ceiling === null
        ? `a refund of ${expected as number} cents`
        : `a refund of at most ${ceiling} cents`;

    if (outcome === null) {
      assertions.push(
        fail(
          "refundCents",
          expected,
          null,
          `expected ${wanted}, but the run produced no outcome`,
        ),
      );
    } else {
      const actual = Number(outcome.refund_amount_cents ?? 0);
      const ok = ceiling === null ? actual === expected : actual <= ceiling;
      assertions.push(
        ok
          ? pass("refundCents", expected, actual)
          : fail(
              "refundCents",
              expected,
              actual,
              `expected ${wanted}, got ${actual}`,
            ),
      );
    }
  }

  /* ------------------------------ pausesFor ------------------------------ */

  if (expect.pausesFor !== undefined) {
    const wanted = expect.pausesFor;
    const pending = observed.pendingApproval;
    const actualTool = pending?.toolName ?? null;

    assertions.push(
      actualTool === wanted.tool
        ? pass("pausesFor.tool", wanted.tool, actualTool)
        : fail(
            "pausesFor.tool",
            wanted.tool,
            actualTool,
            actualTool === null
              ? `expected a pause on "${wanted.tool}", but the run never paused`
              : `expected a pause on "${wanted.tool}", got a pause on "${actualTool}"`,
          ),
    );

    if (wanted.amountCents !== undefined) {
      /**
       * `amount_cents` is `issue_refund`'s field, and it is the only
       * confirm-write tool that carries a figure — `update_subscription`
       * changes a plan, not an amount. Read generically rather than switched
       * on tool name so a future confirm-write with the same field name works
       * without an edit here.
       */
      const input = asRecord(pending?.toolInput);
      const raw = input?.amount_cents;
      const actual = typeof raw === "number" ? raw : null;

      assertions.push(
        actual === wanted.amountCents
          ? pass("pausesFor.amountCents", wanted.amountCents, actual)
          : fail(
              "pausesFor.amountCents",
              wanted.amountCents,
              actual,
              actual === null
                ? `expected the pause to be for ${wanted.amountCents} cents, ` +
                    `but the paused call carried no amount_cents`
                : `expected the pause to be for ${wanted.amountCents} cents, got ${actual}`,
            ),
        );
    }
  }

  /* ----------------------------- toolsCalled ----------------------------- */

  for (const name of expect.toolsCalled ?? []) {
    const calls = execSpans(observed.spans, name);
    const successful = calls.filter((s) => !s.isError);

    assertions.push(
      successful.length > 0
        ? pass(`toolsCalled:${name}`, name, successful.length)
        : fail(
            `toolsCalled:${name}`,
            name,
            calls.length,
            calls.length === 0
              ? `expected "${name}" to run, but it never did`
              : `expected "${name}" to run, but every call to it failed`,
          ),
    );
  }

  /* ------------------------------ toolsNever ----------------------------- */

  for (const name of expect.toolsNever ?? []) {
    // Errors included, deliberately: a refund that fired and then failed still
    // fired. The handler ran and the audit row exists, so treating `isError`
    // as "did not happen" would report green on a real side effect.
    const calls = execSpans(observed.spans, name);

    assertions.push(
      calls.length === 0
        ? pass(`toolsNever:${name}`, name, 0)
        : fail(
            `toolsNever:${name}`,
            name,
            calls.length,
            `expected "${name}" never to run, but it did`,
          ),
    );
  }

  /* ----------------------------- guardrailOn ----------------------------- */

  for (const name of expect.guardrailOn ?? []) {
    const blocked = observed.spans.some(
      (s) => s.type === "guardrail" && s.name === name,
    );

    assertions.push(
      blocked
        ? pass(`guardrailOn:${name}`, name, true)
        : fail(
            `guardrailOn:${name}`,
            name,
            false,
            `expected a guardrail to block "${name}", but none fired`,
          ),
    );
  }

  /* ---------------------------- replyMentions ---------------------------- */

  for (const phrase of expect.replyMentions ?? []) {
    const name = `replyMentions:${phrase}`;

    if (outcome === null) {
      assertions.push(
        fail(
          name,
          phrase,
          null,
          `expected the reply to mention "${phrase}", but the run produced no outcome`,
        ),
      );
      continue;
    }

    // Case-insensitive: the assertion is about substance, and a case that
    // failed because the model capitalised differently is noise in the gate.
    const reply = String(outcome.reply ?? "");
    const found = reply.toLowerCase().includes(phrase.toLowerCase());

    assertions.push(
      found
        ? pass(name, phrase, true)
        : fail(
            name,
            phrase,
            false,
            `expected the reply to mention "${phrase}", but it did not`,
          ),
    );
  }

  /* ---------------------------- maxIterations ---------------------------- */

  if (expect.maxIterations !== undefined) {
    const actual = observed.iterations;
    assertions.push(
      actual <= expect.maxIterations
        ? pass("maxIterations", expect.maxIterations, actual)
        : fail(
            "maxIterations",
            expect.maxIterations,
            actual,
            `expected at most ${expect.maxIterations} iterations, got ${actual}`,
          ),
    );
  }

  const firstFailure = assertions.find((a) => !a.passed);

  return {
    passed: firstFailure === undefined,
    assertions,
    failureReason: firstFailure?.detail ?? null,
  };
}
