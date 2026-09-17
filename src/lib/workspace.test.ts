import { describe, expect, it } from "vitest";

import {
  requireSandboxHeader,
  SandboxHeaderMissingError,
} from "./workspace";

const SLUG = `sb_${"a1b2c3d4".repeat(4)}`;

describe("requireSandboxHeader", () => {
  it("returns the slug the proxy stamped on the request", () => {
    expect(requireSandboxHeader(SLUG)).toBe(SLUG);
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["the durable demo tenant", "demo"],
    ["hand-written junk", "sb_nope"],
  ])("refuses a %s header", (_label, value) => {
    expect(() => requireSandboxHeader(value)).toThrow(SandboxHeaderMissingError);
  });

  it("blames the proxy, not the database", () => {
    // A page that reports this as "run npm run db:seed" sends whoever reads it
    // to rebuild Postgres over a matcher typo. The header is only ever missing
    // because the route was not matched, so the message has to say so.
    expect(() => requireSandboxHeader(null)).toThrow(/proxy/i);
    expect(() => requireSandboxHeader(null)).not.toThrow(/db:seed/);
  });

  it("names the header so the fix is findable", () => {
    expect(() => requireSandboxHeader(null)).toThrow(/x-opspilot-sandbox/);
  });
});
