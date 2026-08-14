import { describe, expect, it } from "vitest";

import { encodeSseEvent } from "@/agent/trace";
import { createSseParser, type SseFrame } from "./sse";

/**
 * The client half of the trace stream.
 *
 * `EventSource` cannot be used here: it only issues GET, and starting a run is
 * a POST. So the browser reads the body with `fetch` + a stream reader and has
 * to reassemble frames itself — which puts the framing contract on both sides
 * of the wire, and makes the split-chunk case ours to get right.
 *
 * **That case is the whole reason this file exists.** A network chunk boundary
 * falls wherever TCP puts it, so a parser that assumes each chunk is a whole
 * frame works perfectly against a fast local server and drops spans against a
 * slow one. It is the kind of bug that shows up only in the demo.
 */

/** Feed a whole stream through in arbitrary slices. */
function parseInSlices(stream: string, sliceAt: number[]): SseFrame[] {
  const parse = createSseParser();
  const frames: SseFrame[] = [];
  let cursor = 0;
  for (const at of [...sliceAt, stream.length]) {
    frames.push(...parse(stream.slice(cursor, at)));
    cursor = at;
  }
  return frames;
}

describe("createSseParser", () => {
  it("reads one complete frame from one chunk", () => {
    const parse = createSseParser();
    expect(parse(encodeSseEvent("span", { seq: 0 }))).toEqual([
      { event: "span", data: { seq: 0 } },
    ]);
  });

  it("reads several frames delivered together", () => {
    const parse = createSseParser();
    const chunk =
      encodeSseEvent("span", { seq: 0 }) + encodeSseEvent("span", { seq: 1 });

    expect(parse(chunk).map((f) => (f.data as { seq: number }).seq)).toEqual([
      0, 1,
    ]);
  });

  /**
   * The one that matters. Sliced at every single byte offset, the parser must
   * still yield exactly the frames that went in — no duplicates, no drops, no
   * half-parsed JSON.
   */
  it("reassembles frames no matter where the chunk boundary falls", () => {
    const stream =
      encodeSseEvent("run", { runId: "r1" }) +
      encodeSseEvent("span", { seq: 0, name: "get_customer" }) +
      encodeSseEvent("done", { status: "completed" });

    for (let cut = 1; cut < stream.length; cut++) {
      const frames = parseInSlices(stream, [cut]);
      expect(frames.map((f) => f.event), `split at byte ${cut}`).toEqual([
        "run",
        "span",
        "done",
      ]);
    }
  });

  it("survives a boundary landing inside the JSON payload", () => {
    const stream = encodeSseEvent("span", { name: "search_kb", seq: 3 });
    const mid = stream.indexOf("search_kb") + 4;

    expect(parseInSlices(stream, [mid])).toEqual([
      { event: "span", data: { name: "search_kb", seq: 3 } },
    ]);
  });

  /**
   * A partial frame is not a frame. Emitting it early would put a
   * half-deserialized span into the waterfall, which is worse than showing
   * nothing — the trace is the product here.
   */
  it("holds an incomplete frame back rather than guessing", () => {
    const parse = createSseParser();
    const stream = encodeSseEvent("span", { seq: 7 });

    expect(parse(stream.slice(0, stream.length - 2))).toEqual([]);
    expect(parse(stream.slice(stream.length - 2))).toEqual([
      { event: "span", data: { seq: 7 } },
    ]);
  });

  /**
   * Ticket bodies are multi-line and reach the client as tool input. The
   * encoder guarantees one `data:` line by leaning on JSON escaping; this is
   * the other half of that contract, verified as a round trip rather than
   * assumed.
   */
  it("round-trips a multi-line payload the encoder escaped", () => {
    const payload = { body: "Hello,\nI'd like a refund.\n\nThanks" };
    const parse = createSseParser();

    expect(parse(encodeSseEvent("span", payload))).toEqual([
      { event: "span", data: payload },
    ]);
  });

  /**
   * A stream that dies mid-frame — the run crashed, the tab slept, the
   * connection dropped — must not take the frames already delivered with it.
   */
  it("keeps earlier frames when the stream ends mid-frame", () => {
    const parse = createSseParser();
    const chunk = encodeSseEvent("span", { seq: 0 }) + "event: span\ndata: {";

    expect(parse(chunk)).toEqual([{ event: "span", data: { seq: 0 } }]);
  });

  /**
   * Defensive, because the payload is JSON produced elsewhere: one unparseable
   * frame should cost that frame, not the rest of the run.
   */
  it("skips a malformed frame and keeps reading", () => {
    const parse = createSseParser();
    const chunk =
      "event: span\ndata: {not json}\n\n" + encodeSseEvent("done", { ok: true });

    expect(parse(chunk)).toEqual([{ event: "done", data: { ok: true } }]);
  });

  /** SSE comments and keep-alives are legal and carry no data. */
  it("ignores comment frames used as keep-alives", () => {
    const parse = createSseParser();
    expect(parse(": keep-alive\n\n")).toEqual([]);
  });
});
