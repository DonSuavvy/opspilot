/**
 * The client half of an agent run, shared by every island that starts one.
 *
 * Two do now: the run console starts a run, and the approval controls resume a
 * paused one. Both routes stream the same four events over the same framing, so
 * the read loop and the payload types live here rather than being copied — a
 * second copy is how the resumed half of a trace comes to render differently
 * from the first.
 *
 * Deliberately narrow: this owns the *body*, not the request. Whether a
 * non-OK response is a 409 that was already decided or a 500 with a config
 * message is the caller's question, because only the caller knows what it
 * asked for. Hand this a response that is already OK.
 */
import type { TokenUsage } from "@/agent/cost";
import type { LogicalModel } from "@/agent/provider";
import { createSseParser } from "@/lib/sse";

export interface Span {
  seq: number;
  type: "llm_call" | "tool_exec" | "guardrail" | "approval_wait";
  name: string;
  isError: boolean;
  costNanos: number;
  latencyMs: number;
  /**
   * Already on the wire — the routes enqueue the whole span — and declared
   * here because the console reads them: an `approval_wait` span carries the
   * pending call's arguments, which is what the queue prompt is written from.
   */
  input: unknown;
  output: unknown;
  /** All four token classes — the cache counters drive the badge. */
  usage: TokenUsage | null;
}

export interface Done {
  /** Both routes send it. The console keeps it to aim a resume at the run. */
  runId?: string;
  status: string;
  outcome: { action: string; reply: string; confidence: string } | null;
  iterations: number;
  costNanos: number;
  estimated: boolean;
  error: string | null;
  /** Logical name, not the wire id — the cache floor is per model. */
  model: LogicalModel;
  /**
   * All four token classes, not just input/output. The cache counters are what
   * make the cache badge a measurement rather than a guess.
   */
  usage: TokenUsage | null;
}

/** The opening event. `/api/agent/resume` adds `resumed`; `/run` does not. */
export interface RunStarted {
  runId: string;
  ticketId?: string | null;
  resumed?: boolean;
}

export interface AgentStreamHandlers {
  onRun?: (run: RunStarted) => void;
  onSpan: (span: Span) => void;
  onDone: (done: Done) => void;
  onError: (message: string) => void;
}

/**
 * Read one trace stream to its end, calling a handler per event.
 *
 * `EventSource` cannot be used — starting or resuming a run is a POST — so the
 * body is read with a stream reader and reassembled by `createSseParser`,
 * which is unit tested against every possible chunk boundary.
 */
export async function readAgentStream(
  response: Response,
  handlers: AgentStreamHandlers,
): Promise<void> {
  if (!response.body) {
    throw new Error("the response carried no stream to read");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();

  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;

    for (const frame of parse(decoder.decode(value, { stream: true }))) {
      if (frame.event === "run") {
        handlers.onRun?.(frame.data as RunStarted);
      } else if (frame.event === "span") {
        handlers.onSpan(frame.data as Span);
      } else if (frame.event === "done") {
        handlers.onDone(frame.data as Done);
      } else if (frame.event === "error") {
        handlers.onError((frame.data as { error: string }).error);
      }
    }
  }
}
