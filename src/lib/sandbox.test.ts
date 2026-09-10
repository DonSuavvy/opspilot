import { describe, expect, it, vi } from "vitest";

import {
  isSandboxSlug,
  newSandboxSlug,
  resolveSandbox,
  SANDBOX_COOKIE,
  SANDBOX_COOKIE_MAX_AGE_S,
  SANDBOX_HEADER,
  SANDBOX_TTL_MS,
} from "./sandbox";

/** Sixteen bytes of something, so a test that does not care can say so. */
const bytes = (fill: number) => new Uint8Array(16).fill(fill);

describe("the sandbox constants", () => {
  it("names the cookie and the header distinctly", () => {
    expect(SANDBOX_COOKIE).toBe("opspilot_sandbox");
    expect(SANDBOX_HEADER).toBe("x-opspilot-sandbox");
  });

  it("outlives the sandbox in the cookie, so a return visit re-seeds", () => {
    // A 7 day cookie against a 24 hour TTL is deliberate. The visitor who
    // comes back on day three keeps their slug and gets fresh rows under it,
    // which is a better welcome than a stranger's spent budget.
    expect(SANDBOX_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(SANDBOX_COOKIE_MAX_AGE_S * 1000).toBeGreaterThan(SANDBOX_TTL_MS);
  });
});

describe("newSandboxSlug", () => {
  it("mints a slug its own validator accepts", () => {
    expect(isSandboxSlug(newSandboxSlug(bytes(0xab)))).toBe(true);
  });

  it("pads a byte under 0x10 instead of dropping its leading nibble", () => {
    // The bug this pins: `x.toString(16)` renders 0 as "0" and 15 as "f", so
    // sixteen small bytes produce a 16 character slug that fails the pattern
    // the same module publishes. All zeros is the worst case and the cheapest
    // one to assert on.
    expect(newSandboxSlug(new Uint8Array(16))).toBe(`sb_${"0".repeat(32)}`);
    expect(isSandboxSlug(newSandboxSlug(new Uint8Array(16)))).toBe(true);
  });

  it("refuses fewer than 16 bytes rather than minting a short slug", () => {
    expect(() => newSandboxSlug(new Uint8Array(8))).toThrow(/16 bytes/);
  });

  it("gives different randomness different slugs", () => {
    expect(newSandboxSlug(bytes(1))).not.toBe(newSandboxSlug(bytes(2)));
  });
});

describe("isSandboxSlug", () => {
  it("accepts the shape it documents", () => {
    expect(isSandboxSlug(`sb_${"0123456789abcdef".repeat(2)}`)).toBe(true);
  });

  it("rejects the durable demo tenant", () => {
    // The one slug that must never be swept, reset, or minted.
    expect(isSandboxSlug("demo")).toBe(false);
  });

  it.each([
    ["no prefix", "0123456789abcdef0123456789abcdef"],
    ["too short", "sb_0123456789abcdef"],
    ["too long", `sb_${"a".repeat(33)}`],
    ["upper case hex", `sb_${"A".repeat(32)}`],
    ["not hex", `sb_${"z".repeat(32)}`],
    ["a trailing newline", `sb_${"a".repeat(32)}\n`],
    ["a path separator", `sb_${"a".repeat(31)}/`],
  ])("rejects %s", (_label, value) => {
    expect(isSandboxSlug(value)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["sb_"]])("rejects %s", (value) => {
    expect(isSandboxSlug(value)).toBe(false);
  });
});

describe("resolveSandbox", () => {
  it("mints and reports fresh when there is no cookie", () => {
    const result = resolveSandbox({ cookie: undefined, random: () => bytes(7) });
    expect(result.fresh).toBe(true);
    expect(isSandboxSlug(result.slug)).toBe(true);
  });

  it("keeps a valid cookie and never asks for randomness", () => {
    const random = vi.fn(() => bytes(7));
    const slug = `sb_${"c".repeat(32)}`;

    const result = resolveSandbox({ cookie: slug, random });

    expect(result).toEqual({ slug, fresh: false });
    expect(random).not.toHaveBeenCalled();
  });

  it("mints over a cookie that is not a sandbox slug", () => {
    // Cookies are visitor input. A hand-edited value naming another tenant is
    // the attack this rejects, and the answer is a new sandbox rather than an
    // error the visitor cannot act on.
    const result = resolveSandbox({ cookie: "demo", random: () => bytes(9) });
    expect(result.fresh).toBe(true);
    expect(result.slug).not.toBe("demo");
  });
});
