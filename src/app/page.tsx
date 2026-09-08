/**
 * The inbox — demo arc step 1.
 *
 * A server component, so the ticket list is a direct query rather than a route
 * handler the browser has to call: there is no client state here worth the
 * round trip, and it keeps `getDb()` on the server where it belongs. The live
 * part — running a ticket and watching the trace build — is the one client
 * island below.
 */
import { count, desc, eq } from "drizzle-orm";

import Link from "next/link";

import { RunConsole, type TicketSummary } from "@/components/run-console";
import { getDb } from "@/db/client";
import { approvals, customers, tickets } from "@/db/schema";

// The inbox reflects run state, which changes underneath any cache.
export const dynamic = "force-dynamic";

async function loadTickets(): Promise<TicketSummary[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: tickets.id,
      subject: tickets.subject,
      suspectedInjection: tickets.suspectedInjection,
      customer: customers.externalId,
    })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .orderBy(desc(tickets.createdAt))
    .limit(20);

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    customer: r.customer,
    suspectedInjection: r.suspectedInjection,
  }));
}

/**
 * How many calls are waiting on a person, for the header link.
 *
 * Unfiltered by workspace, exactly as `loadTickets` above is: this page shows
 * one demo tenant, and a count scoped differently from the list beside it
 * would be the more confusing of the two answers.
 */
async function countPendingApprovals(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ pending: count() })
    .from(approvals)
    .where(eq(approvals.status, "pending"));

  return row?.pending ?? 0;
}

export default async function Home() {
  let ticketList: TicketSummary[] = [];
  let pendingApprovals = 0;
  let loadError: string | null = null;

  try {
    [ticketList, pendingApprovals] = await Promise.all([
      loadTickets(),
      countPendingApprovals(),
    ]);
  } catch (error) {
    // The most likely cause by far is an unseeded or unreachable database, and
    // a stack trace in the browser is a worse answer than the command to fix it.
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">OpsPilot</h1>
          <Link href="/sop" className="text-sm text-zinc-500 underline">
            edit the SOP
          </Link>
          <Link href="/approvals" className="text-sm text-zinc-500 underline">
            {pendingApprovals > 0
              ? `approvals (${pendingApprovals})`
              : "approvals"}
          </Link>
          <Link href="/evals" className="text-sm text-zinc-500 underline">
            eval lab
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Support and billing agent for Beacon Analytics. Pick a ticket and run
          it — the trace below streams in as the agent works, span by span, with
          cost accruing live.
        </p>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Could not read the inbox.</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{loadError}</p>
          <p className="mt-2 font-mono text-xs">
            npm run db:up &amp;&amp; npm run db:migrate &amp;&amp; npm run db:seed
          </p>
        </div>
      ) : (
        <RunConsole tickets={ticketList} />
      )}
    </main>
  );
}
