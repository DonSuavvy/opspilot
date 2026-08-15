/**
 * GET /api/sop  — the active version plus the version list.
 * POST /api/sop — save an edit as a new version and activate it.
 *
 * The POST is the first write path into `sop_versions`, so it is a trust
 * boundary: everything it receives came from a form. `createSopVersion` runs
 * `validateSopDraft` before the insert, and the errors below distinguish "you
 * typed something invalid" (400) from "the workspace is not seeded" (500),
 * because those need different fixes.
 */
import { UnknownPlaceholderError } from "@/agent/sop";
import { SopDraftError } from "@/agent/sop-draft";
import { getDb } from "@/db/client";
import { workspaces } from "@/db/schema";
import {
  createSopVersion,
  listSopVersions,
  loadActiveSop,
  MissingActiveSopError,
} from "@/db/sops";

export const dynamic = "force-dynamic";

/**
 * The demo has exactly one workspace. Day 8 replaces this with the visitor's
 * cookie-scoped sandbox; until then, resolving it here keeps the editor from
 * having to know an id it cannot discover.
 */
async function demoWorkspaceId(db: ReturnType<typeof getDb>) {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");
  return ws.id;
}

export async function GET() {
  try {
    const db = getDb();
    const workspaceId = await demoWorkspaceId(db);
    const [active, versions] = await Promise.all([
      loadActiveSop(db, workspaceId),
      listSopVersions(db, workspaceId),
    ]);
    return Response.json({ active, versions });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

interface SaveRequest {
  bodyMarkdown?: string;
  policyConfig?: unknown;
  changelog?: string;
}

export async function POST(request: Request) {
  let body: SaveRequest;
  try {
    body = (await request.json()) as SaveRequest;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  if (typeof body.bodyMarkdown !== "string") {
    return Response.json({ error: "bodyMarkdown is required" }, { status: 400 });
  }

  try {
    const db = getDb();
    const workspaceId = await demoWorkspaceId(db);
    const created = await createSopVersion(db, {
      workspaceId,
      bodyMarkdown: body.bodyMarkdown,
      policyConfig: body.policyConfig,
      changelog: body.changelog?.trim() || "Edited in the SOP editor.",
      createdBy: "editor",
    });
    // The refreshed list rides back on the save response. The alternative — a
    // follow-up GET — is a second round trip whose only job is to tell the
    // client what this request already knows.
    return Response.json({
      active: created,
      versions: await listSopVersions(db, workspaceId),
    });
  } catch (error) {
    // A rejected draft is the author's to fix, so it must not read as a server
    // fault — the message names the bad placeholder or the offending field.
    if (
      error instanceof SopDraftError ||
      error instanceof UnknownPlaceholderError
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MissingActiveSopError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
