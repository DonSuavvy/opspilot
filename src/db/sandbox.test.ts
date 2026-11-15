import { describe, expect, it } from "vitest";

import type { Db } from "./client";
import { ensureSandbox, NotASandboxError, resetSandbox } from "./sandbox";

/**
 * A handle that fails the test if anything reaches for it.
 *
 * `npm test` must never need Postgres, and the property under test here is
 * precisely that the slug is refused *before* a query is built. A mock that
 * returned plausible rows would pass whether the check runs first or last.
 */
const explodingDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the database was touched (.${String(property)}) for a slug that ` +
          `should have been refused`,
      );
    },
  },
) as unknown as Db;

const NOW = new Date("2026-09-10T03:00:00.000Z");

const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["the durable demo tenant", "demo"],
  ["an empty slug", ""],
  ["a slug with no prefix", "0123456789abcdef0123456789abcdef"],
  ["upper case hex", `sb_${"A".repeat(32)}`],
  ["a slug that is too short", "sb_dead"],
  ["a wildcard someone hoped would match", "sb_%"],
];

describe("ensureSandbox", () => {
  it.each(REFUSED)("refuses %s before opening a query", async (_label, slug) => {
    await expect(ensureSandbox(explodingDb, slug, NOW)).rejects.toBeInstanceOf(
      NotASandboxError,
    );
  });
});

describe("resetSandbox", () => {
  // Reset deletes rows, so it is the call where a slug from a cookie must not
  // be allowed to name someone else's tenant.
  it.each(REFUSED)("refuses %s before opening a query", async (_label, slug) => {
    await expect(resetSandbox(explodingDb, slug, NOW)).rejects.toBeInstanceOf(
      NotASandboxError,
    );
  });
});
