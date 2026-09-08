"use client";

/**
 * Approve or deny one paused run, and stream what happens next.
 *
 * Used twice over: inline in the run console, where the decision continues the
 * trace the viewer is already watching, and once per row on the approvals
 * queue. Both need the same thing — a decision, a reason, and the run carrying
 * on in front of you — so the component owns the request and the caller owns
 * where the spans land.
 *
 * The reason box is required on a denial because the route requires it, and
 * the route requires it because the agent reads it: a refusal comes back as an
 * error tool result, and "refused, no reason given" makes for a poor reply to
 * a customer.
 */
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { readAgentStream, type Done, type Span } from "@/lib/agent-stream";

export interface ApprovalDecisionProps {
  runId: string;
  onSpan: (span: Span) => void;
  onDone: (done: Done) => void;
  onError: (message: string) => void;
  /** Fired the moment the request goes out, so a caller can show it working. */
  onStart?: () => void;
}

type Phase = "idle" | "resuming" | "completed" | "paused" | "failed";

const PHASE_COPY: Record<Exclude<Phase, "idle">, string> = {
  resuming: "Resuming the run…",
  completed: "Resumed, and the run finished.",
  paused: "Paused again — the run reached another confirm-write call.",
  failed: "The resume did not go through.",
};

/**
 * A resumed run can end three ways, and only one of them is done. Pausing
 * again is normal: a turn can hold more than one confirm-write, and each pause
 * decides exactly one.
 */
function phaseFor(status: string): Phase {
  if (status === "completed") return "completed";
  if (status === "paused_for_approval") return "paused";
  return "failed";
}

export function ApprovalDecision({
  runId,
  onSpan,
  onDone,
  onError,
  onStart,
}: ApprovalDecisionProps) {
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");

  const streaming = phase === "resuming";
  const trimmed = reason.trim();

  const decide = useCallback(
    async (approved: boolean) => {
      setPhase("resuming");
      onStart?.();

      try {
        const response = await fetch("/api/agent/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: runId,
            decision: approved ? "approve" : "deny",
            reason: trimmed.length > 0 ? trimmed : undefined,
            decided_by: "operator",
          }),
        });

        // Everything that can go wrong before the loop starts comes back as
        // JSON with a status. A 409 is the interesting one: the decision
        // UPDATE matches only a pending row, so this is the request that lost
        // the race rather than a fault worth retrying.
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          const fallback = `resume failed (${response.status})`;
          setPhase("failed");
          onError(
            response.status === 409
              ? `Already decided — ${detail.error ?? fallback}`
              : (detail.error ?? fallback),
          );
          return;
        }

        await readAgentStream(response, {
          onSpan,
          onDone: (done) => {
            setPhase(phaseFor(done.status));
            onDone(done);
          },
          onError: (message) => {
            setPhase("failed");
            onError(message);
          },
        });
      } catch (caught) {
        setPhase("failed");
        onError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        // A stream that ends with neither a done nor an error left the buttons
        // disabled forever. Only the still-resuming case is touched, so this
        // cannot overwrite a real outcome.
        setPhase((current) => (current === "resuming" ? "failed" : current));
      }
    },
    [runId, trimmed, onSpan, onDone, onError, onStart],
  );

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Reason — required to deny, optional to approve
        <textarea
          className="h-16 rounded border border-zinc-300 bg-white p-2 text-xs leading-relaxed text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={streaming}
          spellCheck={false}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => decide(true)} disabled={streaming}>
          Approve
        </Button>
        <Button
          variant="outline"
          onClick={() => decide(false)}
          disabled={streaming || trimmed.length === 0}
        >
          Deny
        </Button>
        {phase === "idle" ? null : (
          <span className="text-xs text-zinc-500">{PHASE_COPY[phase]}</span>
        )}
      </div>
    </div>
  );
}
