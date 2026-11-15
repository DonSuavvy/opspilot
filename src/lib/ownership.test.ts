import { describe, expect, it } from "vitest";

import { ownedOrMissing } from "./ownership";

const MINE = "11111111-1111-4111-8111-111111111111";
const YOURS = "22222222-2222-4222-8222-222222222222";

const ticket = (workspaceId: string) => ({ id: "t1", workspaceId });

describe("ownedOrMissing", () => {
  it("hands back a row from the caller's own workspace", () => {
    const row = ticket(MINE);
    expect(ownedOrMissing(row, MINE)).toBe(row);
  });

  it("gives the same answer for someone else's row as for no row", () => {
    // This is the whole reason the helper exists. Two branches in a route
    // handler drift: one says "no ticket <id>" and the other says "forbidden",
    // and the difference tells a prober that the id is real and belongs to
    // somebody. One function with one null return cannot drift.
    expect(ownedOrMissing(ticket(YOURS), MINE)).toBe(
      ownedOrMissing(undefined, MINE),
    );
    expect(ownedOrMissing(ticket(YOURS), MINE)).toBeNull();
  });

  it("does not throw on a foreign row", () => {
    // A throw would reach the caller as a 500, which is both wrong and a
    // louder signal than the 404 it is meant to be indistinguishable from.
    expect(() => ownedOrMissing(ticket(YOURS), MINE)).not.toThrow();
  });

  it("refuses a row when the caller's workspace is empty", () => {
    // Defence against a caller that resolved its workspace to "" and would
    // otherwise match nothing, or worse, match a row with the same blank.
    expect(ownedOrMissing(ticket(""), "")).toBeNull();
  });
});
