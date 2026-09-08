/**
 * The labels the Eval Lab's three pages render through.
 *
 * Pure and shared for the same reason `diff.ts` is pure: the run list, the
 * detail page and the diff all name the same run, and a run that reads
 * "v2 · 14-day" in the list and "v2" on its own page looks like two runs. Every
 * function here is total — each takes the nullable shape the query actually
 * returns and names the absence, because none of these nulls is reachable only
 * in theory.
 */

/** An absent value in a table cell. Not a stored null, which prints as `null`. */
const ABSENT = "—";

/** Long enough to identify a commit in this repo, short enough for a column. */
const SHA_LENGTH = 7;

export interface SopLabelInput {
  /** Null when the SOP version was deleted out from under the run. */
  sopVersion: number | null;
  /** Null when the stored `policy_config` has no readable refund window. */
  refundWindowDays: number | null;
}

/**
 * What SOP a run was scored against, as one cell: `v2 · 14-day`.
 *
 * The window is part of the label rather than a separate column because it is
 * the thing the demo changes. "v1 versus v2" says two runs differ; "30-day
 * versus 14-day" says how, which is the whole point of putting a diff next to
 * a run list.
 *
 * A missing version suppresses the window as well. A window that cannot be
 * attributed to a version is not a fact about anything a reader can go look at.
 */
export function sopLabel({
  sopVersion,
  refundWindowDays,
}: SopLabelInput): string {
  if (sopVersion === null) return "SOP deleted";
  if (refundWindowDays === null) return `v${sopVersion}`;
  return `v${sopVersion} · ${refundWindowDays}-day`;
}

/**
 * The first seven characters of a commit, or a phrase saying there was none.
 *
 * Trimmed before slicing. `resolveGitSha` trims today, but the SHA can also
 * arrive from `GITHUB_SHA` or straight out of the column, and a value that
 * kept a subprocess newline would slice to six characters and a line break
 * that breaks the row it sits in.
 */
export function shortSha(sha: string | null): string {
  const trimmed = (sha ?? "").trim();
  if (trimmed.length === 0) return "no SHA";
  return trimmed.slice(0, SHA_LENGTH);
}

/**
 * An assertion's `expected` or `actual`, as one line.
 *
 * Compact rather than indented: these sit in table cells beside each other so
 * a reader can see what moved, and a pretty-printed object would push the two
 * sides apart vertically until they could not be compared at a glance.
 *
 * Strings keep their quotes. An assertion whose actual is the empty string is
 * a real finding, and unquoted it renders as an empty cell — indistinguishable
 * from the value being missing.
 */
export function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  // `undefined` in, `undefined` out — the value, not the string. Printing it
  // raw would put the word in a cell where it reads like data.
  return json ?? ABSENT;
}
