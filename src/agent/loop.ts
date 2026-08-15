/**
 * The hand-rolled agent loop.
 *
 * **Why this is not the SDK's tool runner.** Pause/resume across serverless
 * invocations means serializing the message array *mid-loop* and rebuilding it
 * in a later invocation, which the SDK runner does not expose. That single
 * requirement is also the Vercel-timeout answer and the approval-queue
 * mechanism, so the loop stays ours. PLAN.md calls this out as load-bearing.
 *
 * **The client is an interface, not a client.** The loop depends on
 * `MessageCreator` — `(params) => Promise<AssistantTurn>` — and nothing else.
 * The production adapter streams from Bedrock and returns the SDK's assembled
 * final message; the tests hand it scripted turns. Two things fall out of that
 * split. `npm test` needs no API key, and the four-field `usage` object is
 * assembled by the SDK rather than by hand — on the streaming path those
 * counts arrive across several event types, and reassembling them manually is
 * how a run silently books zero cache cost.
 *
 * **What the loop owns.** Ordering and refusal handling, the per-call spend
 * pre-flight, tool dispatch and error containment, the approval pause, and the
 * span stream. What it does not own: the database, HTTP, the wall clock, or
 * pricing. Those arrive as arguments, which is what keeps this testable
 * without a database and deterministic in the eval suite.
 */
import { checkBudget, type BudgetConfig, type BudgetRefusal } from "./budget";
import type { SystemBlock } from "./cache";
import {
  costOf,
  type CacheTtl,
  type RateCard,
  type TokenUsage,
} from "./cost";
import { ToolRegistryError, type ToolContext, type ToolRegistry } from "./registry";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Deliberately open at the end. Thinking blocks — and whatever the API adds
 * next — must round-trip back to the model byte-identical, so the loop copies
 * assistant content wholesale rather than reconstructing the blocks it knows.
 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/**
 * The subset of the Anthropic `Message` this loop reads. The SDK's type
 * satisfies it structurally, so the production adapter is a pass-through and
 * the tests can build one in four lines.
 */
