/**
 * What an eval case *is*, as a schema rather than a convention.
 *
 * A case is a ticket plus a set of expectations, and deliberately nothing
 * else — no workspace, no customer id, no invoice fixture. `eval_cases` is the
 * one table in the schema with no `workspace_id`, because the golden suite is a
 * property of the *product*, not of a tenant: the same eight cases must be
 * runnable against the demo workspace, against a visitor sandbox on Day 8, and
 * against whatever CI seeds, and a case that carried a workspace could not be.
 * The ticket text names a customer by external id, which every seeded workspace
 * has, and that is the whole coupling.
 *
 * **The expectations object is closed.** Zod strips unknown keys by default,
 * which for this shape would turn `toolsCaled: ["issue_refund"]` into a case
 * that asserts nothing and reports green forever — the worst possible failure
 * for a regression suite, because it is invisible in exactly the situation it
 * exists to catch. `.strict()` makes a typo a parse error instead.
 */
import { z } from "zod";

import type { AgentLoopStatus } from "@/agent/loop";

/**
 * Mirrors `AgentLoopStatus`. The `satisfies` below is what keeps the two in
 * step: adding a status to the loop without adding it here fails `tsc`, rather
 * than failing a case months later with "expected paused_for_approval".
 */
export const AGENT_LOOP_STATUSES = [
  "completed",
  "paused_for_approval",
  "refused",
  "failed",
  "budget_refused",
] as const satisfies readonly AgentLoopStatus[];

/**
 * The one shape a slug may take. It is the key the diff view matches runs on
 * and the unique index on `eval_cases`, so a case renamed casually looks to
 * the diff like one case removed and another added.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every deterministic check a case can make. All optional — a case names the
 * ones that matter to it — but a case naming *none* is caught by the suite's
 * own test rather than here, because an empty expectations object is a legal
 * intermediate state while a case is being written.
 *
 * Two of these read `outcome`, which only exists on a completed run
 * (`action`, `replyMentions`), and one only exists on a paused one
 * (`pausesFor`). The scorer reports the mismatch rather than throwing, so a
 * case that expects the wrong terminal state fails with a sentence saying so.
 */
export const expectationsSchema = z
  .object({
    /** The loop's terminal status. */
    status: z.enum(AGENT_LOOP_STATUSES).optional(),
    /** `resolve_ticket`'s `action`. Completed runs only. */
    action: z.string().optional(),
    /**
     * `resolve_ticket`'s `refund_amount_cents`: an exact figure, or a ceiling
     * for cases where the amount is a judgement call but "not more than this"
     * is policy.
     */
    refundCents: z
      .union([z.number().int(), z.object({ max: z.number().int() }).strict()])
      .optional(),
    /** The run stopped for human approval on this tool, with this amount. */
    pausesFor: z
      .object({ tool: z.string(), amountCents: z.number().int().optional() })
      .strict()
      .optional(),
    /** Each name must appear as a non-error `tool_exec` span. */
    toolsCalled: z.array(z.string()).optional(),
    /** No name may appear as *any* `tool_exec` span, error or not. */
    toolsNever: z.array(z.string()).optional(),
    /**
     * A `guardrail` span with this name fired. The name is the guardrail's own
     * — `injection_scan` — not a tool's: what it asserts is that a control ran,
     * which is not the same claim as `toolsNever` and is not one the model can
     * satisfy by being agreeable.
     */
    guardrailOn: z.array(z.string()).optional(),
    /** Case-insensitive substrings of the outcome's `reply`. */
    replyMentions: z.array(z.string()).optional(),
    /** Loop iterations used, at most. */
    maxIterations: z.number().int().positive().optional(),
  })
  .strict();

export type Expectations = z.infer<typeof expectationsSchema>;

/** Exported so the suite's own test can tell an expectation from a comment. */
export const EXPECTATION_KEYS = Object.keys(
  expectationsSchema.shape,
) as ReadonlyArray<keyof Expectations>;

export const evalCaseSchema = z
  .object({
    slug: z.string().regex(SLUG, "slug must be kebab-case"),
    title: z.string().min(1),
    /** Why this case exists — and, for a disabled one, why it is off. */
    description: z.string().default(""),
    ticket: z
      .object({
        /** A customer external id, or null for the unidentifiable-customer case. */
        customer: z.string().nullable(),
        subject: z.string(),
        body: z.string(),
      })
      .strict(),
    expect: expectationsSchema,
    tags: z.array(z.string()).default([]),
    /**
     * Defaults to true so switching a case off is an act, not an omission. A
     * disabled case keeps its row and its history; it simply does not run.
     */
    enabled: z.boolean().default(true),
  })
  .strict();

export type EvalCase = z.infer<typeof evalCaseSchema>;
