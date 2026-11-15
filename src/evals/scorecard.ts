/**
 * An eval run as one block of Markdown, for a pull request comment.
 *
 * The CI gate spends real money on a shared Bedrock account and then reports
 * a red X. This module is what turns that X into a finding. A reviewer must be
 * able to read the comment and know which case moved, what it expected, what
 * it got, and what the run was pinned to, without opening the Actions log or
 * querying `eval_results`.
 *
 * Pure, and the only place the CI script formats anything: `scripts/ci-evals.ts`
 * runs the suite and writes bytes, this decides what those bytes say. So the
 * table can be changed and reviewed without spending a run to see it.
 *
 * **Rows stay in suite order.** Failures first would surface the regression
 * one line sooner, but the comment is upserted in place and read against the
 * version before it, and two scorecards only line up row for row if neither
 * reorders. The bold `fail` and the totals line already do the surfacing.
 */
import { microsToUsdString, nanosToMicros } from "@/agent/cost";
import { compactJson, shortSha, sopLabel } from "@/lib/eval-labels";

import type { Assertion } from "./types";

/**
 * The string the upsert step looks for to decide between editing a comment and
 * posting a new one. An HTML comment, so it is invisible in the rendered
 * comment and survives GitHub's Markdown sanitiser.
 */
export const SCORECARD_MARKER = "<!-- opspilot-scorecard -->";

/** An absent value in a cell. Matches `eval-labels`, which the pin line uses. */
const ABSENT = "—";

/**
 * How much of one `expected` or `actual` a cell shows.
 *
 * Assertions on `replyMentions` carry the agent's whole reply, which is
 * paragraphs. Rendered whole it pushes the cost and latency columns off the
 * right of the comment, so the row that is hardest to read is the failing one.
 */
const MAX_VALUE_CHARS = 80;

/** As above, for a `failureReason`, which already reads as a sentence. */
const MAX_REASON_CHARS = 200;

/** One case's row, as `EvalCaseFinishedEvent` already delivers it. */
export interface ScorecardCase {
  slug: string;
  title: string;
  passed: boolean;
  failureReason: string | null;
  assertions: Assertion[];
  /** Numeric as text, the way Postgres stores and the suite emits it. */
  costUsd: string;
  latencyMs: number;
}

/**
 * What a run was pinned to, per PLAN.md: SOP version, prompt hash, model, SHA.
 *
 * Every nullable field here is reachable. `sop_version_id` is
 * `on delete set null`, and `git_sha` is null outside a checkout.
 */
export interface ScorecardPin {
  sopVersion: number | null;
  refundWindowDays: number | null;
  promptVersion: string;
  gitSha: string | null;
  /** The logical name, per CLAUDE.md. Never a wire model id. */
  model: string;
  provider: string;
  /** True when the rate card behind every cost below is unverified. */
  estimated: boolean;
}

export interface ScorecardSummary {
  passed: number;
  failed: number;
  total: number;
  costNanos: number;
  /** Wall time for the whole suite. Not the sum of the latencies. */
  wallMs: number;
  cases: ScorecardCase[];
  /** Set when the suite itself threw. Null on an ordinary run, red or green. */
  error: string | null;
}

/**
 * Make one value safe to put between two pipes.
 *
 * GitHub ends a table row at the first unescaped newline and starts a new cell
 * at the first unescaped pipe, so an agent reply containing either silently
 * truncates the table. Backticks go too: a value that opens one and does not
 * close it swallows the rest of the row into code formatting.
 */
function cell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .replace(/\r?\n/g, " ");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `18.4s` above a second, `940ms` below. Both are read, not computed on. */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * The same conversion `finishRun` and `insertEvalResult` make.
 *
 * Nano-dollars are the accounting unit and `numeric(12,6)` is the storage unit;
 * dividing by 1e9 here would eventually disagree with the column by a rounding
 * step, and the scorecard would report a total the database does not hold.
 */
function usd(nanos: number): string {
  return microsToUsdString(nanosToMicros(nanos));
}

/**
 * Why one case is red, as one cell.
 *
 * Failing assertions when there are any, because they name the expectation and
 * both sides of it. `failureReason` when there are none, which is not an edge
 * case: a case the provider throttled or one that threw reaches here with an
 * empty `assertions` array and the reason in `agent_runs.error`, appended by
 * the suite. Rendering only assertions would print those as a blank cell, which
 * is exactly the "red X, no finding" this module exists to prevent.
 */
function whyItFailed(c: ScorecardCase): string {
  if (c.passed) return ABSENT;

  const failed = c.assertions.filter((a) => !a.passed);
  if (failed.length === 0) {
    return cell(truncate(c.failureReason ?? "failed, with no reason recorded", MAX_REASON_CHARS));
  }

  return failed
    .map((a) => {
      const expected = truncate(compactJson(a.expected), MAX_VALUE_CHARS);
      const actual = truncate(compactJson(a.actual), MAX_VALUE_CHARS);
      return cell(`${a.name}: expected ${expected}, got ${actual}`);
    })
    .join("<br>");
}

function row(c: ScorecardCase): string {
  const result = c.passed ? "pass" : "**fail**";
  return `| \`${cell(c.slug)}\` | ${result} | ${whyItFailed(c)} | $${cell(c.costUsd)} | ${duration(c.latencyMs)} |`;
}

/**
 * The pin line, so two comments on two commits can be told apart.
 *
 * Same four facts `eval_runs` stores and `/evals/<id>` renders, in the same
 * order, through the same `eval-labels` helpers. A run that reads "v1 · 30-day"
 * on the page and something else in the comment looks like two runs.
 */
function pinLine(pin: ScorecardPin): string {
  return [
    `SOP ${sopLabel(pin)}`,
    `prompt \`${pin.promptVersion}\``,
    `model \`${pin.model}\` on \`${pin.provider}\``,
    `commit \`${shortSha(pin.gitSha)}\``,
  ].join(" · ");
}

export function formatScorecard(
  summary: ScorecardSummary,
  pin: ScorecardPin,
): string {
  const cost = `$${usd(summary.costNanos)}${pin.estimated ? " (estimated)" : ""}`;

  const lines = [
    SCORECARD_MARKER,
    "",
    "## Eval scorecard",
    "",
    pinLine(pin),
    "",
    `**${summary.passed}/${summary.total} passed** · ${cost} · ${duration(summary.wallMs)} wall time`,
    "",
  ];

  // Above the table, because a suite that broke did not produce the rows
  // below it and a reader who meets the error afterwards has already drawn a
  // conclusion from a partial table.
  if (summary.error !== null) {
    lines.push(`> The suite did not finish: ${summary.error}`, "");
  }

  if (summary.cases.length === 0) {
    lines.push("_no cases ran_", "");
    return lines.join("\n");
  }

  lines.push(
    "| case | result | failed assertions | cost | latency |",
    "| --- | --- | --- | --- | --- |",
    ...summary.cases.map(row),
    "",
  );

  return lines.join("\n");
}
