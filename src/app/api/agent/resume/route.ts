/**
 * POST /api/agent/resume — carry a paused run past a human decision.
 *
 * This is the piece the hand-rolled loop exists for. Pausing mid-loop and
 * continuing in a *separate* invocation means serializing the message array
 * and reconstructing it later, which the SDK's tool runner cannot do — so the
 * loop is ours, and this route is the other half of that claim.
 *
 * The run keeps its original `agent_runs` row and its original span sequence,
 * so the trace viewer shows one continuous waterfall across both invocations
 * rather than two runs that happen to share a ticket.
 */
import {
  budgetConfigSchema,
  ESTIMATED_RUN_NANOS,
  type BudgetRefusal,
} from "@/agent/budget";
import { cachedSystem } from "@/agent/cache";
import { compileSop } from "@/agent/sop";
import { createOpsData } from "@/db/ops-data";
import { getDb } from "@/db/client";
import { getSopVersion } from "@/db/sops";
import {
  ApprovalNotPendingError,
  decidePendingApproval,
  failRun,
  listApprovals,
  loadPausedRun,
  markRunning,
  nextSpanSeq,
  recordPendingApproval,
  toResumeDecisions,
} from "@/db/approvals";
import {
  runAgentLoop,
  type MessageParam,
  type SpanEvent,
} from "@/agent/loop";
import { buildRegistry } from "@/agent/registry";
import {
  createClient,
  providerFromEnv,
  type LogicalModel,
} from "@/agent/provider";
import { encodeSseEvent, spanToRow } from "@/agent/trace";
import {
  accrueRunCost,
  finishRun,
  releaseReservation,
  reserveResume,
  writeSpan,
} from "@/db/runs";
import { streamingMessageCreator } from "@/agent/streaming";
import { TOOLS } from "@/agent/tools";

export const dynamic = "force-dynamic";

const DEMO_MODEL: LogicalModel = "haiku";

/** Same shape as `/api/agent/run`: 429 for a rate limit, 402 for the rest. */
function refusalResponse(refusal: {
  reason: BudgetRefusal;
  retryAfterSeconds?: number;
}): Response {
  const headers =
    refusal.retryAfterSeconds !== undefined
      ? { "Retry-After": String(refusal.retryAfterSeconds) }
      : undefined;

  return Response.json(
    {
      error: `budget: refused (${refusal.reason})`,
      reason: refusal.reason,
      ...(refusal.retryAfterSeconds !== undefined
        ? { retry_after_seconds: refusal.retryAfterSeconds }
        : {}),
    },
    { status: refusal.reason === "rate_limited" ? 429 : 402, headers },
  );
}

interface ResumeRequest {
  run_id?: string;
  decision?: string;
  reason?: string;
  decided_by?: string;
}

