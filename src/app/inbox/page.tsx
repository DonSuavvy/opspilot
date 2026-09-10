/**
 * The inbox — demo arc step 1.
 *
 * A server component, so the ticket list is a direct query rather than a route
 * handler the browser has to call: there is no client state here worth the
 * round trip, and it keeps `getDb()` on the server where it belongs. The live
 * part — running a ticket and watching the trace build — is the one client
 * island below.
 */
import { and, count, desc, eq } from "drizzle-orm";

import Link from "next/link";

import { budgetConfigSchema } from "@/agent/budget";
import { RunConsole, type TicketSummary } from "@/components/run-console";
import { getDb } from "@/db/client";
import { budgetGauge, type BudgetGauge } from "@/db/ops";
import { spentTodayNanos } from "@/db/runs";
import { approvals, customers, tickets } from "@/db/schema";
import { SandboxReset } from "@/components/sandbox-reset";
import {
  currentSandbox,
  SandboxHeaderMissingError,
} from "@/lib/workspace";

// The inbox reflects run state, which changes underneath any cache.
export const dynamic = "force-dynamic";

async function loadTickets(workspaceId: string): Promise<TicketSummary[]> {
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
    .where(eq(tickets.workspaceId, workspaceId))
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
 * Scoped to the visitor's sandbox, exactly as `loadTickets` above is. These
 * two used to be unfiltered together, which was consistent while there was one
 * tenant and would now count a stranger's paused refund into this reader's
 * badge.
 */
async function countPendingApprovals(workspaceId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ pending: count() })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, "pending"),
      ),
    );

  return row?.pending ?? 0;
}

/**
 * How long this sandbox has left, in the coarsest unit that is still true.
 *
 * Formatted on the server for the same reason `formatAge` is on the approvals
 * page: a client island reading its own clock during render disagrees with the
 * server's render of the same number, and React reports that as a hydration
 * error.
 */
function formatRemaining(expiresAt: Date, now: Date): string {
  const minutes = Math.round((expiresAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "any moment now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

const NANOS_PER_USD = 1_000_000_000;

const usd = (nanos: number) => `$${(nanos / NANOS_PER_USD).toFixed(2)}`;

/**
 * What the spend guard would say if a run were started right now, worked out
 * before the button is drawn rather than after it is pressed.
 *
 * **Never throws, which is the whole point.** `budgetConfigSchema` fails
 * closed — a missing `OPSPILOT_DAILY_BUDGET_USD` throws rather than defaulting
 * to unlimited — and that is right for a run and wrong here. Inside the page's
 * main try it would set `loadError`, hide the entire inbox, and tell the
 * reader to re-seed the database over a missing line in a `.env`. So this
 * degrades to "no banner": the inbox still renders, and the run route still
 * refuses on its own terms, because the gate has never been this page.
 */
interface BudgetView {
  gauge: BudgetGauge;
  spentNanos: number;
  capNanos: number;
}

async function loadBudgetView(workspaceId: string): Promise<BudgetView | null> {
  try {
    const parsed = budgetConfigSchema.safeParse(process.env);
    if (!parsed.success) return null;

    const db = getDb();
    const spentNanos = await spentTodayNanos(db, workspaceId, new Date());
    const capNanos = parsed.data.dailyCapNanos;

    return {
      gauge: budgetGauge({
        spentNanos,
        capNanos,
        killSwitch: parsed.data.killSwitch,
      }),
      spentNanos,
      capNanos,
    };
  } catch {
    return null;
  }
}

export default async function Home() {
  let ticketList: TicketSummary[] = [];
  let pendingApprovals = 0;
  let budget: BudgetView | null = null;
  let loadError: string | null = null;
  let resetsIn: string | null = null;

  try {
    // Seeds on the spot for a first-time visitor, so the list below is never
    // empty for want of a workspace nobody planted.
    const sandbox = await currentSandbox();
    resetsIn = formatRemaining(sandbox.expiresAt, new Date());

    [ticketList, pendingApprovals, budget] = await Promise.all([
      loadTickets(sandbox.workspaceId),
      countPendingApprovals(sandbox.workspaceId),
      loadBudgetView(sandbox.workspaceId),
    ]);
  } catch (error) {
    // A missing sandbox header means the proxy did not run for this route.
    // The message below tells the reader to rebuild Postgres, which would be
    // a long way to go for a matcher typo.
    if (error instanceof SandboxHeaderMissingError) throw error;
    // The most likely cause by far is an unseeded or unreachable database, and
    // a stack trace in the browser is a worse answer than the command to fix it.
    loadError = error instanceof Error ? error.message : String(error);
  }

  // `exhausted` and `killed` are the two states in which `reserveRun` will
  // refuse, so they are exactly the two in which the button must not pretend.
  const state = budget?.gauge.state;
  const intakePaused = state === "exhausted" || state === "killed";

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">OpsPilot</h1>
          <Link href="/ops" className="text-sm text-zinc-500 underline">
            mission control
          </Link>
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

        {/*
          Two facts a visitor needs before they start clicking: this copy is
          theirs alone, and it does not last. The Reset button is next to the
          sentence rather than in a menu because the moment someone wants it is
          the moment they have made a mess.
        */}
        {resetsIn ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-zinc-500">
              This sandbox is yours alone. It resets in {resetsIn}.
            </p>
            <SandboxReset />
          </div>
        ) : null}

        {/*
          Quieter than the banner and deliberately so: approaching a cap is a
          fact worth knowing, not a reason to stop reading. Escalating it to a
          box would teach whoever sees it to skip the box that matters.
        */}
        {budget && state === "warning" ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            {budget.gauge.percent.toFixed(1)}% of today&apos;s budget is spent —{" "}
            {usd(budget.gauge.remainingNanos)} left.
          </p>
        ) : null}
      </header>

      {/*
        The honest banner PLAN.md's budget pillar asks for. It says which of
        the two reasons applies, because "paused" alone leaves a viewer unable
        to tell a spent cap — which clears at midnight — from a switch someone
        pulled on purpose.
      */}
      {budget && intakePaused ? (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">
            {state === "killed"
              ? "Intake is paused: the kill switch is on."
              : `Intake is paused: the daily budget is spent (${usd(
                  budget.spentNanos,
                )} of ${usd(budget.capNanos)}).`}
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">
            Runs already paused for approval can still be decided.{" "}
            <Link href="/ops" className="underline">
              Mission control
            </Link>{" "}
            has the numbers.
          </p>
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Could not read the inbox.</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{loadError}</p>
          <p className="mt-2 font-mono text-xs">
            npm run db:up &amp;&amp; npm run db:migrate &amp;&amp; npm run
            db:seed
          </p>
        </div>
      ) : (
        <RunConsole tickets={ticketList} intakePaused={intakePaused} />
      )}
    </main>
  );
}
