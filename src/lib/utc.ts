/**
 * A timestamp as UTC, fixed width, with no locale.
 *
 * Run logs print UTC on purpose: two readers comparing rows across a diff
 * link, or an operator matching a row to a log line, must be reading the same
 * numbers. What they must also be told is that it *is* UTC. A table says so
 * once in its column header; a value standing on its own carries the label
 * itself with `zone: true`.
 *
 * Client-safe and dependency-free, so a server page and a client island can
 * print the same instant the same way.
 */
export type UtcPrecision = "minute" | "second";

export function formatUtc(
  at: Date,
  precision: UtcPrecision,
  options: { zone?: boolean } = {},
): string {
  // `toISOString` is always UTC, whatever the machine's zone is.
  const text = at
    .toISOString()
    .slice(0, precision === "minute" ? 16 : 19)
    .replace("T", " ");

  return options.zone ? `${text} UTC` : text;
}
