/**
 * The landing page has no logic worth testing, but it has copy, and copy
 * drifts: an em dash creeps back in, a link gets typo'd, someone reaches for
 * "leverage". This test walks every string in `landingCopy` so a bad edit
 * fails here instead of in front of a reviewer.
 *
 * The walk is generic rather than one assertion per field on purpose — the
 * copy will grow sections, and a new section should inherit these rules for
 * free rather than needing its own line in this file.
 */
import { describe, expect, it } from "vitest";

import { landingCopy } from "./copy";

const EM_DASH = "—";

// "Words like" in the brief, not an exhaustive list — these five are the
// ones that showed up in earlier drafts of this kind of page.
const BANNED_WORD_PATTERNS: RegExp[] = [
  /\bseamless\b/i,
  /\brobust\b/i,
  /\bleverag\w*/i,
  /\bcutting-edge\b/i,
  /\bempower\w*/i,
];

const GITHUB_REPO = "https://github.com/DonSuavvy/opspilot";

/** Every string in the tree, tagged with whether its key was "href". */
function collectStrings(
  value: unknown,
  isHref: boolean,
  out: { value: string; isHref: boolean }[],
): void {
  if (typeof value === "string") {
    out.push({ value, isHref });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, false, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, key === "href", out);
    }
  }
}

function allStrings(): { value: string; isHref: boolean }[] {
  const out: { value: string; isHref: boolean }[] = [];
  collectStrings(landingCopy, false, out);
  return out;
}

describe("landingCopy", () => {
  it("contains no em dash", () => {
    const offenders = allStrings()
      .filter((s) => !s.isHref && s.value.includes(EM_DASH))
      .map((s) => s.value);
    expect(offenders).toEqual([]);
  });

  it("contains none of the banned marketing words", () => {
    const offenders = allStrings()
      .filter((s) => !s.isHref)
      .filter((s) => BANNED_WORD_PATTERNS.some((re) => re.test(s.value)))
      .map((s) => s.value);
    expect(offenders).toEqual([]);
  });

  it("routes every internal link to a path and every external link to the repo", () => {
    const hrefs = allStrings()
      .filter((s) => s.isHref)
      .map((s) => s.value);

    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      const isInternal = href.startsWith("/");
      const isRepo = href.startsWith(GITHUB_REPO);
      expect(isInternal || isRepo, `unexpected href: ${href}`).toBe(true);
    }
  });

  it("has exactly four steps in the demo arc", () => {
    expect(landingCopy.arc.steps).toHaveLength(4);
  });
});
