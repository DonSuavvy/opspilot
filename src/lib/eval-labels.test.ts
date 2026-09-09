/**
 * The three formatters the Eval Lab's three pages share.
 *
 * Pure and tested because every one of them has a null case that the pages
 * cannot avoid: `sop_version_id` is `on delete set null`, `git_sha` is null
 * outside a checkout, and an assertion that never ran has no `actual`. A
 * formatter that renders those as "undefined" would put the word in a table
 * cell and read as a value.
 */
import { describe, expect, it } from "vitest";

import { compactJson, shortSha, sopLabel } from "./eval-labels";

describe("sopLabel", () => {
  it("names the version and the window in force", () => {
    expect(sopLabel({ sopVersion: 2, refundWindowDays: 14 })).toBe(
      "v2 · 14-day",
    );
    expect(sopLabel({ sopVersion: 1, refundWindowDays: 30 })).toBe(
      "v1 · 30-day",
    );
  });

  it("drops the window when the stored policy has no readable one", () => {
    expect(sopLabel({ sopVersion: 3, refundWindowDays: null })).toBe("v3");
  });

  it("says the SOP is gone rather than rendering a null version", () => {
    expect(sopLabel({ sopVersion: null, refundWindowDays: null })).toBe(
      "SOP deleted",
    );
    // A window without a version cannot be attributed, so it is not shown.
    expect(sopLabel({ sopVersion: null, refundWindowDays: 30 })).toBe(
      "SOP deleted",
    );
  });
});

describe("shortSha", () => {
  it("takes the first seven characters", () => {
    expect(shortSha("a413f4790c1e2b3d4f5a6b7c8d9e0f1a2b3c4d5e")).toBe("a413f47");
  });

  it("trims first, so a SHA read from a subprocess does not keep its newline", () => {
    expect(shortSha("a413f4790c1e2b3d\n")).toBe("a413f47");
  });

  it("names the absence rather than rendering an empty cell", () => {
    expect(shortSha(null)).toBe("no SHA");
    expect(shortSha("   ")).toBe("no SHA");
  });

  it("returns a shorter sha whole", () => {
    expect(shortSha("abc12")).toBe("abc12");
  });
});

describe("compactJson", () => {
  it("renders values without the whitespace a table has no room for", () => {
    expect(compactJson({ tool: "issue_refund", amountCents: 4900 })).toBe(
      '{"tool":"issue_refund","amountCents":4900}',
    );
    expect(compactJson(["get_invoices", "issue_refund"])).toBe(
      '["get_invoices","issue_refund"]',
    );
  });

  it("keeps a string quoted, so an empty reply is visible", () => {
    expect(compactJson("completed")).toBe('"completed"');
    expect(compactJson("")).toBe('""');
  });

  it("distinguishes a stored null from an assertion that has no such side", () => {
    expect(compactJson(null)).toBe("null");
    expect(compactJson(undefined)).toBe("—");
  });
});
