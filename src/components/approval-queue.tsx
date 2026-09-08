"use client";

/**
 * The pending queue — every confirm-write call still waiting on a person.
 *
 * A client island because each row can be decided in place and then streams
 * its run to completion. The rows themselves are read and described on the
 * server; this component owns nothing but what happens after a click.
 */
import { useState } from "react";

import { ApprovalDecision } from "@/components/approval-decision";
import { Badge } from "@/components/ui/badge";
import type { Done } from "@/lib/agent-stream";

export interface ApprovalQueueRow {
  id: string;
  runId: string;
  /** Rendered on the server by `describeApproval`. */
  description: string;
  ticketSubject: string | null;
  customer: string | null;
  /** Formatted server-side: a client-side clock read would not match the
   * server render, and React would report the mismatch as a hydration error. */
  age: string;
  createdAt: string;
}

interface RowResult {
  status: string;
  outcome: Done["outcome"];
  error: string | null;
}

export function ApprovalQueue({ rows }: { rows: ApprovalQueueRow[] }) {
  // Keyed by approval id: each row decides its own run, and one row finishing
  // must not disturb the others still waiting.
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});

  const settle = (id: string, result: RowResult) =>
    setResults((prev) => ({ ...prev, [id]: result }));

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
        No pending approvals. Run a ticket that needs a refund and it will
        appear here.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {rows.map((row) => {
        const result = results[row.id];
        const steps = progress[row.id] ?? 0;

        return (
          <li
            key={row.id}
            className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-sm">{row.description}</p>
              <span
                className="text-xs text-zinc-500 tabular-nums"
                title={row.createdAt}
              >
                waiting {row.age}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              {row.ticketSubject ? <span>{row.ticketSubject}</span> : null}
              {row.customer ? (
                <span className="font-mono">{row.customer}</span>
              ) : null}
              {!row.ticketSubject && !row.customer ? (
                <span>No ticket behind this run.</span>
              ) : null}
            </div>

            {result ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{result.status.replaceAll("_", " ")}</Badge>
                  {result.outcome ? (
                    <span className="text-xs text-zinc-500">
                      {result.outcome.action} · confidence{" "}
                      {result.outcome.confidence}
                    </span>
                  ) : null}
                </div>
                {result.outcome ? (
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {result.outcome.reply}
                  </p>
                ) : null}
                {result.error ? (
                  <p className="text-sm text-red-700 dark:text-red-300">
                    {result.error}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <ApprovalDecision
                  runId={row.runId}
                  onStart={() => setProgress((p) => ({ ...p, [row.id]: 0 }))}
                  onSpan={() =>
                    setProgress((p) => ({ ...p, [row.id]: (p[row.id] ?? 0) + 1 }))
                  }
                  onDone={(done) =>
                    settle(row.id, {
                      status: done.status,
                      outcome: done.outcome,
                      error: done.error,
                    })
                  }
                  onError={(message) =>
                    settle(row.id, {
                      status: "failed",
                      outcome: null,
                      error: message,
                    })
                  }
                />
                {steps > 0 ? (
                  <span className="text-xs text-zinc-400 tabular-nums">
                    {steps} steps so far
                  </span>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
