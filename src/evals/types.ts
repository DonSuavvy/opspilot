/**
 * The Eval Lab's result vocabulary — the contract between the scorer, the
 * runner, the persistence layer and the diff view.
 *
 * Kept in its own module on purpose: the diff is pure and the UI reads rows,
 * so neither should have to import the runner (and through it the provider
 * and the loop) to learn what a result looks like.
 */

/**
 * One deterministic check on one case. `name` is stable across runs — it is
 * what the diff view matches on — so it must be derived from the expectation
 * key and its argument, never from run output.
 */
export interface Assertion {
  name: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  /** Human-readable detail for a failure, e.g. which tool fired. */
  detail?: string;
}

/** The scorer's verdict on one case. */
export interface CaseScore {
  passed: boolean;
  assertions: Assertion[];
  /** The first failing assertion, sentence-cased, or null when all passed. */
  failureReason: string | null;
}

/** One case's row in an eval run, as persisted and as rendered. */
export interface CaseResultRow {
  slug: string;
  title: string;
  passed: boolean;
  assertions: Assertion[];
  failureReason: string | null;
  /** Numeric as text, as Postgres returns it. */
  costUsd: string;
  latencyMs: number | null;
  agentRunId: string | null;
}

/** An assertion that changed between two runs, matched by `name`. */
export interface AssertionFlip {
  name: string;
  before: Assertion | null;
  after: Assertion | null;
}

export type CaseDiffKind =
  | "regressed"
  | "fixed"
  | "unchanged"
  | "added"
  | "removed";

export interface CaseDiff {
  slug: string;
  title: string;
  kind: CaseDiffKind;
  before: CaseResultRow | null;
  after: CaseResultRow | null;
  /** Assertions whose `passed` or `actual` differ; empty when nothing moved. */
  flips: AssertionFlip[];
}

export interface RunDiff {
  regressed: CaseDiff[];
  fixed: CaseDiff[];
  unchanged: CaseDiff[];
  added: CaseDiff[];
  removed: CaseDiff[];
}
