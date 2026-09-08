import { describe, expect, it, vi } from "vitest";

import { promptVersion, resolveGitSha } from "./pin";

/**
 * PLAN.md: "Every eval run pinned to (SOP version, prompt version, model, git
 * SHA) → regression diff view between any two runs." The pin is what makes a
 * diff mean anything — two runs are comparable only if you can say what was
 * different about them, and "the prompt changed" is the difference the whole
 * Eval Lab exists to attribute results to.
 */

describe("promptVersion", () => {
  /**
   * Literal digests, not `createHash(...)` recomputed in the test. Recomputing
   * would assert that sha256 is sha256; these assert that the *pin* is stable
   * across processes and machines, which is the property a stored value needs.
   */
  it("is a 12-character sha256 prefix of the text", () => {
    expect(promptVersion("hello")).toBe("2cf24dba5fb0");
    expect(promptVersion("# SOP\nRefund window is 30 days.\n")).toBe(
      "8e36f8a02a36",
    );
  });

  it("is stable for equal input", () => {
    expect(promptVersion("hello")).toBe(promptVersion("hello"));
  });

  it("moves when a single character of policy moves", () => {
    expect(promptVersion("# SOP\nRefund window is 30 days.\n")).not.toBe(
      promptVersion("# SOP\nRefund window is 14 days.\n"),
    );
  });

  /**
   * The prompt is what the model reads, not how it was wrapped. `cachedSystem`
   * puts the same text in a block with `cache_control`; a pin that changed
   * when caching was toggled would report a prompt regression that never
   * happened.
   */
  it("ignores the packaging — a string and its block form pin the same", () => {
    expect(
      promptVersion([
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      ]),
    ).toBe("2cf24dba5fb0");
  });

  it("concatenates multiple blocks in order", () => {
    expect(
      promptVersion([
        { type: "text", text: "hel" },
        { type: "text", text: "lo" },
      ]),
    ).toBe("2cf24dba5fb0");
  });
});

describe("resolveGitSha", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("prefers GITHUB_SHA", () => {
    const exec = vi.fn(() => "from-git");

    expect(
      resolveGitSha(
        { GITHUB_SHA: SHA, VERCEL_GIT_COMMIT_SHA: "vercel" },
        exec,
      ),
    ).toBe(SHA);
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to VERCEL_GIT_COMMIT_SHA", () => {
    expect(resolveGitSha({ VERCEL_GIT_COMMIT_SHA: SHA }, () => "from-git")).toBe(
      SHA,
    );
  });

  /** Same convention as `providerFromEnv`: an empty variable is not a value. */
  it("treats an empty variable as absent", () => {
    expect(resolveGitSha({ GITHUB_SHA: "", VERCEL_GIT_COMMIT_SHA: "  " }, () => SHA)).toBe(
      SHA,
    );
  });

  it("shells out last, and trims the trailing newline git leaves", () => {
    expect(resolveGitSha({}, () => `${SHA}\n`)).toBe(SHA);
  });

  it("returns null rather than throwing when git is not available", () => {
    expect(
      resolveGitSha({}, () => {
        throw new Error("not a git repository");
      }),
    ).toBeNull();
  });

  it("returns null when git answers with nothing", () => {
    expect(resolveGitSha({}, () => "\n")).toBeNull();
  });

  it("returns null when there is no exec to fall back to", () => {
    expect(resolveGitSha({})).toBeNull();
  });
});
