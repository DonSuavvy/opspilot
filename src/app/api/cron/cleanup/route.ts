/**
 * GET /api/cron/cleanup — delete every sandbox past its TTL.
 *
 * Two jobs in one request, and the second is the reason the schedule is daily
 * rather than weekly. The sweep keeps the database from accumulating a
 * workspace per visitor forever, and the request itself keeps Neon's free tier
 * from suspending the branch, which would otherwise put a cold start in front
 * of the first person to open the demo.
 *
 * **A 24 hour TTL means 24 to 48 hours of life.** Vercel Hobby runs crons once
 * a day at an approximate time, so a sandbox that expires an hour after the
 * sweep waits for tomorrow's. That is fine, and it is worth writing down
 * because the alternative reading, "sandboxes vanish exactly a day later", is
 * the one someone will debug against.
 *
 * Excluded from the proxy matcher on purpose. There is no browser here, so
 * minting a slug would seed a workspace nobody will ever open, and the sweep
 * would then have to clean up after itself.
 */
import { getDb } from "@/db/client";
import { sweepExpiredSandboxes } from "@/db/sandbox";
import { authorizeCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authorizeCron(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );

  if (!auth.ok) {
    // Logged for the 500 only. A 401 is the endpoint working, and logging
    // every unauthenticated probe would bury the one line that matters.
    if (auth.status === 500) console.error(`[cron/cleanup] ${auth.error}`);
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const at = new Date();

  try {
    const swept = await sweepExpiredSandboxes(getDb(), at);
    console.log(`[cron/cleanup] swept ${swept} expired sandboxes`);
    return Response.json({ swept, at: at.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cron/cleanup] sweep failed: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
