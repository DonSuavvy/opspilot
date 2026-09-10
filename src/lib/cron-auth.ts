/**
 * Who is allowed to run the cron sweep.
 *
 * Vercel's convention: the scheduler sends `Authorization: Bearer
 * ${CRON_SECRET}`, and the endpoint refuses everything else. The sweep deletes
 * workspaces, so this is the only thing between a scheduled cleanup and anyone
 * who can guess a URL.
 *
 * Pure, so the two failure modes can be tested apart from a request, and so
 * the rule that no return value ever carries the secret is enforceable.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type CronAuth =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

/**
 * Compare without leaking the answer in the timing.
 *
 * `timingSafeEqual` needs equal lengths, and a length check in front of it
 * would leak the length. Hashing first makes both inputs 32 bytes whatever
 * they were, which is the standard way around that.
 */
function sameSecret(a: string, b: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function authorizeCron(
  header: string | null | undefined,
  secret: string | undefined,
): CronAuth {
  // Whitespace counts as unset. A deployment where someone hit space in the
  // environment variable field must fail closed rather than accept
  // `Bearer " "`.
  if (!secret || secret.trim() === "") {
    return {
      ok: false,
      status: 500,
      error: "CRON_SECRET is not set, so the cleanup endpoint is disabled",
    };
  }

  const match = /^bearer +(.+)$/i.exec(header ?? "");
  if (!match || !sameSecret(match[1], secret)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}
