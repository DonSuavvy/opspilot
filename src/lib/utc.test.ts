import { describe, expect, it } from "vitest";

import { formatUtc } from "./utc";

/**
 * The eval lab and Mission Control print run times as UTC so two readers
 * comparing rows read the same numbers. They did not say so, and a visitor in
 * Manila read 14:41 at 22:41 local. The clock is right; the label was missing.
 */
describe("formatUtc", () => {
  const at = new Date("2026-11-15T14:41:07.250Z");

  it("prints to the minute, fixed width, with no locale", () => {
    expect(formatUtc(at, "minute")).toBe("2026-11-15 14:41");
  });

  it("prints to the second for an operator's log", () => {
    expect(formatUtc(at, "second")).toBe("2026-11-15 14:41:07");
  });

  it("can carry its own zone label, for a value shown outside a table", () => {
    expect(formatUtc(at, "minute", { zone: true })).toBe("2026-11-15 14:41 UTC");
  });

  it("does not depend on the machine's time zone", () => {
    // A local-time formatter would print the 16th for this instant in Manila.
    expect(formatUtc(new Date("2026-11-15T23:30:00Z"), "minute")).toBe(
      "2026-11-15 23:30",
    );
  });
});
