"use client";

/**
 * Put this visitor's sandbox back the way it was found.
 *
 * A demo that has been clicked through twice is full of resolved tickets,
 * decided approvals and spent budget, and the person about to give the next
 * walkthrough needs one button rather than a database command.
 *
 * `router.refresh()` rather than a reload: the inbox is a server component, so
 * refreshing re-runs the query and repaints the list, the pending count and
 * the countdown from the rows that now exist. A full reload would also work
 * and would throw away the scroll position for nothing.
 *
 * The button asks twice. One stray click during a demo would wipe the trace
 * the room is looking at, and a second click is cheaper than an undo nobody
 * built.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type Phase = "idle" | "confirming" | "resetting" | "failed";

export function SandboxReset() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setPhase("resetting");
    setError(null);

    try {
      const response = await fetch("/api/sandbox/reset", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `reset failed (${response.status})`);
      }

      router.refresh();
      setPhase("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {phase === "confirming" ? (
        <>
          <Button
            variant="destructive"
            size="xs"
            onClick={() => void reset()}
          >
            Wipe it and re-seed
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setPhase("idle")}
          >
            Keep it
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          size="xs"
          disabled={phase === "resetting"}
          onClick={() => setPhase("confirming")}
        >
          {phase === "resetting" ? "Resetting…" : "Reset sandbox"}
        </Button>
      )}

      {error ? (
        <span className="text-xs text-amber-700 dark:text-amber-300">
          {error}
        </span>
      ) : null}
    </span>
  );
}
