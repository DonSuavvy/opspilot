/**
 * The regression diff: what moved between two eval runs.
 *
 * Pure, like the policy engine and for the same reason. It takes two arrays of
 * rows and returns five buckets — no DB, no clock, no run context — so the CI
 * scorecard, the API route and the diff view all read the same answer, and the
 * whole thing is testable without Postgres or a key.
 *
 * Two runs are comparable because each is pinned to a SOP version, a logical
 * model, a git SHA and a hash of the compiled system prompt (`eval_runs`). This
 * module assumes that pinning has already been checked and only reports the
 * difference.
 */

import type {
  Assertion,
  AssertionFlip,
  CaseDiff,
  CaseDiffKind,
  CaseResultRow,
  RunDiff,
} from "./types";

/**
 * Sort object keys at every depth, leave arrays alone.
 *
 * `actual` comes back out of `jsonb`, which stores objects as a key-sorted
 * binary form and hands them back in whatever order it likes, so raw
 * `JSON.stringify` would report a flip on a value nothing touched. Arrays are
 * the opposite case: `toolsCalled: ["get_invoices", "issue_refund"]` arriving
 * reversed means the agent did a different thing in a different order, which is
 * exactly what the diff exists to surface.
 *
 * Note this cannot be done with `JSON.stringify(v, Object.keys(v).sort())`.
 * The replacer-array form *filters* keys rather than ordering them, so a key
 * present in base and absent in head would be dropped from both sides and the
 * difference would vanish.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }

  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Codepoint order, not `localeCompare`. A module whose entire purpose is that
 * two runs compare identically must not have its output depend on the locale
 * of whichever machine rendered it.
 */
function bySlug(a: CaseDiff, b: CaseDiff): number {
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

/**
 * Assertions matched by `name`, which `types.ts` guarantees is derived from the
 * expectation key rather than from run output — so it is stable across runs and
 * unique within a case.
 *
 * An assertion counts as flipped when its verdict changed *or* when its
 * `actual` changed underneath an unchanged verdict. One present on a single
 * side is a flip with the other side null: an expectation being added to or
 * dropped from a case is a change to what the suite guards.
 */
function flipsBetween(base: Assertion[], head: Assertion[]): AssertionFlip[] {
  const headByName = new Map(head.map((a) => [a.name, a]));
  const baseNames = new Set(base.map((a) => a.name));
  const flips: AssertionFlip[] = [];

  // Base order first.
  for (const before of base) {
    const after = headByName.get(before.name);

    if (!after) {
      flips.push({ name: before.name, before, after: null });
      continue;
    }

    const moved =
      before.passed !== after.passed ||
      !sameValue(before.actual, after.actual);

    if (moved) flips.push({ name: before.name, before, after });
  }

  // Then whatever head added, in head order.
  for (const after of head) {
    if (baseNames.has(after.name)) continue;
    flips.push({ name: after.name, before: null, after });
  }

  return flips;
}

/**
 * Diff two eval runs, matching cases by `slug`.
 *
 * `unchanged` deliberately holds both-passed and both-failed cases: the bucket
 * means "the verdict did not move", not "this case is fine". Its `flips` are
 * still computed, because that is where a still-failing case that started
 * failing for a *different reason* shows up.
 *
 * `added` and `removed` carry no flips. There is nothing to compare a
 * one-sided case against, and inventing flips from its assertions would put
 * every assertion of a newly added case into the view as a change.
 */
export function diffEvalRuns(
  base: CaseResultRow[],
  head: CaseResultRow[],
): RunDiff {
  const baseSlugs = new Set(base.map((r) => r.slug));
  const headBySlug = new Map(head.map((r) => [r.slug, r]));

  const diff: RunDiff = {
    regressed: [],
    fixed: [],
    unchanged: [],
    added: [],
    removed: [],
  };

  for (const before of base) {
    const after = headBySlug.get(before.slug);

    if (!after) {
      diff.removed.push({
        slug: before.slug,
        title: before.title,
        kind: "removed",
        before,
        after: null,
        flips: [],
      });
      continue;
    }

    const kind: CaseDiffKind =
      before.passed === after.passed
        ? "unchanged"
        : before.passed
          ? "regressed"
          : "fixed";

    diff[kind].push({
      slug: before.slug,
      // The current name wins, so a renamed case reads under the title it has
      // now rather than the one it had when the base run was recorded.
      title: after.title,
      kind,
      before,
      after,
      flips: flipsBetween(before.assertions, after.assertions),
    });
  }

  for (const after of head) {
    if (baseSlugs.has(after.slug)) continue;
    diff.added.push({
      slug: after.slug,
      title: after.title,
      kind: "added",
      before: null,
      after,
      flips: [],
    });
  }

  // Sorting the buckets, which are ours. `base` and `head` are the caller's and
  // are never reordered — `Array.prototype.sort` is in place.
  for (const bucket of Object.values(diff)) bucket.sort(bySlug);

  return diff;
}
