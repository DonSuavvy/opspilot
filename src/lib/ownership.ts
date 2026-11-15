/**
 * One row, one owner, one answer for everything else.
 *
 * Once every visitor has their own workspace, any id in a URL or a request
 * body is an id somebody could have typed. The rule is that a row belonging to
 * another sandbox is a 404 with the same body as a row that does not exist,
 * because distinguishing them tells whoever is probing which ids are real.
 *
 * The reason this is a function rather than an `if` at each call site: two
 * branches drift. One ends up saying "no ticket <id>" and the other "forbidden",
 * and the leak is back. Collapsing both into a null leaves the caller one
 * branch and one message to write.
 */

/** The caller's row, or null for both "not yours" and "not there". */
export function ownedOrMissing<T extends { workspaceId: string }>(
  row: T | undefined | null,
  workspaceId: string,
): T | null {
  if (!row || !workspaceId) return null;
  return row.workspaceId === workspaceId ? row : null;
}
