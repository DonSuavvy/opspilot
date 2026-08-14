/**
 * The production `MessageCreator`.
 *
 * This is the only place the loop's narrow wire types meet the SDK's, and the
 * only place the agent actually talks to a model. It exists so that everything
 * upstream — ordering, refusal handling, the spend pre-flight, tool dispatch —
 * is testable against scripted turns instead of a network.
 *
 * **Streamed, then assembled by the SDK.** `.stream()` avoids the HTTP timeouts
 * a long non-streaming turn invites, and `finalMessage()` hands back the
 * complete message with `usage` already reconciled. That second half is the
 * point: on the streaming path the four token counts arrive across several
 * event types, and reassembling them by hand is precisely how a run comes to
 * book zero cache cost without anyone noticing. Let the SDK do it.
 *
 * **No `thinking`, no `effort`.** The demo runs Haiku 4.5, which has neither —
 * sending either is an error rather than a no-op. When quality mode routes to
 * Sonnet/Opus (4.6 on covara), those parameters belong here, chosen from the
 * logical model, and nowhere else.
 */
import type { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";

import type { AssistantTurn, MessageCreator } from "./loop";

type AnthropicLike = Anthropic | AnthropicBedrock;

/**
 * The casts are contained here on purpose.
 *
 * The loop's `ContentBlock` is deliberately open-ended so thinking blocks and
 * whatever the API adds next round-trip untouched; the SDK's is a closed
 * discriminated union. They describe the same JSON, and this is the boundary
 * that says so once rather than at every call site.
 */
export function streamingMessageCreator(client: AnthropicLike): MessageCreator {
  return async (params) => {
    const stream = client.messages.stream({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages as Parameters<
        AnthropicLike["messages"]["stream"]
      >[0]["messages"],
      tools: params.tools as Parameters<
        AnthropicLike["messages"]["stream"]
      >[0]["tools"],
    });

    const message = await stream.finalMessage();
    return message as unknown as AssistantTurn;
  };
}
