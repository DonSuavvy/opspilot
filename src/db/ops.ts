/**
 * Mission Control's read side — what the operator sees, and the two pure
 * functions that decide how it reads.
 *
 * The split is the same one `src/db/evals.ts` makes and for the same reason.
 * `budgetGauge` and `summarizeGuardrail` are arithmetic and string handling,
 * so they are unit-tested and `npm test` stays database-free; `opsSnapshot` is
 * a set of queries whose evidence is a live database, because a mocked session
 * would prove only that the mock behaves.
 *
 * Nothing here writes. Mission Control is a window, and a page that can change
 * the thing it is reporting on is a worse instrument.
 */
import { count, desc, eq, gte, type SQL } from "drizzle-orm";

import {
  DEFAULT_GLOBAL_RUNS_PER_MINUTE,
  type BudgetConfig,
} from "@/agent/budget";

import type { DbOrTx } from "./runs";
import { spentTodayNanos } from "./runs";
import { agentRuns, approvals, evalRuns, runSpans, workspaces } from "./schema";

/**
 * How far back `runsInLastMinute` looks.
 *
 * Deliberately the same 60 seconds as `RATE_WINDOW_MS` in `runs.ts`, which is
 * module-private there. Duplicated rather than exported because that module is
 * owned elsewhere — but if the two ever diverge, this page reports a number
 * the reservation gate does not use, which is worse than reporting nothing.
 */
const RATE_WINDOW_MS = 60_000;

/** How many guardrail spans the page shows. Recent, not historical. */
const RECENT_GUARDRAILS = 10;

/** How many runs the page lists. Enough to see a burst, short enough to read. */
const RECENT_RUNS = 12;

/** Longest a guardrail summary may be before it stops fitting a table row. */
const SUMMARY_MAX = 120;

export type BudgetState = "ok" | "warning" | "exhausted" | "killed";

/** Spend past which the page stops being quiet about it. */
const WARNING_PERCENT = 80;

export interface BudgetGauge {
  state: BudgetState;
  /** Spend as a percentage of the cap, clamped to 0–100, one decimal. */
  percent: number;
  remainingNanos: number;
}

export interface BudgetGaugeInput {
  spentNanos: number;
  capNanos: number;
  killSwitch: boolean;
}

/**
 * Three numbers to a state, a bar and a headroom figure.
 *
 * Ordered killed > exhausted > warning > ok, matching `checkBudget`: an
 * operator who pulled the switch wants to hear about the switch rather than
 * about arithmetic. `percent` is computed from spend independently of the
 * switch, because it answers a different question — "how much has gone" — and
 * a killed budget with nothing spent should not draw a full bar.
 *
 * `remainingNanos` is the real figure even when killed, which differs from
 * `killSwitched()` in `runs.ts` on purpose. That one reports zero to avoid a
 * database round trip it is trying to skip; this one already has the numbers.
 */
export function budgetGauge(input: BudgetGaugeInput): BudgetGauge {
  const { spentNanos, capNanos, killSwitch } = input;
  const remainingNanos = Math.max(0, capNanos - spentNanos);

  // Guarded before the division. A zero cap is also the honest reading of
  // exhausted: nothing may be spent, so the budget is spent.
  const percent =
    capNanos <= 0
      ? 100
      : Math.round(
          Math.min(100, Math.max(0, (spentNanos / capNanos) * 100)) * 10,
        ) / 10;

  if (killSwitch) {
    return {
      state: "killed",
      percent: capNanos <= 0 ? 100 : percent,
      remainingNanos,
    };
  }
  if (capNanos <= 0 || spentNanos >= capNanos) {
    return { state: "exhausted", percent: 100, remainingNanos: 0 };
  }
  if (percent >= WARNING_PERCENT) {
    return { state: "warning", percent, remainingNanos };
  }
  return { state: "ok", percent, remainingNanos };
}

