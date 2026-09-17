/**
 * The Markdown a CI eval run leaves on a pull request.
 *
 * Tested because the scorecard is the only thing most readers will look at.
 * A reviewer who has to open the Actions log, find the run id and query
 * `eval_results` to learn which assertion moved has been handed a red X, not a
 * finding. So the fixture below carries a failing case and a case that failed
 * *without* assertions, which is what a Bedrock 429 produces, and the tests
 * assert that both say why in the row itself.
 *
 * Pure: no database, no model, no clock.
 */
import { describe, expect, it } from "vitest";

import {
  SCORECARD_MARKER,
  formatScorecard,
  type ScorecardCase,
  type ScorecardPin,
  type ScorecardSummary,
} from "./scorecard";

const PIN: ScorecardPin = {
  sopVersion: 1,
  refundWindowDays: 30,
  promptVersion: "2c4f9a1b3d5e",
  gitSha: "7c6e5d3a1b2c3d4e5f60718293a4b5c6d7e8f900",
  model: "haiku",
  provider: "bedrock",
  estimated: true,
};

function passingCase(slug: string): ScorecardCase {
  return {
    slug,
    title: `Title for ${slug}`,
    passed: true,
    failureReason: null,
    assertions: [{ name: "status", expected: "completed", actual: "completed", passed: true }],
    costUsd: "0.021356",
    latencyMs: 18_400,
  };
}

/** Scored and red: the agent did something the SOP forbids. */
const REGRESSED: ScorecardCase = {
  slug: "refund-flip-22-days",
  title: "22-day refund flips with the window",
  passed: false,
  failureReason: 'action: expected "refunded", got "escalated"',
  assertions: [
    { name: "status", expected: "completed", actual: "completed", passed: true },
    {
      name: "action",
      expected: "refunded",
      actual: "escalated",
      passed: false,
    },
    {
      name: "toolsCalled.issue_refund",
      expected: true,
      actual: false,
      passed: false,
      detail: "no non-error tool_exec span named issue_refund",
    },
  ],
  costUsd: "0.019004",
  latencyMs: 16_100,
};

/** Red with nothing scored: the throttled or thrown case. */
const THROTTLED: ScorecardCase = {
  slug: "duplicate-charge",
  title: "Duplicate charge is refunded in full",
  passed: false,
  failureReason:
    "case threw: 429 Too many requests, please wait before trying again",
  assertions: [],
  costUsd: "0.000000",
  latencyMs: 940,
};

function summary(cases: ScorecardCase[]): ScorecardSummary {
  const failed = cases.filter((c) => !c.passed).length;
  return {
    passed: cases.length - failed,
    failed,
    total: cases.length,
    costNanos: 160_123_000,
    wallMs: 161_000,
    cases,
    error: null,
  };
}

const MIXED = summary([
  passingCase("refund-in-window"),
  REGRESSED,
  THROTTLED,
  passingCase("kb-how-to"),
]);

