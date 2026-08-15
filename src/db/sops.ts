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
import { and, desc, eq } from "drizzle-orm";

import { validateSopDraft } from "@/agent/sop-draft";
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

/** One row of the version list, for the picker and the diff view. */
export interface SopVersionSummary {
  versionId: string;
  version: number;
  changelog: string;
  createdBy: string;
  createdAt: Date;
  isActive: boolean;
}

/** Newest first — the editor opens on the active version and diffs backwards. */
export async function listSopVersions(
  db: Db,
  workspaceId: string,
  slug: string = SUPPORT_BILLING_SLUG,
): Promise<SopVersionSummary[]> {
  const rows = await db
    .select({
      versionId: sopVersions.id,
      version: sopVersions.version,
      changelog: sopVersions.changelog,
      createdBy: sopVersions.createdBy,
      createdAt: sopVersions.createdAt,
      activeVersionId: sops.activeVersionId,
    })
    .from(sops)
    .innerJoin(sopVersions, eq(sopVersions.sopId, sops.id))
    .where(and(eq(sops.workspaceId, workspaceId), eq(sops.slug, slug)))
    .orderBy(desc(sopVersions.version));

  return rows.map((r) => ({
    versionId: r.versionId,
    version: r.version,
    changelog: r.changelog,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    isActive: r.activeVersionId === r.versionId,
  }));
}

/** A single version's full body, for the diff view's left-hand side. */
export async function getSopVersion(
  db: Db,
  workspaceId: string,
  versionId: string,
): Promise<ActiveSop> {
  const [row] = await db
    .select({
      versionId: sopVersions.id,
      version: sopVersions.version,
      bodyMarkdown: sopVersions.bodyMarkdown,
      policyConfig: sopVersions.policyConfig,
    })
    .from(sopVersions)
    .where(
      and(
        eq(sopVersions.workspaceId, workspaceId),
        eq(sopVersions.id, versionId),
      ),
    )
    .limit(1);

  if (!row) throw new MissingActiveSopError(workspaceId, versionId);

  return {
    versionId: row.versionId,
    version: row.version,
    bodyMarkdown: row.bodyMarkdown,
    policyConfig: parsePolicyConfig(row.policyConfig),
  };
}

/**
 * Write an edited SOP as a new version and make it active.
 *
 * **Validated before the transaction opens.** `validateSopDraft` is the boot
 * validator's equivalent for policy: an activated version is the live system
 * prompt the moment it lands, so a document with a typo'd placeholder or a
 * policy above the absolute caps must never reach the insert.
 *
 * **Append-only.** Editing never mutates a row. Runs already in flight hold a
 * pinned `sop_version_id`, so they keep reading the exact bytes they were
 * briefed on, and the diff view has both sides to compare. It is also what
 * makes a Day 6 eval result attributable after the policy moves on.
 *
 * The insert and the pointer update share a transaction. Split, a crash between
 * them leaves a version nobody points at — invisible in the editor, and
 * indistinguishable from the save having failed.
 */
export async function createSopVersion(
  db: Db,
  input: {
    workspaceId: string;
    bodyMarkdown: string;
    policyConfig: unknown;
    changelog: string;
    createdBy: string;
    slug?: string;
  },
): Promise<ActiveSop> {
  const slug = input.slug ?? SUPPORT_BILLING_SLUG;
  const draft = validateSopDraft({
    bodyMarkdown: input.bodyMarkdown,
    policyConfig: input.policyConfig,
  });

  return db.transaction(async (tx) => {
    const [sop] = await tx
      .select({ id: sops.id })
      .from(sops)
      .where(and(eq(sops.workspaceId, input.workspaceId), eq(sops.slug, slug)))
      .limit(1);

    if (!sop) throw new MissingActiveSopError(input.workspaceId, slug);

    // Read inside the transaction: two concurrent saves would otherwise derive
    // the same number and collide on `sop_versions_sop_version_idx`. The unique
    // index is the real guarantee — this just makes the common case not race.
    const [highest] = await tx
      .select({ version: sopVersions.version })
      .from(sopVersions)
      .where(eq(sopVersions.sopId, sop.id))
      .orderBy(desc(sopVersions.version))
      .limit(1);

    const [created] = await tx
      .insert(sopVersions)
      .values({
        workspaceId: input.workspaceId,
        sopId: sop.id,
        version: (highest?.version ?? 0) + 1,
        // Stored unsubstituted. Rendering at save time is the drift bug this
        // whole feature exists to remove.
        bodyMarkdown: draft.bodyMarkdown,
        policyConfig: draft.policyConfig,
        changelog: input.changelog,
        createdBy: input.createdBy,
      })
      .returning({ id: sopVersions.id, version: sopVersions.version });

    await tx
      .update(sops)
      .set({ activeVersionId: created!.id })
      .where(eq(sops.id, sop.id));

    return {
      versionId: created!.id,
      version: created!.version,
      bodyMarkdown: draft.bodyMarkdown,
      policyConfig: draft.policyConfig,
    };
  });
}
