/**
 * Reading the active SOP version.
 *
 * The one rule here: a run resolves its SOP version **once**, at the start, and
 * everything downstream reads that id rather than asking "what is active now".
 * `agent_runs.sop_version_id` exists to record the answer.
 *
 * Without that, an edit landing mid-run — or a Day 6 eval sweep re-pointing the
 * active version while a run is in flight — lets `issue_refund` revalidate
 * against version N+1 while the model was briefed on N. That is precisely the
 * prompt/code disagreement `compileSop` was written to eliminate, reintroduced
 * one layer up where the compiler cannot see it. It is also what makes an eval
 * result attributable: "pinned to (SOP version, model, git SHA)" is only true
 * if the run wrote the version down.
 */
import { and, eq } from "drizzle-orm";

import { parsePolicyConfig, type PolicyConfig } from "@/policy/refund";

import type { Db } from "./client";
import { sops, sopVersions } from "./schema";

/** The demo workspace ships exactly one SOP; Day 8's sandboxes clone it. */
export const SUPPORT_BILLING_SLUG = "support-billing";

export interface ActiveSop {
  /** Pin this onto the run. */
  versionId: string;
  /** Monotonic per sop, shown in the trace and the diff view. */
  version: number;
  /** Unsubstituted — pass through `compileSop`, never to the model directly. */
  bodyMarkdown: string;
  /** The machine-readable half `issue_refund` revalidates against. */
  policyConfig: PolicyConfig;
}

export class MissingActiveSopError extends Error {
  constructor(workspaceId: string, slug: string) {
    super(
      `workspace ${workspaceId} has no active version for SOP "${slug}" — ` +
        `run \`npm run db:seed\``,
    );
    this.name = "MissingActiveSopError";
  }
}

/**
 * Load the version a run should be pinned to.
 *
 * Throws rather than falling back to a default policy. A silent fallback would
 * run the agent against figures nobody configured and record a run whose
 * `sop_version_id` is null, which reads downstream as "this run predates SOP
 * versioning" rather than "the lookup failed".
 *
 * `policyConfig` is parsed through the Zod schema, not cast. The column is
 * `jsonb` and the editor writes to it, so the database is an untrusted boundary
 * exactly like the model is — an out-of-range refund ceiling that reached the
 * row must fail here rather than at the moment money moves.
 */
export async function loadActiveSop(
  db: Db,
  workspaceId: string,
  slug: string = SUPPORT_BILLING_SLUG,
): Promise<ActiveSop> {
  const [row] = await db
    .select({
      versionId: sopVersions.id,
      version: sopVersions.version,
      bodyMarkdown: sopVersions.bodyMarkdown,
      policyConfig: sopVersions.policyConfig,
    })
    .from(sops)
    .innerJoin(sopVersions, eq(sops.activeVersionId, sopVersions.id))
    .where(and(eq(sops.workspaceId, workspaceId), eq(sops.slug, slug)))
    .limit(1);

  if (!row) {
    throw new MissingActiveSopError(workspaceId, slug);
  }

  return {
    versionId: row.versionId,
    version: row.version,
    bodyMarkdown: row.bodyMarkdown,
    policyConfig: parsePolicyConfig(row.policyConfig),
  };
}
