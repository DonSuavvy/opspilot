"use client";

/**
 * The Eval Lab — demo arc step 3, the half that moves.
 *
 * A client island for the same reason the run console is one: a suite is eight
 * sequential agent runs, and the thing worth showing is each case landing as it
 * finishes. A page that posted and waited would show a spinner for two minutes
 * and then a scorecard, which is indistinguishable from a screenshot.
 *
 * The history below is *not* client state. It arrives as props from the server
 * component, and a finished run calls `router.refresh()` to re-render it — so
 * the table a reader clicks "diff vs previous" in is always the database's
 * answer rather than a row this component appended to a list it was holding.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createSseParser } from "@/lib/sse";

/** One row of the history, with every label already resolved on the server. */
export interface EvalRunRow {
  id: string;
  /** `sopLabel(...)`, computed server-side so the two pages agree. */
  sop: string;
  model: string;
  /** `shortSha(...)`, likewise. */
  sha: string;
  passedCases: number;
  totalCases: number;
  costUsd: string;
  /**
   * Formatted on the server. A client-side clock read during render disagrees
   * with the server's render of the same row, which React reports as a
   * hydration error — over a timestamp nobody needs to the second.
   */
  startedAt: string;
  /** The next-older run, or null for the earliest. Fixes the diff direction. */
  previousId: string | null;
}

/** `run`, minus the `type` the route strips before sending. */
interface RunStarted {
  evalRunId: string;
  sopVersion: number;
  model: string;
  totalCases: number;
}

/** `case`. Only the fields the scorecard shows are declared. */
interface CaseFinished {
  slug: string;
  title: string;
  passed: boolean;
  failureReason: string | null;
  costUsd: string;
}

interface RunFinished {
  evalRunId: string;
  passed: number;
  failed: number;
  total: number;
  costUsd: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function EvalLab({ runs }: { runs: EvalRunRow[] }) {
  const router = useRouter();
  const [started, setStarted] = useState<RunStarted | null>(null);
  const [cases, setCases] = useState<CaseFinished[]>([]);
  const [totals, setTotals] = useState<RunFinished | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const runSuite = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setStarted(null);
    setCases([]);
    setTotals(null);
    setError(null);
    setRunning(true);

    try {
      const response = await fetch("/api/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No body fields: run the golden suite against whatever SOP is active,
        // on the default model. That is what the demo is demonstrating.
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      // Everything that can fail on configuration fails before the stream
      // headers go out, and comes back as JSON with a status. Reading the body
      // as a stream first would turn a legible "no workspace — run db:seed"
      // into a request that succeeded and said nothing.
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(payload?.error ?? `the suite could not start (${response.status})`);
        return;
      }

      if (!response.body) throw new Error("the response carried no stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const frame of parse(decoder.decode(value, { stream: true }))) {
          if (frame.event === "run") {
            setStarted(frame.data as RunStarted);
          } else if (frame.event === "case") {
            // Appended, never replaced: the order cases arrive in is the order
            // they ran, and the suite is sequential on purpose.
            setCases((prev) => [...prev, frame.data as CaseFinished]);
          } else if (frame.event === "done") {
            setTotals(frame.data as RunFinished);
          } else if (frame.event === "error") {
            setError((frame.data as { error: string }).error);
          }
        }
      }

      // The run row and its results are in Postgres now. Re-render the server
      // component so the history below gains the row, and the previous run
      // gains something to be diffed against.
      router.refresh();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(errorText(caught));
    } finally {
      setRunning(false);
    }
  }, [router]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runSuite} disabled={running}>
            {running ? "Running the suite…" : "Run suite"}
          </Button>
          {started ? (
            <span className="text-sm text-zinc-500">
              v{started.sopVersion} · {started.model} · {started.totalCases}{" "}
              cases
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950">
            <p className="font-medium">The suite did not finish.</p>
            <p className="mt-1 text-zinc-600 dark:text-zinc-300">{error}</p>
          </div>
        ) : null}

        {cases.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {cases.map((c) => (
              <li
                key={c.slug}
                className="flex flex-col gap-1 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
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
              </li>
            ))}
          </ol>
        ) : null}

        {totals ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <Badge variant={totals.failed === 0 ? "default" : "destructive"}>
              {totals.passed}/{totals.total}
            </Badge>
            <span className="text-zinc-500">
              {totals.failed === 0
                ? "every case passed"
                : `${totals.failed} failed`}
            </span>
            <span className="ml-auto font-mono text-xs text-zinc-500 tabular-nums">
              ${totals.costUsd}
            </span>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Run history</h2>

        {runs.length === 0 ? (
          <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
            No runs yet. Run the suite and the first one lands here, with a diff
            link as soon as there are two.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="py-2 pr-4 font-medium">Started</th>
                  <th className="py-2 pr-4 font-medium">SOP</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Commit</th>
                  <th className="py-2 pr-4 font-medium">Passed</th>
                  <th className="py-2 pr-4 font-medium">Cost</th>
                  <th className="py-2 font-medium">Links</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-b border-zinc-100 dark:border-zinc-900"
                  >
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap text-zinc-500 tabular-nums">
                      {run.startedAt}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{run.sop}</td>
                    <td className="py-2 pr-4">{run.model}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{run.sha}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {run.passedCases}/{run.totalCases}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs tabular-nums">
                      ${run.costUsd}
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      <Link
                        href={`/evals/${run.id}`}
                        className="text-zinc-500 underline"
                      >
                        results
                      </Link>
                      {run.previousId ? (
                        <Link
                          href={`/evals/diff?base=${run.previousId}&head=${run.id}`}
                          className="ml-3 text-zinc-500 underline"
                        >
                          diff vs previous
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
