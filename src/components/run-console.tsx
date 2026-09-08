"use client";

/**
 * The live trace viewer — demo arc step 1.
 *
 * Spans arrive over SSE as the run happens and are appended in order, so the
 * waterfall builds itself in front of the viewer rather than appearing whole at
 * the end. That difference is the entire point of the feature: anyone can show
 * a finished transcript, and almost nobody can show the agent thinking.
 *
 * The stream itself is read by `readAgentStream`, shared with the approval
 * controls so a resumed run renders through the same code path as the first
 * half of its own trace.
 */
import { useCallback, useRef, useState } from "react";

import { describeRunCache, type CacheStatus } from "@/agent/cache";
import type { TokenUsage } from "@/agent/cost";
import { ApprovalDecision } from "@/components/approval-decision";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeApproval } from "@/lib/approval-copy";
import { readAgentStream, type Done, type Span } from "@/lib/agent-stream";

export interface TicketSummary {
  id: string;
  subject: string;
  customer: string | null;
  suspectedInjection: boolean;
}

/**
 * Tone by what actually happened. `below_threshold` is deliberately neutral
 * rather than red: a prefix under the model's floor is a fact about the prompt,
 * not a fault, and colouring it as an error would push whoever reads this
 * toward padding the SOP to turn the badge green — which is exactly the theatre
 * the honest-display decision rejected.
 */
const CACHE_TONE: Record<CacheStatus, string> = {
  hit: "bg-emerald-100 text-emerald-900",
  write: "bg-sky-100 text-sky-900",
  below_threshold: "bg-zinc-100 text-zinc-600",
  miss: "bg-zinc-100 text-zinc-600",
};

const usd = (nanos: number) => `$${(nanos / 1_000_000_000).toFixed(6)}`;

/** Widest span drives the bar scale, so the shape survives a fast or slow run. */
function barWidth(latencyMs: number, slowest: number) {
  if (slowest <= 0) return "2%";
  return `${Math.max(2, Math.round((latencyMs / slowest) * 100))}%`;
}

const SPAN_STYLE: Record<Span["type"], string> = {
  llm_call: "bg-violet-500",
  tool_exec: "bg-emerald-500",
  guardrail: "bg-amber-500",
  approval_wait: "bg-sky-500",
};

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  paused_for_approval: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  budget_refused: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  refused: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  failed: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