export interface GuardrailSpanLike {
  name: string;
  isError: boolean;
  /**
   * Optional because only the injection scan reads it — the other four
   * writers of a guardrail span put everything the summary needs in `output`,
   * and requiring a `null` from each of them would be noise standing in for a
   * contract. `loadRecentGuardrails` passes the column either way.
   */
  input?: unknown;
  output: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `outside_refund_window` reads as prose in a table; the code does not. */
function humanize(code: string): string {
  return code.replaceAll("_", " ");
}

/** `["a"]` -> `a`, `["a","b"]` -> `a and b`, `["a","b","c"]` -> `a, b and c`. */
function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

/**
 * The one summary written against a known shape rather than sniffed for.
 *
 * `prepareTicketRun` is the only writer of this span and it splits the payload
 * across both columns: the signals in `input`, `flagged` and the withheld
 * tools in `output`. Reading only `output.signals` — which nothing writes —
 * left the demo's fourth beat rendering as a bare `injection_scan`, the one
 * row on this page where naming what the control did is the entire point.
 */
function summarizeInjectionScan(span: GuardrailSpanLike): string {
  const signals = stringsIn(isRecord(span.input) ? span.input.signals : null);
  const withheld = stringsIn(
    isRecord(span.output) ? span.output.restrictedTools : null,
  );

  const counted =
    signals.length > 0
      ? `${signals.length} signal${signals.length === 1 ? "" : "s"}`
      : null;

  const parts = [
    counted,
    withheld.length > 0 ? `withheld ${andList(withheld)}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0
    ? `Injection flagged: ${parts.join(", ")}`
    : "Injection flagged";
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > SUMMARY_MAX
    ? `${line.slice(0, SUMMARY_MAX - 1)}…`
    : line;
}

/**
 * One line describing what a guardrail actually stopped.
 *
 * Keyed off what is *present* rather than off a union of known shapes. Four
 * call sites in `loop.ts` write these spans today — a budget refusal, a
 * preflight throw, a missing decision, a human denial — with three different
 * payload shapes between them, and the injection guardrail is being wired in
 * another worktree as this lands. Matching on structure absorbs that without a
 * rewrite, and an unrecognised payload degrades to the span name rather than
 * to `[object Object]` in a table an operator is meant to trust.
 *
 * `violations` is read before `error` because a payload carrying both is
 * plausible and the enumerated code is the more precise of the two.
 */
export function summarizeGuardrail(span: GuardrailSpanLike): string {
  const output = span.output;
  if (!isRecord(output)) return span.name;

  // Read first, because it is the one shape here that is *known* rather than
  // inferred, and `flagged` identifies it exactly.
  if (output.flagged === true) return summarizeInjectionScan(span);

  const violations = output.violations;
  if (Array.isArray(violations) && violations.length > 0) {
    const first = violations[0];
    if (typeof first === "string" && first.length > 0) return humanize(first);
  }

  const reason = output.reason;
  if (typeof reason === "string" && reason.length > 0) return humanize(reason);

  const error = output.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return firstLine(error);
  }

  return span.name;
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

export interface RecentGuardrail {
  runId: string;
  name: string;
  isError: boolean;
  startedAt: Date;
  summary: string;
}

export interface RecentRun {
  id: string;
  /** `demo` is the durable workspace; a sandbox slug begins with `sb_`. */
  workspaceSlug: string;
  status: string;
  model: string;
  startedAt: Date;
  costUsd: string | null;
}

export interface OpsSnapshot {
  spentTodayNanos: number;
  capNanos: number;
  gauge: BudgetGauge;
  killSwitch: boolean;
  /** The ceiling on one sandbox. */
  runsPerMinute: number;
  /** The ceiling on every sandbox at once, which is what the account sees. */
  globalRunsPerMinute: number;
  /** Runs started anywhere in the last minute, against the global ceiling. */
  runsInLastMinute: number;
  inFlight: number;
  runsToday: { total: number; byStatus: Record<string, number> };
  pendingApprovals: number;
  evalRunsToday: number;
  recentGuardrails: RecentGuardrail[];
  recentRuns: RecentRun[];
}

/** UTC, so "today" means the same thing to the page and to `spentTodayNanos`. */
function utcMidnight(now: Date): Date {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight;
}

/**
 * Runs started today, grouped by status, with the total derived from the same
 * rows rather than counted separately — two queries could disagree across a
 * run that starts between them, and a total that does not equal the sum of its
 * parts is the kind of detail that discredits a whole dashboard.
 */
async function loadRunsToday(
  db: DbOrTx,
  midnight: Date,
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const rows = await db
    .select({ status: agentRuns.status, n: count() })
    .from(agentRuns)
    .where(gte(agentRuns.startedAt, midnight))
    .groupBy(agentRuns.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return { total, byStatus };
}

/** One `count(*)` over `agent_runs`, so the two callers below cannot drift. */
async function countRuns(db: DbOrTx, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: count() }).from(agentRuns).where(where);
  return row?.n ?? 0;
}

async function loadRecentGuardrails(db: DbOrTx): Promise<RecentGuardrail[]> {
  const rows = await db
    .select({
      runId: runSpans.runId,
      name: runSpans.name,
      isError: runSpans.isError,
      startedAt: runSpans.startedAt,
      // Both columns: the injection scan's signals live in `input`.
      input: runSpans.input,
      output: runSpans.output,
    })
    .from(runSpans)
    .where(eq(runSpans.type, "guardrail"))
    .orderBy(desc(runSpans.startedAt))
    .limit(RECENT_GUARDRAILS);

  return rows.map((row) => ({
    runId: row.runId,
    name: row.name,
    isError: row.isError,
    startedAt: row.startedAt,
    summary: summarizeGuardrail({
      name: row.name,
      isError: row.isError,
      input: row.input,
      output: row.output,
    }),
  }));
}

/**
 * The last few runs, whichever sandbox started them.
 *
 * The slug is carried per row because it is the only thing that tells them
 * apart on this page. `demo` is the durable workspace behind the scripted
 * arc; everything beginning `sb_` is one visitor's sandbox. An operator
 * watching a burst wants to know whether it is one person clicking or twenty
 * people arriving, and that question has no answer without the slug.
 */
async function loadRecentRuns(db: DbOrTx): Promise<RecentRun[]> {
  const rows = await db
    .select({
      id: agentRuns.id,
      workspaceSlug: workspaces.slug,
      status: agentRuns.status,
      model: agentRuns.model,
      startedAt: agentRuns.startedAt,
      costUsd: agentRuns.costUsd,
    })
    .from(agentRuns)
    .innerJoin(workspaces, eq(workspaces.id, agentRuns.workspaceId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(RECENT_RUNS);

  return rows;
}

/**
 * Everything Mission Control renders, read in one pass.
 *
 * `now` is injected for the same reason the policy engine's is: a page that
 * reads its own clock cannot be checked, and here two figures derived from two
 * different reads of `Date.now()` would silently disagree about which runs are
 * "today". One instant, one midnight, one rate window.
 *
 * **No query is workspace-scoped any more.** Every figure here is about the
 * deployment, because that is what the thing being guarded is: one daily cap,
 * one arrival rate, one shared Bedrock account. Scoping them made sense while
 * a workspace was the demo; per-visitor sandboxes make a workspace a browser
 * cookie, and a dashboard that reported one cookie's spend while the gate
 * enforced everybody's would be an instrument that lies.
 */
export async function opsSnapshot(
  db: DbOrTx,
  now: Date,
  config: BudgetConfig,
): Promise<OpsSnapshot> {
  const midnight = utcMidnight(now);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);

  const [
    spent,
    runsInLastMinute,
    inFlight,
    runsToday,
    pendingApprovals,
    evalRunsToday,
    recentGuardrails,
    recentRuns,
  ] = await Promise.all([
    spentTodayNanos(db, now),
    countRuns(db, gte(agentRuns.startedAt, windowStart)),
    countRuns(db, eq(agentRuns.status, "running")),
    loadRunsToday(db, midnight),
    db
      .select({ n: count() })
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .then((rows) => rows[0]?.n ?? 0),
    db
      .select({ n: count() })
      .from(evalRuns)
      .where(gte(evalRuns.startedAt, midnight))
      .then((rows) => rows[0]?.n ?? 0),
    loadRecentGuardrails(db),
    loadRecentRuns(db),
  ]);

  return {
    spentTodayNanos: spent,
    capNanos: config.dailyCapNanos,
    gauge: budgetGauge({
      spentNanos: spent,
      capNanos: config.dailyCapNanos,
      killSwitch: config.killSwitch,
    }),
    killSwitch: config.killSwitch,
    runsPerMinute: config.runsPerMinute,
    globalRunsPerMinute:
      config.globalRunsPerMinute ?? DEFAULT_GLOBAL_RUNS_PER_MINUTE,
    runsInLastMinute,
    inFlight,
    runsToday,
    pendingApprovals,
    evalRunsToday,
    recentGuardrails,
    recentRuns,
  };
}
