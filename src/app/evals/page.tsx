/**
 * The Eval Lab — demo arc step 3.
 *
 * A server component, like the inbox and the SOP editor: the history is a
 * direct query and every label in it is resolved here, so the island below
 * owns only the streaming scorecard. Formatting on the server also keeps the
 * timestamps out of a client clock, which would render differently from the
 * server's own render of the same row and be reported as a hydration error.
 */
import Link from "next/link";

import { EvalLab, type EvalRunRow } from "@/components/eval-lab";
import { getDb } from "@/db/client";
import { listEvalRuns } from "@/db/evals";
import { workspaces } from "@/db/schema";
import { shortSha, sopLabel } from "@/lib/eval-labels";

// The history gains a row every time the button below is pressed.
export const dynamic = "force-dynamic";

/**
 * UTC, fixed width, no locale. This is a run log, and two readers comparing
 * timestamps across a diff link must be reading the same numbers.
 */
function formatStartedAt(startedAt: Date): string {
  return startedAt.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * `listEvalRuns` is newest first, so the older run of any adjacent pair is the
 * *next* one down. Getting this backwards is silent and expensive: the diff
 * would render with the runs swapped and report a regression as a fix.
 */
function toRows(runs: Awaited<ReturnType<typeof listEvalRuns>>): EvalRunRow[] {
  return runs.map((run, index) => ({
    id: run.id,
    sop: sopLabel(run),
    model: run.model,
    sha: shortSha(run.gitSha),
    passedCases: run.passedCases,
    totalCases: run.totalCases,
    costUsd: run.costUsd,
    startedAt: formatStartedAt(run.startedAt),
    previousId: runs[index + 1]?.id ?? null,
  }));
}

export default async function EvalsPage() {
  let rows: EvalRunRow[] = [];
  let loadError: string | null = null;
  let hasWorkspace = true;

  try {
    const db = getDb();
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .limit(1);

    if (!ws) {
      hasWorkspace = false;
    } else {
      rows = toRows(await listEvalRuns(db, ws.id));
    }
  } catch (error) {
    // Almost always an unseeded or unreachable database, and the command to
    // fix it is a better answer than a stack trace in the browser.
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Eval lab</h1>
          <Link href="/" className="text-sm text-zinc-500 underline">
            back to the inbox
          </Link>
          <Link href="/sop" className="text-sm text-zinc-500 underline">
            edit the SOP
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          The golden suite is eight real agent runs against the active SOP,
          scored on structure rather than prose. Run it, then diff a run against
          the one before it — a case that changed verdict names the assertion
          that moved and what it moved to.
        </p>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Could not read the run history.</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{loadError}</p>
          <p className="mt-2 font-mono text-xs">
            npm run db:up &amp;&amp; npm run db:migrate &amp;&amp; npm run db:seed
          </p>
        </div>
      ) : null}

      {!loadError && !hasWorkspace ? (
        <p className="text-sm text-zinc-500">
          No workspace found — run <code>npm run db:seed</code>.
        </p>
      ) : null}

      {!loadError && hasWorkspace ? <EvalLab runs={rows} /> : null}
    </main>
  );
}
