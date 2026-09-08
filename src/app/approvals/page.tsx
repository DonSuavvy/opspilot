/**
 * The approval queue — the human's half of the confirm-write loop, listed.
 *
 * A server component, like the inbox and the SOP editor: the rows are a direct
 * query, described on the server, and the one client island below owns only
 * what happens after a reviewer clicks.
 */
import Link from "next/link";

import {
  ApprovalQueue,
  type ApprovalQueueRow,
} from "@/components/approval-queue";
import { describeApproval, listPendingApprovals } from "@/db/approvals";
import { getDb } from "@/db/client";
import { workspaces } from "@/db/schema";

// The queue is run state, and a cached one would show refunds already paid.
export const dynamic = "force-dynamic";

/**
 * Formatted here rather than in the browser. A client island reading its own
 * clock during render disagrees with the server's render of the same row, and
 * React reports that as a hydration error — over a number nobody needs to the
 * second.
 */
function formatAge(createdAt: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - createdAt.getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

async function loadQueue(): Promise<ApprovalQueueRow[] | null> {
  const db = getDb();
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (!ws) return null;

  const now = new Date();
  const pending = await listPendingApprovals(db, ws.id);

  return pending.map((row) => ({
    id: row.id,
    runId: row.runId,
    description: describeApproval(row),
    ticketSubject: row.ticketSubject,
    customer: row.customer,
    age: formatAge(row.createdAt, now),
    createdAt: row.createdAt.toISOString(),
  }));
}

export default async function ApprovalsPage() {
  let rows: ApprovalQueueRow[] | null = [];
  let loadError: string | null = null;

  try {
    rows = await loadQueue();
  } catch (error) {
    // Almost always an unseeded or unreachable database, and the command to
    // fix it is a better answer than a stack trace in the browser.
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <Link href="/" className="text-sm text-zinc-500 underline">
            back to the inbox
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Every confirm-write call the agent stopped on. Nothing here has run.
          Approving one carries its run on from where it paused; denying one
          hands the agent your reason, which it answers the customer with.
        </p>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Could not read the queue.</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{loadError}</p>
          <p className="mt-2 font-mono text-xs">
            npm run db:up &amp;&amp; npm run db:migrate &amp;&amp; npm run db:seed
          </p>
        </div>
      ) : null}

      {!loadError && rows === null ? (
        <p className="text-sm text-zinc-500">
          No workspace found — run <code>npm run db:seed</code>.
        </p>
      ) : null}

      {!loadError && rows !== null ? <ApprovalQueue rows={rows} /> : null}
    </main>
  );
}
