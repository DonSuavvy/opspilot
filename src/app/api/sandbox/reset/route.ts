/**
 * POST /api/sandbox/reset — throw this visitor's sandbox away and plant it again.
 *
 * The Reset button on the inbox. A demo that has been clicked through twice is
 * full of resolved tickets, spent budget and decided approvals, and the fix
 * has to be one click rather than an email asking someone to re-seed.
 *
 * Reset goes through `resetSandbox` rather than `sandboxFromRequest`, because
 * the two want opposite things from an existing workspace: one keeps it, the
 * other deletes it. Sharing a helper here would have meant a flag, and a flag
 * whose true branch deletes a tenant is worth avoiding.
 *
 * The slug comes from the header the proxy stamped, so a visitor can only ever
 * reset their own sandbox. Nothing in the body is read at all.
 */
import { getDb } from "@/db/client";
import { resetSandbox } from "@/db/sandbox";
import { SANDBOX_HEADER } from "@/lib/sandbox";
import {
  requireSandboxHeader,
  SandboxHeaderMissingError,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let slug: string;
  try {
    slug = requireSandboxHeader(request.headers.get(SANDBOX_HEADER));
  } catch (error) {
    if (error instanceof SandboxHeaderMissingError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const { expiresAt } = await resetSandbox(getDb(), slug, new Date());
    return Response.json({ ok: true, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
