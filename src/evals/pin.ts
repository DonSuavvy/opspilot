/**
 * What an eval run is pinned to.
 *
 * PLAN.md: every run carries (SOP version, prompt version, model, git SHA), so
 * any two runs can be diffed and the difference attributed. The SOP version and
 * the model are ids the caller already holds; the other two are computed here.
 *
 * **Prompt version is a hash of the compiled text, not of the SOP row.** The
 * SOP version id already records which document ran. What it cannot record is
 * that `compileSop` rendered it differently — a placeholder added, a renderer
 * changed, a policy figure substituted from a different config. Those move the
 * bytes the model reads while leaving `sop_version_id` identical, which is
 * exactly the class of change that produces an unexplained regression.
 */
import { createHash } from "node:crypto";

import type { SystemBlock } from "@/agent/cache";

/**
 * Twelve hex characters — 48 bits.
 *
 * Long enough that a collision across the handful of prompt variants a project
 * ever has is not a real risk, short enough to read in a table header and
 * quote in a commit message. It is an identity label, not a security digest.
 */
const PIN_LENGTH = 12;

/**
 * The text a `system` argument actually sends.
 *
 * Blocks are concatenated and their `cache_control` ignored, so a prompt pins
 * the same whether or not caching is switched on. Caching changes what the
 * *provider* does with the prefix, not what the model reads, and a pin that
 * moved when it was toggled would report a prompt regression that never
 * happened.
 */
function systemText(system: string | SystemBlock[]): string {
  return typeof system === "string"
    ? system
    : system.map((block) => block.text).join("");
}

export function promptVersion(system: string | SystemBlock[]): string {
  return createHash("sha256")
    .update(systemText(system), "utf8")
    .digest("hex")
    .slice(0, PIN_LENGTH);
}

/** Runs `git rev-parse HEAD` and returns stdout. May throw; may return junk. */
export type GitShaExec = () => string;

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The commit this run's code came from, or null.
 *
 * CI first, because in CI the checked-out working tree can be a merge commit
 * that exists nowhere else while `GITHUB_SHA` names the commit under review.
 * Then Vercel's equivalent, for a run triggered from a deployment. The shell
 * is last and is the local-development answer.
 *
 * **Null is a legitimate result, so this never throws.** A missing SHA costs a
 * label on a diff; a throw here would take down an eval run that was otherwise
 * about to produce eight perfectly good results. The `exec` is injected for
 * the same reason `now` is everywhere else in this codebase — so the fallback
 * chain is testable without a git repository or a subprocess.
 */
export function resolveGitSha(
  env: Record<string, string | undefined>,
  exec?: GitShaExec,
): string | null {
  const fromEnv = nonEmpty(env.GITHUB_SHA) ?? nonEmpty(env.VERCEL_GIT_COMMIT_SHA);
  if (fromEnv) return fromEnv;

  if (!exec) return null;

  try {
    return nonEmpty(exec());
  } catch {
    return null;
  }
}