export async function POST(request: Request) {
  let body: ResumeRequest;
  try {
    body = (await request.json()) as ResumeRequest;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const runId = body.run_id;
  if (!runId) {
    return Response.json({ error: "run_id is required" }, { status: 400 });
  }

  if (body.decision !== "approve" && body.decision !== "deny") {
    return Response.json(
      { error: 'decision must be "approve" or "deny"' },
      { status: 400 },
    );
  }
  const approved = body.decision === "approve";

  // A denial the agent cannot read is a dead end: the reason is what it
  // escalates *with*, and "refused, no reason given" makes for a poor customer
  // reply. Required on denial, ignored on approval.
  const reason = body.reason?.trim() ?? "";
  if (!approved && reason.length === 0) {
    return Response.json(
      { error: "reason is required when denying — the agent adapts to it" },
      { status: 400 },
    );
  }

  const db = getDb();

  const run = await loadPausedRun(db, runId);
  if (!run) {
    return Response.json({ error: `no run ${runId}` }, { status: 404 });
  }
  if (run.status !== "paused_for_approval") {
    return Response.json(
      { error: `run ${runId} is ${run.status}, not paused_for_approval` },
      { status: 409 },
    );
  }
  if (!run.serializedMessages) {
    return Response.json(
      { error: `run ${runId} paused without a serialized conversation` },
      { status: 409 },
    );
  }
  if (!run.sopVersionId) {
    return Response.json(
      { error: `run ${runId} has no pinned SOP version` },
      { status: 409 },
    );
  }
  // Nullable in the schema for eval runs, which have no inbox ticket. The
  // tools resolve customer and invoice data through it, so a resume without
  // one would hand every handler an id that is not there.
  const ticketId = run.ticketId;
  if (!ticketId) {
    return Response.json(
      { error: `run ${runId} has no ticket to resume against` },
      { status: 409 },
    );
  }

  let messages: MessageParam[];
  try {
    messages = JSON.parse(run.serializedMessages) as MessageParam[];
  } catch {
    return Response.json(
      { error: `run ${runId} has an unparseable serialized conversation` },
      { status: 500 },
    );
  }

  let budgetConfig;
  let provider;
  let client;
  try {
    budgetConfig = budgetConfigSchema.parse(process.env);
    provider = providerFromEnv(process.env);
    client = createClient(provider, process.env);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  /**
   * The version this run was **pinned to**, never whatever is active now.
   *
   * Re-resolving the active SOP here would let an edit landing between the
   * pause and the decision change the rules mid-run — the model was briefed on
   * one policy and the handler would enforce another. That is the drift bug
   * Day 4 fixed on the prompt side, and this is where it would come back.
   */
  let sop;
  try {
    sop = await getSopVersion(db, run.workspaceId, run.sopVersionId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const now = new Date();
  const rates = provider.rateCard(DEMO_MODEL);

  /**
   * Reserved **before** the approval is decided, deliberately.
   *
   * A resume is a fresh set of model calls against the same shared account, so
   * it is charged exactly like a new run. Asking after the decision would burn
   * the approval on a run that then never starts: the row would read
   * `approved` with the work undone and no way to ask again. Asking first
   * leaves the question pending and the whole request retryable in a minute.
   *
   * The cost is that a reservation is held across the decision, so a decision
   * that fails has to give it back.
   */
  const reservation = await reserveResume(db, {
    runId,
    workspaceId: run.workspaceId,
    now,
    config: budgetConfig,
    estimatedRunNanos: ESTIMATED_RUN_NANOS,
    rateVerified: rates.verifiedOn !== null,
  });

  if (!reservation.ok) return refusalResponse(reservation);

  const { baselineNanos, priorNanos } = reservation;

  // The decision is taken *before* the stream opens, and it is what rejects a
  // double resume: the UPDATE matches only a `pending` row, so of two racing
  // requests exactly one gets a row back and the other lands here.
  try {
    await decidePendingApproval(db, {
      runId,
      approved,
      reason: approved ? (body.reason?.trim() ?? null) : reason,
      decidedBy: body.decided_by?.trim() || "operator",
      now: new Date(),
    });
  } catch (error) {
    // The run is not going to happen, so the headroom goes back. Left in
    // place it would consume $0.02 of the day's cap for every losing racer,
    // and every retry would stack another one on top.
    await releaseReservation(db, runId, priorNanos).catch(() => {});

    if (error instanceof ApprovalNotPendingError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const decisions = toResumeDecisions(await listApprovals(db, runId));
  const startSeq = await nextSpanSeq(db, runId);
  await markRunning(db, runId);

  const registry = buildRegistry(TOOLS);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /** What *this invocation* has spent. The first half is `priorNanos`. */
      let accruedNanos = 0;

      const emit = async (span: SpanEvent) => {
        await writeSpan(
          db,
          spanToRow({ workspaceId: run.workspaceId, runId }, span),
        );

        if (span.type === "llm_call") {
          accruedNanos += span.costNanos;
          await accrueRunCost(db, runId, {
            priorNanos,
            reservationNanos: ESTIMATED_RUN_NANOS,
            accruedNanos,
          });
        }

        try {
          controller.enqueue(
            encoder.encode(encodeSseEvent("span", { ...span, runId })),
          );
        } catch {
          // Reader gone. The spans are already durable.
        }
      };

      try {
        controller.enqueue(
          encoder.encode(
            encodeSseEvent("run", {
              runId,
              ticketId,
              resumed: true,
            }),
          ),
        );

        const result = await runAgentLoop({
          registry,
          createMessage: streamingMessageCreator(client),
          model: provider.modelId(DEMO_MODEL),
          rates: provider.rateCard(DEMO_MODEL),
          system: cachedSystem(
            compileSop({
              bodyMarkdown: sop.bodyMarkdown,
              policyConfig: sop.policyConfig,
            }),
          ),
          messages,
          resumeDecisions: decisions,
          startSeq,
          toolContext: {
            workspaceId: run.workspaceId,
            runId,
            ticketId,
            now,
            data: createOpsData(db, { workspaceId: run.workspaceId, runId }),
            policyConfig: sop.policyConfig,
          },
          budget: { config: budgetConfig, spentTodayNanos: baselineNanos },
          estimatedCallNanos: ESTIMATED_RUN_NANOS,
          clock: () => new Date(),
          emit,
        });

        // `priorNanos` is the first invocation's actual. Without it the row
        // would be overwritten with only this half's cost and the first half
        // would vanish from the run and from the day's spend.
        await finishRun(db, runId, result, new Date(), { priorNanos });

        // A turn can hold more than one confirm-write. Each pause decides one,
        // so a resumed run may stop again on the next — and that question has
        // to reach the queue exactly as the first one did.
        if (result.status === "paused_for_approval" && result.pendingApproval) {
          const pending = result.pendingApproval;
          await recordPendingApproval(db, {
            workspaceId: run.workspaceId,
            runId,
            toolUseId: pending.toolUseId,
            toolName: pending.toolName,
            toolInput: pending.toolInput,
            safetyClass:
              registry.get(pending.toolName)?.safetyClass ?? "confirm_write",
          });
        }

        try {
          controller.enqueue(
            encoder.encode(
              encodeSseEvent("done", {
                runId,
                model: DEMO_MODEL,
                status: result.status,
                outcome: result.outcome,
                iterations: result.iterations,
                usage: result.usage,
                costNanos: result.costNanos,
                estimated: result.estimated,
                budgetReason: result.budgetReason,
                error: result.error,
              }),
            ),
          );
        } catch {
          // Reader gone before the summary. The run is already persisted.
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // The run stays recoverable: `serialized_messages` is left as it was,
        // so a failed resume can be retried rather than stranding the ticket.
        // The unused half of the reservation goes back with it — a retryable
        // run that kept it would consume the day's cap once per attempt.
        await failRun(db, runId, message, {
          costNanos: priorNanos + accruedNanos,
        }).catch(() => {
          // Nothing left to do — the original error is what matters.
        });

        try {
          controller.enqueue(
            encoder.encode(encodeSseEvent("error", { runId, error: message })),
          );
        } catch {
          // Reader gone.
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
