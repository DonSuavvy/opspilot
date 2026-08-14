/**
 * The client half of the trace stream.
 *
 * `EventSource` is not usable here — it only issues GET, and starting a run is
 * a POST — so the browser reads the response body with a stream reader and
 * reassembles frames itself. This is the counterpart to `encodeSseEvent` in
 * `src/agent/trace.ts`; the two are tested as a round trip.
 *
 * Stateful by necessity: a chunk boundary falls wherever the network puts it,
 * so anything after the last complete frame is buffered until the rest of it
 * arrives. A parser that assumed one chunk is one frame would work against a
 * fast local server and drop spans against a slow one.
 */

export interface SseFrame {
  event: string;
  data: unknown;
}

const FRAME_SEPARATOR = "\n\n";

/**
 * Create a parser over one response body. Call it with each decoded chunk; it
 * returns the frames that completed in that chunk, which may be none.
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";

  return (chunk: string): SseFrame[] => {
    buffer += chunk;

    const frames: SseFrame[] = [];
    let separator = buffer.indexOf(FRAME_SEPARATOR);

    while (separator !== -1) {
      const raw = buffer.slice(0, separator);
      // Past the separator, not up to it: consuming only the frame would leave
      // the separator at index 0 and spin here forever.
      buffer = buffer.slice(separator + FRAME_SEPARATOR.length);

      const frame = parseFrame(raw);
      if (frame) frames.push(frame);

      separator = buffer.indexOf(FRAME_SEPARATOR);
    }

    // Whatever is left is an incomplete frame. Holding it back is the point:
    // a half-deserialized span in the waterfall is worse than a missing one,
    // because the trace is the thing being demonstrated.
    return frames;
  };
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message"; // the SSE default when no event field is sent
  const dataLines: string[] = [];

  // Comments (": keep-alive") need no branch of their own: a line starting
  // with ":" matches neither prefix below, so it contributes nothing and the
  // frame ends up with no data lines. An explicit `startsWith(":") continue`
  // was here and was removed — mutation testing showed no test could tell the
  // two versions apart, which is the definition of dead code. The behaviour is
  // still pinned by a test; it just is not implemented twice.
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    // One unparseable payload costs that frame, not the rest of the run.
    return null;
  }
}
