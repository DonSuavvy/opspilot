/**
 * One eval run, in full — the page "results" links to.
 *
 * A server component with no island: nothing here moves. The run finished
 * before this URL existed, and every number on it is a row.
 *
 * Failed cases sort first. A scorecard is read to find out what broke, and a
 * suite of eight with one red case buries it in the middle otherwise.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { getEvalRun, type EvalRunDetail } from "@/db/evals";
import { workspaces } from "@/db/schema";
import { compactJson, shortSha, sopLabel } from "@/lib/eval-labels";

export const dynamic = "force-dynamic";

/**
 * Null for "no such run", including a malformed id.
 *
 * `eval_runs.id` is a uuid column, so Postgres answers `/evals/garbage` with
 * `invalid input syntax for type uuid` — an exception, not an empty result.
 * Without this catch a typo'd URL renders the error boundary instead of the
 * 404 it is, and the two say very different things about whether the run ever
 * existed.
 */
async function loadRun(id: string): Promise<EvalRunDetail | null> {
  try {
    const db = getDb();
    // The demo has one workspace, and the lookup is scoped to it rather than
    // trusting the id in the URL: a run belonging elsewhere is a 404 here,
    // which is what it is.
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    if (!ws) return null;

    return await getEvalRun(db, id, ws.id);
  } catch {
    return null;
  }
}

function Pin({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

export default async function EvalRunPage(props: PageProps<"/evals/[id]">) {
  const { id } = await props.params;
  const detail = await loadRun(id);

  if (!detail) notFound();

  const { run, results } = detail;
  // Copied before sorting: `sort` is in place, and the array belongs to the
  // query result rather than to this render.
  const cases = [...results].sort(
    (a, b) => Number(a.passed) - Number(b.passed),
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Eval run</h1>
          <Link href="/evals" className="text-sm text-zinc-500 underline">
            back to the eval lab
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          What this run was pinned to, and every assertion it made. Two runs are
          comparable only where these four agree, so they are the first thing on
          the page.
        </p>
      </header>

      <dl className="mb-8 flex flex-wrap gap-x-10 gap-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <Pin label="SOP" value={sopLabel(run)} />
        <Pin label="Model" value={run.model} />
        <Pin label="Commit" value={shortSha(run.gitSha)} />
        <Pin label="Prompt version" value={run.promptVersion ?? "none"} />
        <Pin
          label="Started"
          value={run.startedAt.toISOString().slice(0, 16).replace("T", " ")}
        />
        <Pin
          label="Passed"
          value={`${run.passedCases}/${run.totalCases}`}
        />
        <Pin label="Cost" value={`$${run.costUsd}`} />
        <Pin label="Status" value={run.status} />
      </dl>

      {cases.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          This run recorded no results. A run that died before its first case
          leaves the row and nothing under it.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {cases.map((c) => (
            <li
              key={c.slug}
              className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={c.passed ? "default" : "destructive"}>
                  {c.passed ? "pass" : "fail"}
                </Badge>
                <span className="text-sm font-medium">{c.title}</span>
                <span className="font-mono text-xs text-zinc-400">
                  {c.slug}
                </span>
                <span className="ml-auto font-mono text-xs text-zinc-500 tabular-nums">
                  ${c.costUsd}
                </span>
              </div>

              {c.failureReason ? (
                <p className="text-sm text-red-700 dark:text-red-300">
                  {c.failureReason}
                </p>
              ) : null}

              {c.assertions.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  No assertions recorded — the case threw before it was scored.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-zinc-500">
                      <tr className="border-b border-zinc-200 dark:border-zinc-800">
                        <th className="py-1 pr-4 font-medium">Assertion</th>
                        <th className="py-1 pr-4 font-medium">Expected</th>
                        <th className="py-1 pr-4 font-medium">Actual</th>
                        <th className="py-1 font-medium">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.assertions.map((a) => (
                        <tr
                          key={a.name}
                          className="border-b border-zinc-100 dark:border-zinc-900"
                        >
                          <td className="py-1 pr-4 font-mono whitespace-nowrap">
                            {a.name}
                          </td>
                          <td className="py-1 pr-4 font-mono">
                            {compactJson(a.expected)}
                          </td>
                          <td className="py-1 pr-4 font-mono">
                            {compactJson(a.actual)}
                          </td>
                          <td className="py-1">
                            {a.passed ? (
                              <span className="text-zinc-500">pass</span>
                            ) : (
                              <span className="text-red-700 dark:text-red-300">
                                fail
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {c.agentRunId ? (
                // Text, not a link: there is no run page to point at yet.
                <p className="font-mono text-xs text-zinc-400">
                  agent run {c.agentRunId}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