export function RunConsole({ tickets }: { tickets: TicketSummary[] }) {
  const [selected, setSelected] = useState<TicketSummary | null>(
    tickets[0] ?? null,
  );
  const [spans, setSpans] = useState<Span[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  // Kept so the decision controls below can aim a resume at this run. The
  // `run` event carries it from the first byte; `done` repeats it.
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(async (ticket: TicketSummary) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setSpans([]);
    setDone(null);
    setRunId(null);
    setError(null);
    setRunning(true);

    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: ticket.id }),
        signal: controller.signal,
      });

      // Config failures come back as JSON before the stream opens — that is
      // the only window in which a status code is still available to report.
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error ?? `run failed (${response.status})`);
      }

      await readAgentStream(response, {
        onRun: (started) => setRunId(started.runId),
        onSpan: (span) => setSpans((prev) => [...prev, span]),
        onDone: (finished) => {
          if (finished.runId) setRunId(finished.runId);
          setDone(finished);
        },
        onError: setError,
      });
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setRunning(false);
    }
  }, []);

  // Cost ticks up live rather than landing at the end — the demo's whole claim
  // is that this is observable while it happens.
  const liveCost = spans.reduce((total, s) => total + s.costNanos, 0);

  /**
   * Measured, and computed **per model call** rather than from the run total.
   *
   * Summing first was a real bug: a Haiku run with prompts of 2618 and 2945
   * tokens reported "prefix was eligible but not cached", because 5563 clears
   * the 4096 floor even though neither prompt ever did. Token counts sum across
   * calls; eligibility does not.
   */
  const cache = done
    ? describeRunCache({
        model: done.model,
        usages: spans
          .filter((s) => s.type === "llm_call")
          .map((s) => s.usage)
          .filter((u): u is TokenUsage => u != null),
      })
    : null;
  const slowest = spans.reduce((max, s) => Math.max(max, s.latencyMs), 0);

  /**
   * The **last** approval wait, not the first. A resumed run can pause again
   * on a second confirm-write in the same turn, and the question on screen has
   * to be the one still unanswered.
   */
  const waits = spans.filter((s) => s.type === "approval_wait");
  const awaiting = waits.length > 0 ? waits[waits.length - 1] : undefined;
  const asking = awaiting
    ? describeApproval({ toolName: awaiting.name, toolInput: awaiting.input })
    : "A confirm-write tool is waiting for a decision.";
  const pausedRunId =
    done?.status === "paused_for_approval" ? runId : null;

  return (
    // Two columns from `md`, not `lg`: the trace is the thing being
    // demonstrated, and at 1024px it fell below the fold on any laptop-sized
    // split view — the viewer had to scroll away from the inbox to watch it.
    <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
      <section aria-label="Inbox" className="flex flex-col gap-2">
        <h2 className="px-1 text-sm font-medium text-zinc-500">
          Inbox · {tickets.length} open
        </h2>
        {tickets.map((ticket) => {
          const active = selected?.id === ticket.id;
          return (
            <button
              key={ticket.id}
              onClick={() => setSelected(ticket)}
              className={`rounded-lg border p-3 text-left transition ${
                active
                  ? "border-zinc-900 bg-white dark:border-zinc-100 dark:bg-zinc-900"
                  : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium">{ticket.subject}</span>
                {ticket.suspectedInjection ? (
                  <Badge variant="destructive" className="shrink-0">
                    adversarial
                  </Badge>
                ) : null}
              </div>
              <span className="text-xs text-zinc-500">
                {ticket.customer ?? "unidentified customer"}
              </span>
            </button>
          );
        })}
      </section>

      <section aria-label="Trace" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => selected && run(selected)}
            disabled={!selected || running}
          >
            {running ? "Running…" : "Run agent"}
          </Button>
          <span className="font-mono text-sm tabular-nums text-zinc-500">
            {usd(liveCost)}
            {done?.estimated ? " (estimated)" : ""}
          </span>
          {done ? (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                STATUS_TONE[done.status] ?? "bg-zinc-100 text-zinc-900"
              }`}
            >
              {done.status.replaceAll("_", " ")} · {done.iterations} iterations
            </span>
          ) : null}
          {cache ? (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${CACHE_TONE[cache.status]}`}
              title={cache.label}
            >
              {cache.label}
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        ) : null}

        <ol className="flex flex-col gap-1">
          {spans.map((span) => (
            <li
              key={span.seq}
              className="grid grid-cols-[2rem_9rem_1fr_auto] items-center gap-3 rounded px-2 py-1.5 text-sm odd:bg-zinc-50 dark:odd:bg-zinc-900/50"
            >
              <span className="font-mono text-xs text-zinc-400">
                {span.seq}
              </span>
              <span className="truncate font-mono text-xs" title={span.name}>
                {span.type === "llm_call" ? "model" : span.name}
              </span>
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 rounded-sm ${
                    span.isError ? "bg-red-500" : SPAN_STYLE[span.type]
                  }`}
                  style={{ width: barWidth(span.latencyMs, slowest) }}
                />
                <span className="font-mono text-xs tabular-nums text-zinc-400">
                  {span.latencyMs}ms
                </span>
              </span>
              <span className="font-mono text-xs tabular-nums text-zinc-500">
                {span.usage
                  ? `${span.usage.inputTokens}/${span.usage.outputTokens} tok · `
                  : ""}
                {usd(span.costNanos)}
              </span>
            </li>
          ))}
          {running ? (
            <li className="px-2 py-1.5 text-sm text-zinc-400">waiting…</li>
          ) : null}
        </ol>

        {done?.outcome ? (
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="mb-2 flex items-center gap-2">
              <Badge>{done.outcome.action}</Badge>
              <span className="text-xs text-zinc-500">
                confidence: {done.outcome.confidence}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6">
              {done.outcome.reply}
            </p>
          </div>
        ) : null}

        {pausedRunId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950">
            <div>
              <p className="text-sm font-medium">
                Paused for human approval — nothing has run yet.
              </p>
              <p className="mt-1 font-mono text-sm text-zinc-600 dark:text-zinc-300">
                {asking}
              </p>
            </div>
            <ApprovalDecision
              runId={pausedRunId}
              onStart={() => {
                setError(null);
                setRunning(true);
              }}
              onSpan={(span) => setSpans((prev) => [...prev, span])}
              onDone={(finished) => {
                setDone(finished);
                setRunning(false);
              }}
              onError={(message) => {
                setError(message);
                setRunning(false);
              }}
            />
          </div>
        ) : null}

        {done && !done.outcome && done.status !== "paused_for_approval" ? (
          <p className="text-sm text-zinc-500">
            {done.error ?? "No structured outcome."}
          </p>
        ) : null}
      </section>
    </div>
  );
}
