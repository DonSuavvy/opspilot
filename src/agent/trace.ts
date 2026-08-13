/**
 * The boundary between a run in flight and the two things that consume it: the
 * `run_spans` table and the SSE trace stream.
 *
 * Everything here is a pure function of a `SpanEvent`, so it is testable
 * without a database or a socket — which matters, because all three hazards it
 * guards against surface only on real ticket text, at the edge, long after the
 * loop itself has been declared working.
 */
import { microsToUsdString, nanosToMicros } from "./cost";
import type { SpanEvent, SpanType } from "./loop";

/**
 * The `cost_usd` CHECK ceiling, mirrored from `src/db/schema.ts`. Kept as a
 * named constant rather than a magic number so the two are greppable together;
 * a drift shows up as a failed insert in `verify:seed`, not silently.
 */
export const MAX_SPAN_COST_USD = 10_000;

/**
 * Constructed, never written as a literal control byte.
 *
 * A raw NUL in source is invisible in review and indistinguishable from a
 * space on screen — which is exactly how a NUL-stripping function comes to
 * look like, and could silently become, a space-stripping one. This spelling
 * cannot be misread, and it survives every editor and diff tool intact.
 */
const NUL = String.fromCharCode(0);

export interface SpanRow {
  workspaceId: string;
  runId: string;
  seq: number;
  type: SpanType;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** numeric(12,6). A string, so no float ever rounds it on the way in. */
  costUsd: string;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Remove NUL from anything bound for a `jsonb` column.
 *
 * Postgres rejects NUL in jsonb outright — `unsupported Unicode escape
 * sequence`, raised on insert — and `JSON.stringify` emits exactly that escape
 * for a NUL anywhere in the value. A ticket body pasted out of a binary file
 * is enough to produce one.
 *
 * Safe *here* precisely because these columns are display and audit data.
 * `agent_runs.serialized_messages` is the opposite case and stays `text`:
 * replaying a paused turn requires passing thinking blocks back byte-identical,
 * so editing that payload is what the resume contract forbids.
 */
export function stripNuls<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes(NUL) ? value.replaceAll(NUL, "") : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNuls(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[stripNuls(k)] = stripNuls(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Shape one span for `run_spans`.
 *
 * The cost conversion happens exactly once, at this boundary: nano-dollars are
 * the accounting unit because the cache multipliers land off the micro grid,
 * and micro-dollars are the storage unit because that is what `numeric(12,6)`
 * holds.
 */
export function spanToRow(
  ids: { workspaceId: string; runId: string },
  span: SpanEvent,
): SpanRow {
  if (!Number.isFinite(span.costNanos) || span.costNanos < 0) {
    throw new RangeError(
      `trace: span ${span.seq} (${span.name}) has a negative or non-finite ` +
        `cost of ${String(span.costNanos)} nanos — cost_usd is CHECK'd >= 0`,
    );
  }

  const micros = nanosToMicros(span.costNanos);
  const costUsd = microsToUsdString(micros);

  if (Number(costUsd) > MAX_SPAN_COST_USD) {
    // Postgres would refuse this too, but as an opaque constraint violation
    // three layers below the arithmetic that produced it. Name the span.
    throw new RangeError(
      `trace: span ${span.seq} (${span.name}) costs $${costUsd}, above the ` +
        `$${MAX_SPAN_COST_USD} cost_usd ceiling — refusing to write it`,
    );
  }

  const usage = span.usage;

  return {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    seq: span.seq,
    type: span.type,
    name: span.name,
    input: stripNuls(span.input),
    output: stripNuls(span.output),
    isError: span.isError,
    // Zero, not null: a tool span consumed no tokens, and a null would make
    // SUM over the column behave differently for it than for every other row.
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage?.cacheCreationInputTokens ?? 0,
    costUsd,
    latencyMs: span.latencyMs,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
  };
}

/**
 * Frame one Server-Sent Event.
 *
 * SSE is newline-delimited: a raw `\n` inside `data:` terminates the field, so
 * a multi-line ticket body would arrive as two malformed events and the trace
 * viewer would drop the run without saying so. The single-line guarantee rests
 * entirely on `JSON.stringify` escaping newlines as the two characters `\` and
 * `n`, which is why the tests assert it rather than assume it.
 */
export function encodeSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
