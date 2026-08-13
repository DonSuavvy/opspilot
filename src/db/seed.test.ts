import { describe, expect, it } from "vitest";

import { seedIdsFor } from "./seed";

/**
 * Round 4, finding 4.
 *
 * Every primary key in the seed was derived as `sha256(key)` — the key alone,
 * with no workspace component. `seedId("workspace:demo")` therefore equals the
 * live `workspaces.id`, confirmed against the running database:
 *
 *   derived seedId("workspace:demo") = 03153a0e-1643-442f-b9c4-7186c15ffea3
 *   select id from workspaces        = 03153a0e-1643-442f-b9c4-7186c15ffea3
 *
 * That is fine for exactly one workspace and fatal for two. Day 8 gives every
 * demo visitor an isolated sandbox; the second one to be seeded derives the
 * identical `customer:...` ids as the first and dies on `customers_pkey`. The
 * per-visitor sandbox is also the permanent fix for the seed's ~8-day shelf
 * life, so this blocks the thing that stops the demo decaying.
 *
 * The tests are pure — `npm test` must never need a database, and the id
 * derivation is the part of the seed that can be checked without one.
 */
describe("seedIdsFor", () => {
  const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("derives a valid v4-shaped uuid", () => {
    expect(seedIdsFor("demo")("customer:cus_beacon_001")).toMatch(UUID_V4);
  });

  it("is deterministic for the same workspace and key", () => {
    // The whole point of deriving rather than generating: Day 6's eval cases
    // reference a specific invoice by computing its id instead of querying.
    expect(seedIdsFor("demo")("invoice:INV-2002")).toBe(
      seedIdsFor("demo")("invoice:INV-2002"),
    );
  });

  it("derives different ids for different keys in one workspace", () => {
    const id = seedIdsFor("demo");
    expect(id("invoice:INV-2001")).not.toBe(id("invoice:INV-2002"));
  });

  /** The defect itself. */
  it("derives different ids for the same key in different workspaces", () => {
    expect(seedIdsFor("demo")("customer:cus_beacon_001")).not.toBe(
      seedIdsFor("visitor-a1b2c3")("customer:cus_beacon_001"),
    );
  });

  /**
   * Scoping by concatenation reintroduces the collision it was meant to fix:
   * `slug + key` maps ("ab", "c") and ("a", "bc") to the same digest, so two
   * sandboxes whose slugs share a prefix can still collide. Unambiguous
   * encoding is the requirement, not merely "the slug is in there somewhere".
   *
   * Reachable rather than theoretical — Day 8 slugs are generated per visitor,
   * so the alphabet is not something this module gets to assume.
   */
  it("cannot be collided by shifting the boundary between slug and key", () => {
    expect(seedIdsFor("ab")("c")).not.toBe(seedIdsFor("a")("bc"));
  });

  /** A slug containing the separator must not be able to forge another one. */
  it("cannot be collided by a slug containing separator characters", () => {
    expect(seedIdsFor("a:b")("c")).not.toBe(seedIdsFor("a")("b:c"));
    expect(seedIdsFor("2:ab")("c")).not.toBe(seedIdsFor("ab")("c"));
  });

  /**
   * The seed's own key space, checked in bulk: no two distinct keys used by
   * `seedWorkspace` may collide within a workspace, and none may collide
   * across two workspaces.
   */
  it("keeps the seed's own key space collision-free", () => {
    const keys = [
      "workspace",
      "sop:support-billing",
      "sop_version:support-billing:1",
      ...Array.from({ length: 30 }, (_, i) => `customer:cus_beacon_${i}`),
      ...Array.from({ length: 30 }, (_, i) => `subscription:cus_beacon_${i}`),
      ...Array.from({ length: 54 }, (_, i) => `invoice:INV-${2000 + i}`),
      ...Array.from({ length: 20 }, (_, i) => `kb:article-${i}`),
      ...Array.from({ length: 8 }, (_, i) => `ticket:t-${i}`),
    ];

    const a = seedIdsFor("demo");
    const b = seedIdsFor("visitor-a1b2c3");
    const all = [...keys.map(a), ...keys.map(b)];

    expect(new Set(all).size).toBe(all.length);
  });
});