describe("formatScorecard", () => {
  it("opens with the marker the PR comment is found by", () => {
    const md = formatScorecard(MIXED, PIN);
    expect(md.startsWith(SCORECARD_MARKER)).toBe(true);
    // One occurrence, or the upsert's `includes` check matches a comment that
    // merely quotes an older scorecard.
    expect(md.split(SCORECARD_MARKER).length - 1).toBe(1);
  });

  it("names what the run was pinned to, so two comments can be compared", () => {
    const md = formatScorecard(MIXED, PIN);
    expect(md).toContain("v1 · 30-day");
    expect(md).toContain("2c4f9a1b3d5e");
    expect(md).toContain("7c6e5d3");
    expect(md).not.toContain(PIN.gitSha);
    expect(md).toContain("haiku");
    expect(md).toContain("bedrock");
  });

  it("totals the run: passed of total, cost, wall time", () => {
    const md = formatScorecard(MIXED, PIN);
    expect(md).toContain("2/4 passed");
    expect(md).toContain("$0.160123");
    expect(md).toContain("2m 41s");
  });

  it("says the cost is an estimate when the rate card is unverified", () => {
    expect(formatScorecard(MIXED, PIN)).toContain("estimated");
    expect(
      formatScorecard(MIXED, { ...PIN, estimated: false }),
    ).not.toContain("estimated");
  });

  it("renders one table row per case, in suite order", () => {
    const md = formatScorecard(MIXED, PIN);
    const rows = md
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.includes("`"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("refund-in-window");
    expect(rows[1]).toContain("refund-flip-22-days");
    expect(rows[2]).toContain("duplicate-charge");
    expect(rows[3]).toContain("kb-how-to");
  });

  it("puts every failed assertion in the failing row, expected against actual", () => {
    const md = formatScorecard(MIXED, PIN);
    const row = md
      .split("\n")
      .find((line) => line.includes("refund-flip-22-days"))!;

    expect(row).toContain("fail");
    expect(row).toContain("action");
    expect(row).toContain('"refunded"');
    expect(row).toContain('"escalated"');
    expect(row).toContain("toolsCalled.issue_refund");
    // The assertion that passed is noise in a failure row.
    expect(row).not.toContain("status");
  });

  it("falls back to the failure reason when a case failed before it was scored", () => {
    const md = formatScorecard(MIXED, PIN);
    const row = md
      .split("\n")
      .find((line) => line.includes("duplicate-charge"))!;

    // A blank cell here is the 429 case reading as a mystery.
    expect(row).toContain("429 Too many requests");
  });

  it("leaves the assertions cell empty for a passing case", () => {
    const md = formatScorecard(summary([passingCase("kb-how-to")]), PIN);
    const row = md.split("\n").find((line) => line.includes("kb-how-to"))!;
    expect(row).toContain("pass");
    expect(row).toContain("—");
  });

  it("escapes pipes and newlines, so one reply cannot break the table", () => {
    const nasty: ScorecardCase = {
      ...REGRESSED,
      assertions: [
        {
          name: "replyMentions",
          expected: "a | b",
          actual: "line one\nline two",
          passed: false,
        },
      ],
    };
    const md = formatScorecard(summary([nasty]), PIN);
    const row = md.split("\n").find((line) => line.includes("refund-flip"))!;

    expect(row).toContain("\\|");
    expect(row).not.toMatch(/[^\\]\| b/);
    expect(md.split("\n").filter((l) => l.startsWith("| ")).length).toBe(3);
  });

  it("truncates a long value rather than letting it own the table", () => {
    const long = "x".repeat(400);
    const wordy: ScorecardCase = {
      ...REGRESSED,
      assertions: [
        { name: "replyMentions", expected: long, actual: "", passed: false },
      ],
    };
    const row = formatScorecard(summary([wordy]), PIN)
      .split("\n")
      .find((line) => line.includes("refund-flip"))!;

    expect(row).not.toContain(long);
    expect(row).toContain("…");
    expect(row.length).toBeLessThan(400);
  });

  it("reports latency in seconds above a second and milliseconds below", () => {
    const md = formatScorecard(MIXED, PIN);
    expect(md).toContain("18.4s");
    expect(md).toContain("940ms");
  });

  it("names a suite that broke, above the table", () => {
    const md = formatScorecard(
      { ...MIXED, error: "no workspace — run `npm run db:seed`" },
      PIN,
    );
    expect(md).toContain("no workspace");
    expect(md.indexOf("no workspace")).toBeLessThan(md.indexOf("| case |"));
  });

  it("renders a run with no cases without throwing", () => {
    const md = formatScorecard(summary([]), PIN);
    expect(md).toContain("0/0 passed");
    expect(md).toContain("no cases ran");
  });

  it("names the absent SOP and the absent SHA rather than printing null", () => {
    const md = formatScorecard(MIXED, {
      ...PIN,
      sopVersion: null,
      refundWindowDays: null,
      gitSha: null,
    });
    expect(md).toContain("SOP deleted");
    expect(md).toContain("no SHA");
    expect(md).not.toContain("null");
  });
});