export interface AssistantTurn {
  content: ContentBlock[];
  stop_reason: string | null;
  /**
   * Populated *only* on a refusal — and nullable even then, which is why the
   * loop branches on `stop_reason` and treats this as detail rather than
   * signal. `if (stop_details)` is the wrong test and misses refusals.
   */
  stop_details?: { type: string; category?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  /**
   * A bare string, or blocks when the prefix is marked cacheable.
   *
   * Both shapes reach the API unchanged; the loop never inspects or rebuilds
   * this. Prompt caching is a byte-level prefix match, so anything that
   * normalised the text in passing would change the cache key and drop the hit
   * rate for a reason nothing in the trace would explain.
   */
  system: string | SystemBlock[];
  messages: MessageParam[];
  tools: unknown[];
}

export type MessageCreator = (
  params: MessageCreateParams,
) => Promise<AssistantTurn>;

/* -------------------------------------------------------------------------- */
/* Spans                                                                      */
/* -------------------------------------------------------------------------- */

export type SpanType = "llm_call" | "tool_exec" | "guardrail" | "approval_wait";

/**
 * One row of the flight recorder, shaped for `run_spans`. Emitted as it
 * happens rather than collected at the end, so the SSE trace and the database
 * writer are the same code path — a run that dies halfway still has its spans.
 */
export interface SpanEvent {
  seq: number;
  type: SpanType;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no `verifiedOn` date. */
  estimated: boolean;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Input and result                                                           */
/* -------------------------------------------------------------------------- */

export interface AgentLoopInput {
  registry: ToolRegistry;
  createMessage: MessageCreator;
  /** The provider's wire id. Logical names are resolved in provider.ts. */
  model: string;
  rates: RateCard;
  /** Pass `cachedSystem(prompt)` to mark the prefix cacheable. */
  system: string | SystemBlock[];
  messages: MessageParam[];
  toolContext: ToolContext;
  budget: { config: BudgetConfig; spentTodayNanos: number };
  /**
   * What one model call is assumed to cost, for the pre-flight only. A guard
   * can only refuse *before* the spend, and the true cost is unknowable until
   * after — so the caller supplies an estimate and the loop reconciles with
   * the real figure once the turn returns.
   */
  estimatedCallNanos: number;
  maxIterations?: number;
  maxTokens?: number;
  cacheTtl?: CacheTtl;
  /**
   * Whether to ask the provider for constrained decoding.
   *
   * Defaults to **off**, from measurement rather than preference: Bedrock
   * rejects the nine-tool set with `400 Compiled grammar size (329.9MB)
   * exceeds maximum allowed size (300MB)`, and that is the only provider this
   * project actually runs on. `scripts/probe-grammar.ts` has the breakdown.
   *
   * Nothing is weakened by leaving it off. The wire schema constrains the
   * model; Zod constrains reality. Every tool call is parsed with the tool's
   * own schema below, before its handler sees it.
   */
  strictTools?: boolean;
  /** Injected like `now` everywhere else here — never `Date.now()`. */
  clock: () => Date;
  emit: (span: SpanEvent) => void | Promise<void>;
}

export type AgentLoopStatus =
  | "completed"
  | "paused_for_approval"
  | "refused"
  | "failed"
  | "budget_refused";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  /** The terminal tool's structured input. Null unless status is completed. */
  outcome: unknown | null;
  iterations: number;
  usage: TokenUsage;
  costNanos: number;
  estimated: boolean;
  messages: MessageParam[];
  /** Set on pause: what /api/agent/resume rebuilds the conversation from. */
  serializedMessages: string | null;
  pendingApproval: {
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
  } | null;
  refusal: { category: string | null } | null;
  budgetReason: BudgetRefusal | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

/** PLAN.md's loop guard. Twelve is generous for the seeded scenarios. */
const DEFAULT_MAX_ITERATIONS = 12;

/** Haiku 4.5 tops out at 64K; this leaves headroom without inviting essays. */
const DEFAULT_MAX_TOKENS = 8_192;

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function toTokenUsage(u: AssistantTurn["usage"]): TokenUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

/**
 * Tool results go back as strings. `undefined` is not JSON, and a handler that
 * returns nothing is a successful call — reporting it as `"null"` rather than
 * dropping the block keeps the tool_use/tool_result pairing intact, which the
 * API requires.
 */
function stringifyResult(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return json ?? "null";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAgentLoop(
  input: AgentLoopInput,
): Promise<AgentLoopResult> {
  const {
    registry,
    createMessage,
    model,
    rates,
    system,
    toolContext,
    budget,
    estimatedCallNanos,
    clock,
    emit,
  } = input;

  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const tools = registry.toAnthropicTools({
    strict: input.strictTools ?? false,
  });
  const rateVerified = rates.verifiedOn !== null;

  const messages: MessageParam[] = [...input.messages];
  let seq = 0;
  let iterations = 0;
  let accruedNanos = 0;
  let totals: TokenUsage = { ...EMPTY_USAGE };
  let estimated = false;

  const base = () => ({
    iterations,
    usage: totals,
    costNanos: accruedNanos,
    estimated,
    messages,
    outcome: null,
    serializedMessages: null,
    pendingApproval: null,
    refusal: null,
    budgetReason: null,
    error: null,
  });

  const span = async (
    s: Omit<SpanEvent, "seq" | "startedAt" | "endedAt" | "latencyMs"> & {
      startedAt: Date;
    },
  ) => {
    const endedAt = clock();
    await emit({
      ...s,
      seq: seq++,
      endedAt,
      latencyMs: endedAt.getTime() - s.startedAt.getTime(),
    });
  };

  while (iterations < maxIterations) {
    // Pre-flight, every call, against the baseline *plus* what this run has
    // already spent. Checking once at the top from a figure read before the
    // loop started would let twelve iterations spend twelve times the amount
    // the run was cleared for.
    const decision = checkBudget({
      spentTodayNanos: budget.spentTodayNanos + accruedNanos,
      estimatedRunNanos: estimatedCallNanos,
      rateVerified,
      config: budget.config,
    });

    if (!decision.allowed) {
      const startedAt = clock();
      await span({
        type: "guardrail",
        name: "budget",
        input: {
          spentTodayNanos: budget.spentTodayNanos + accruedNanos,
          estimatedCallNanos,
          rateVerified,
        },
        output: decision,
        isError: true,
        usage: null,
        costNanos: 0,
        estimated,
        startedAt,
      });
      return {
        ...base(),
        status: "budget_refused",
        budgetReason: decision.reason,
        error: `budget: refused (${decision.reason})`,
      };
    }

    iterations += 1;

    const llmStartedAt = clock();
    let assistant: AssistantTurn;
    try {
      assistant = await createMessage({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools,
      });
    } catch (error) {
      await span({
        type: "llm_call",
        name: model,
        input: { messages: messages.length },
        output: { error: errorText(error) },
        isError: true,
        usage: null,
        costNanos: 0,
        estimated,
        startedAt: llmStartedAt,
      });
      return { ...base(), status: "failed", error: errorText(error) };
    }

    const turnUsage = toTokenUsage(assistant.usage);
    const cost = costOf(rates, turnUsage, { cacheTtl: input.cacheTtl });
    totals = addUsage(totals, turnUsage);
    accruedNanos += cost.totalNanos;
    estimated = estimated || cost.estimated;

    await span({
      type: "llm_call",
      name: model,
      input: { messages: messages.length },
      output: {
        stop_reason: assistant.stop_reason,
        blocks: assistant.content.map((b) => b.type),
      },
      isError: false,
      usage: turnUsage,
      costNanos: cost.totalNanos,
      estimated: cost.estimated,
      startedAt: llmStartedAt,
    });

    // Before `content`, never after. A refused turn can still carry a tool_use
    // block, and a loop that inspected content first would fire a tool off a
    // response the model declined to stand behind.
    if (assistant.stop_reason === "refusal") {
      return {
        ...base(),
        status: "refused",
        refusal: { category: assistant.stop_details?.category ?? null },
        error: "model refused the request",
      };
    }

    messages.push({ role: "assistant", content: assistant.content });

    const toolUses = assistant.content.filter(isToolUse);

    if (toolUses.length === 0) {
      // Talking is not finishing. Every run must end through the terminal
      // tool, because the eval scorers read its structured output.
      messages.push({
        role: "user",
        content:
          `You have not finished. Call ${registry.terminalToolName} exactly ` +
          `once with a structured outcome to end this run.`,
      });
      continue;
    }

    const results: ToolResultBlock[] = [];
    let terminalOutcome: unknown | null = null;
    let sawTerminal = false;

    for (const call of toolUses) {
      const startedAt = clock();
      const definition = registry.get(call.name);

      // Unknown names are model output from Day 2 onward, so this is an input
      // to survive rather than a programmer error. `requiresApproval` throws
      // on unknown names by design; answering the model is the loop's job.
      if (!definition) {
        const detail = `unknown tool "${call.name}" — it is not registered`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      let requiresApproval: boolean;
      try {
        requiresApproval = registry.requiresApproval(call.name);
      } catch (error) {
        const detail =
          error instanceof ToolRegistryError
            ? error.issues.join("; ")
            : errorText(error);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      // The pause. Everything decided so far is already on `messages`, and the
      // pending tool_use is the last thing on it — resume injects the matching
      // tool_result and carries on from exactly here.
      if (requiresApproval) {
        await span({
          type: "approval_wait",
          name: call.name,
          input: call.input,
          output: { toolUseId: call.id },
          isError: false,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        return {
          ...base(),
          status: "paused_for_approval",
          serializedMessages: JSON.stringify(messages),
          pendingApproval: {
            toolUseId: call.id,
            toolName: call.name,
            toolInput: call.input,
          },
        };
      }

      // The wire schema was stripped of numeric and string constraints so the
      // model is told less than the code enforces. Zod is what actually guards
      // the handler, so parsing happens here and a failure never reaches it.
      const parsed = definition.input.safeParse(call.input);
      if (!parsed.success) {
        const detail = `invalid arguments for ${call.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      try {
        const output = await definition.handler(parsed.data, toolContext);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: stringifyResult(output),
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: parsed.data,
          output,
          isError: false,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });

        if (definition.terminal === true) {
          sawTerminal = true;
          terminalOutcome = parsed.data;
        }
      } catch (error) {
        // `issue_refund` rejects out-of-policy calls by throwing, and the agent
        // is expected to adapt — usually by escalating. That only works if the
        // throw becomes a result the model can read.
        const detail = errorText(error);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: parsed.data,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
      }
    }

    // One user message carrying every result for this turn. Splitting them
    // across messages is accepted by the API and quietly trains the model out
    // of calling tools in parallel.
    messages.push({ role: "user", content: results });

    if (sawTerminal) {
      return { ...base(), status: "completed", outcome: terminalOutcome };
    }
  }

  return {
    ...base(),
    status: "failed",
    error:
      `agent loop: reached the ${maxIterations}-iteration cap without calling ` +
      `${registry.terminalToolName}`,
  };
}
