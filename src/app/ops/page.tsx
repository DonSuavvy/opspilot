/**
 * Mission Control — PLAN.md's "production system" signals, and the page an
 * operator opens when something looks wrong.
 *
 * A server component with no client island, because nothing here is
 * interactive. That is not a shortcut: a dashboard that can change the thing
 * it reports on is a worse instrument, and the read-only shape is what lets
 * every number be a direct query rather than a fetch the browser has to make
 * and a spinner someone has to watch.
 *
 * The honesty rule from the cache badge applies to every figure below. Costs
 * on Bedrock are estimates charged at a safety multiple, and the card says so
 * in the same place it shows the number rather than in a footnote — a spend
 * figure that looks measured when it is guessed is the one lie this page
 * cannot afford.
 */
import Link from "next/link";

import {
  budgetConfigSchema,
  ESTIMATED_RUN_NANOS,
  UNVERIFIED_RATE_SAFETY_FACTOR,
  type BudgetConfig,
} from "@/agent/budget";
import { providerFromEnv } from "@/agent/provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/db/client";
import { opsSnapshot, type BudgetState, type OpsSnapshot } from "@/db/ops";
import { workspaces } from "@/db/schema";

// Every number here is run state, and a cached one is a wrong one.
export const dynamic = "force-dynamic";

const NANOS_PER_USD = 1_000_000_000;

function usd(nanos: number): string {
  return `$${(nanos / NANOS_PER_USD).toFixed(4)}`;
}

/**
 * Tone by what the number means, not by how alarming it looks. `warning` is
 * amber rather than red because eighty percent of a budget is a fact worth
 * knowing and not yet a fault, and `killed` is the darkest because it is the
 * only state a person had to choose.
 */
const STATE_TONE: Record<BudgetState, string> = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  exhausted:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  killed: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

const STATE_LABEL: Record<BudgetState, string> = {
  ok: "within budget",
  warning: "approaching the cap",
  exhausted: "cap reached",
  killed: "kill switch on",
};

const BAR_TONE: Record<BudgetState, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exhausted: "bg-amber-500",
  killed: "bg-red-500",
};

/** UTC, fixed width, no locale — an operator comparing rows wants one clock. */
function formatAt(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * What the page is allowed to say about cost accuracy, read from the provider
 * rather than asserted.
 *
 * `rateCard(...).verifiedOn` is the fact; the sentence is derived from it. If
 * someone reads covara's Cost Explorer line items and sets a real card with a
 * date, this stops claiming an estimate on its own — which is the whole point
 * of deriving it, because a hardcoded disclaimer outlives the condition that
 * justified it and turns into noise nobody reads.
 */
function costHonesty(): string {
  try {
    const card = providerFromEnv(process.env).rateCard("haiku");
    if (card.verifiedOn) {
      return `Costs use rates verified on ${card.verifiedOn}, charged at face value.`;
    }
  } catch {
    // No provider configured. The claim below is still the true one for this
    // deployment, so state it plainly rather than hiding the caveat.
  }
  return (
    `Costs are estimates: the Bedrock rate card is unverified, so the spend ` +
    `guard charges every run at ${UNVERIFIED_RATE_SAFETY_FACTOR}x to err toward ` +
    `refusing a run that would have been affordable.`
  );
}

async function loadSnapshot(): Promise<{
  snapshot: OpsSnapshot;
  config: BudgetConfig;
} | null> {
  const db = getDb();
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (!ws) return null;

  // Parsed here rather than at module scope: a cap that will not parse should
  // fail this page's budget card, not the import graph of everything that
  // transitively reaches it.
  const config = budgetConfigSchema.parse(process.env);
  return {
    snapshot: await opsSnapshot(db, ws.id, new Date(), config),
    config,
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function BudgetCard({ snapshot }: { snapshot: OpsSnapshot }) {
  const { gauge } = snapshot;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget today</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_TONE[gauge.state]}`}
          >
            {STATE_LABEL[gauge.state]}
          </span>
          <span className="font-mono text-lg tabular-nums">
            {usd(snapshot.spentTodayNanos)}
          </span>
          <span className="text-sm text-zinc-500">
            of {usd(snapshot.capNanos)} · {gauge.percent.toFixed(1)}%
          </span>
        </div>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          role="img"
          aria-label={`${gauge.percent.toFixed(1)} percent of the daily budget spent`}
        >
          <div
            className={`h-full rounded-full ${BAR_TONE[gauge.state]}`}
            style={{ width: `${gauge.percent}%` }}
          />
        </div>

        <dl className="grid grid-cols-2 gap-4">
          <Stat label="Remaining" value={usd(gauge.remainingNanos)} />
          <Stat label="Reserved per run" value={usd(ESTIMATED_RUN_NANOS)} />
        </dl>

        <p className="text-xs leading-5 text-zinc-500">{costHonesty()}</p>
      </CardContent>
    </Card>
  );
}

function LimitsCard({ snapshot }: { snapshot: OpsSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Limits</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Badge variant={snapshot.killSwitch ? "destructive" : "secondary"}>
            {snapshot.killSwitch ? "kill switch on" : "kill switch off"}
          </Badge>
          <span className="text-xs text-zinc-500">
            {snapshot.killSwitch
              ? "No run may start, whatever the budget says."
              : "Runs start subject to the budget and the rate limit."}
          </span>
        </div>
        <dl className="grid grid-cols-3 gap-4">
          <Stat
            label="Runs per minute"
            value={String(snapshot.runsPerMinute)}
          />
          <Stat
            label="Started last minute"
            value={`${snapshot.runsInLastMinute} / ${snapshot.runsPerMinute}`}
          />
          <Stat label="In flight" value={String(snapshot.inFlight)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function RunsCard({ snapshot }: { snapshot: OpsSnapshot }) {
  const statuses = Object.entries(snapshot.runsToday.byStatus).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runs today</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-lg tabular-nums">
          {snapshot.runsToday.total}
        </p>
        {statuses.length > 0 ? (
          <table className="w-full text-sm">
            <tbody>
              {statuses.map(([status, n]) => (
                <tr
                  key={status}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1 text-zinc-600 dark:text-zinc-300">
                    {status.replaceAll("_", " ")}
                  </td>
                  <td className="py-1 text-right font-mono tabular-nums">
                    {n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-zinc-500">
            No runs since midnight UTC. Start one from the inbox.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function QueuesCard({ snapshot }: { snapshot: OpsSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queues</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <div>
          <dt className="text-xs text-zinc-500">Waiting on a person</dt>
          <dd className="font-mono text-lg tabular-nums">
            {snapshot.pendingApprovals}
          </dd>
          <Link href="/approvals" className="text-xs text-zinc-500 underline">
            open the approval queue
          </Link>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Eval runs today</dt>
          <dd className="font-mono text-lg tabular-nums">
            {snapshot.evalRunsToday}
          </dd>
          <Link href="/evals" className="text-xs text-zinc-500 underline">
            open the eval lab
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function GuardrailsCard({ snapshot }: { snapshot: OpsSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent guardrails</CardTitle>
      </CardHeader>
      <CardContent>
        {snapshot.recentGuardrails.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="pb-2 font-normal">When</th>
                  <th className="pb-2 font-normal">Gate</th>
                  <th className="pb-2 font-normal">What it stopped</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentGuardrails.map((row) => (
                  <tr
                    key={`${row.runId}-${row.startedAt.toISOString()}-${row.name}`}
                    className="border-t border-zinc-100 align-top dark:border-zinc-800"
                  >
                    <td className="whitespace-nowrap py-1.5 pr-4 font-mono text-xs text-zinc-500">
                      {formatAt(row.startedAt)}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs">
                      {row.isError ? (
                        <span className="text-red-700 dark:text-red-300">
                          {row.name}
                        </span>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td className="py-1.5 text-zinc-600 dark:text-zinc-300">
                      {row.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            Nothing has been blocked. A guardrail row appears when the policy
            engine, the spend guard, or a human reviewer refuses a tool call.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default async function OpsPage() {
  let loaded: Awaited<ReturnType<typeof loadSnapshot>> = null;
  let loadError: string | null = null;

  try {
    loaded = await loadSnapshot();
  } catch (error) {
    // Usually an unseeded database or a missing daily cap, and the command to
    // fix either is a better answer than a stack trace in the browser.
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Mission control
          </h1>
          <Link href="/" className="text-sm text-zinc-500 underline">
            back to the inbox
          </Link>
          <Link href="/approvals" className="text-sm text-zinc-500 underline">
            approvals
          </Link>
          <Link href="/evals" className="text-sm text-zinc-500 underline">
            eval lab
          </Link>
          <Link href="/sop" className="text-sm text-zinc-500 underline">
            edit the SOP
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          What the agent is allowed to spend, how fast it may start runs, and
          every gate that has refused a tool call. Read only — nothing on this
          page changes what it reports.
        </p>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Could not read the operating state.</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{loadError}</p>
          <p className="mt-2 font-mono text-xs">
            npm run db:up &amp;&amp; npm run db:migrate &amp;&amp; npm run
            db:seed
          </p>
        </div>
      ) : null}

      {!loadError && loaded === null ? (
        <p className="text-sm text-zinc-500">
          No workspace found — run <code>npm run db:seed</code>.
        </p>
      ) : null}

      {loaded !== null ? (
        <div className="flex flex-col gap-6">
          <div className="grid gap-6 md:grid-cols-2">
            <BudgetCard snapshot={loaded.snapshot} />
            <LimitsCard snapshot={loaded.snapshot} />
            <RunsCard snapshot={loaded.snapshot} />
            <QueuesCard snapshot={loaded.snapshot} />
          </div>
          <GuardrailsCard snapshot={loaded.snapshot} />
        </div>
      ) : null}
    </main>
  );
}
