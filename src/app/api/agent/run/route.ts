/**
 * POST /api/agent/run — resolve one ticket, streaming the trace as it happens.
 *
 * This is the Day-2 gate: a ticket resolves end to end from `curl`, with spans
 * and costs in the database. Everything interesting has already been unit
 * tested against seams (`MessageCreator`, `OpsData`); this route is the wiring
 * that makes those seams meet a real model and a real Postgres.
 *
 * Written against the Next 16 route-handler streaming pattern in
 * `node_modules/next/dist/docs/01-app/02-guides/streaming.md`, not from memory.
 */
import {
  budgetConfigSchema,
  ESTIMATED_RUN_NANOS,
  type BudgetRefusal,
} from "@/agent/budget";
import { recordPendingApproval } from "@/db/approvals";
import { cachedSystem } from "@/agent/cache";
import { compileSop } from "@/agent/sop";
import { createOpsData } from "@/db/ops-data";
import { getDb } from "@/db/client";
import { loadActiveSop } from "@/db/sops";
import { prepareTicketRun } from "@/agent/guardrails";
import { runAgentLoop, type SpanEvent } from "@/agent/loop";
import { buildRegistry } from "@/agent/registry";
import {
  createClient,
  providerFromEnv,
  type LogicalModel,
} from "@/agent/provider";
import { encodeSseEvent, spanToRow } from "@/agent/trace";
import { accrueRunCost, finishRun, reserveRun, writeSpan } from "@/db/runs";
import { streamingMessageCreator } from "@/agent/streaming";
import { TOOLS } from "@/agent/tools";
import { and, eq } from "drizzle-orm";
import { customers, tickets } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * How a budget refusal is reported.
 *
 * 429 for a rate limit and 402 for the money reasons, because they mean
 * different things to a caller: one says "come back in a minute" and carries
 * `Retry-After`, the others say "not today" and retrying makes things worse.
 * Both are decided *before* the stream opens — once the 200 and the
 * event-stream headers are out there is no status code left to report with,
 * and a refusal delivered as an SSE `error` event is one a `curl` pipeline
 * reads as success.
 */
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

/**
 * The public demo runs Haiku 4.5 — rate-capped and ~pennies per run.
 *
 * Named once because it is read three times below, and because the *logical*
 * name is what the trace needs: the cache floor is per model (4096 on Haiku
 * against 512 on Opus 5), so the console cannot explain a non-cache without
 * knowing which model ran.
 */
const DEMO_MODEL: LogicalModel = "haiku";

/**
 * The Day-2 stand-in is gone: the system prompt is now compiled from the
 * workspace's active `sop_versions` row (see `loadActiveSop` / `compileSop`).
 *
 * The hardcoded constitution said "Refunds are limited to 30 days" in prose
 * while `issue_refund` revalidated against `policy_config`. That was harmless
 * only because nothing could edit the config yet. Day 4 makes it editable, and
 * a literal in the prompt would have become a lie the first time someone
 * narrowed the window.
 */

interface RunRequest {
  ticket_id?: string;
}

export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const ticketId = body.ticket_id;
  if (!ticketId) {
    return Response.json({ error: "ticket_id is required" }, { status: 400 });
  }

  const db = getDb();

  const [ticket] = await db
    .select({
      id: tickets.id,
      workspaceId: tickets.workspaceId,
      customerId: tickets.customerId,
      subject: tickets.subject,
      body: tickets.body,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!ticket) {
    return Response.json({ error: `no ticket ${ticketId}` }, { status: 404 });
  }

  // Configuration failures belong in the response, not in the stream: once the
  // 200 and the event-stream headers are out, there is no status code left to
  // report them with.
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

  const [customer] = ticket.customerId
    ? await db
        .select({ externalId: customers.externalId })
        .from(customers)
        .where(
          and(
            eq(customers.workspaceId, ticket.workspaceId),
            eq(customers.id, ticket.customerId),
          ),
        )
        .limit(1)
    : [];

  // Resolved once, before the run row exists, and pinned to it below. Every
  // later read — prompt assembly here, `issue_refund`'s revalidation inside the
  // loop — must use *this* snapshot, not re-query for whatever is active by
  // then: an edit landing mid-run would otherwise enforce a policy the model
  // was never briefed on.
  let sop;
  try {
    sop = await loadActiveSop(db, ticket.workspaceId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const registry = buildRegistry(TOOLS);
  const now = new Date();
  const rates = provider.rateCard(DEMO_MODEL);

  /**
   * Ask permission *and* open the row in one locked transaction.
   *
   * The run row has to exist before span 0 is emitted — `run_spans.run_id` is
   * notNull with an FK to it — and it now also carries this run's estimate in
   * `cost_usd` from the moment it opens, which is what makes a concurrent
   * `POST` here see it. A refusal writes nothing at all: no row, no Bedrock
   * call, nothing to clean up.
   */
  const reservation = await reserveRun(db, {
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    model: DEMO_MODEL,
    sopVersionId: sop.versionId,
    now,
    config: budgetConfig,
    estimatedRunNanos: ESTIMATED_RUN_NANOS,
    rateVerified: rates.verifiedOn !== null,
  });

  if (!reservation.ok) return refusalResponse(reservation);

  const { runId, baselineNanos, priorNanos } = reservation;

  /**
   * The injection pre-scan, and what it costs the run.
   *
   * Run after the reservation so a flagged ticket that cannot be afforded is
   * refused with a status code rather than a guardrail span nobody reads, and
   * before the stream opens so span 0 has a run row to hang off.
   *
   * When it flags, the loop gets a registry with no confirm-write tool in it.
   * The SOP already tells the model the body is data; this is the half that
   * holds when the model is persuaded otherwise.
   */
  const prepared = prepareTicketRun({
    registry,
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      customer: customer?.externalId ?? null,
      body: ticket.body,
    },
    now,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /** What this run has actually spent, so far, in nano-dollars. */
      let accruedNanos = 0;

      /**
       * Two consumers per span, with deliberately different failure rules.
       *
       * The database write is the gate and is awaited — a span that is not
       * persisted did not happen as far as the trace viewer, the eval scorers
       * and Mission Control are concerned, so it is allowed to fail the run.
       *
       * The SSE enqueue is not. The client may have hung up mid-run, and
       * `controller.enqueue` throws on a closed stream; letting that abort the
       * loop would mean a reader closing their terminal destroys the run and
       * loses the work already paid for. So it is guarded, and the run
       * continues to completion and persistence regardless.
       */
      const emit = async (span: SpanEvent) => {
        await writeSpan(
          db,
          spanToRow(
            { workspaceId: ticket.workspaceId, runId },
            span,
          ),
        );

        // The reservation was an estimate; this is the truth, published as
        // soon as it is known so a run that turns out expensive starts
        // costing concurrent runs their headroom mid-flight rather than at
        // the end. Never *below* the reservation — see `accrueRunCost`.
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
          // Reader gone. Keep working; the spans are already durable.
        }
      };

      try {
        controller.enqueue(
          encoder.encode(encodeSseEvent("run", { runId, ticketId: ticket.id })),
        );

        if (prepared.guardrailSpan) {
          // Persisted and streamed like any other span, through the same
          // `emit`. A guardrail the trace does not show is a control nobody
          // can audit, and demo arc step 4 is precisely the claim that the
          // trace shows it.
          await emit(prepared.guardrailSpan);

          // So a ticket that was injected *after* it was seeded carries the
          // inbox badge too. The predicate is the guard: an already-flagged
          // ticket updates zero rows rather than churning one.
          await db
            .update(tickets)
            .set({ suspectedInjection: true })
            .where(
              and(
                eq(tickets.id, ticket.id),
                eq(tickets.suspectedInjection, false),
              ),
            );
        }

        const result = await runAgentLoop({
          registry: prepared.registry,
          createMessage: streamingMessageCreator(client),
          model: provider.modelId(DEMO_MODEL),
          rates: provider.rateCard(DEMO_MODEL),
          // Marked as a cacheable prefix. Whether it *actually* caches depends
          // on clearing the model's floor — 4096 tokens on Haiku, which demo
          // mode runs — and that is reported from measured usage rather than
          // predicted, so the trace never claims a hit that did not happen.
          system: cachedSystem(
            compileSop({
              bodyMarkdown: sop.bodyMarkdown,
              policyConfig: sop.policyConfig,
            }),
          ),
          messages: prepared.messages,
          // Span 0 belongs to the guardrail when it fired. `run_spans` is
          // unique on (run_id, seq), so a loop numbering from zero anyway
          // would die on its first insert.
          startSeq: prepared.guardrailSpan ? 1 : 0,
          toolContext: {
            workspaceId: ticket.workspaceId,
            runId,
            ticketId: ticket.id,
            now,
            data: createOpsData(db, { workspaceId: ticket.workspaceId, runId }),
            // The version this run was pinned to, so `issue_refund` revalidates
            // against what the model was actually briefed on.
            policyConfig: sop.policyConfig,
          },
          budget: { config: budgetConfig, spentTodayNanos: baselineNanos },
          estimatedCallNanos: ESTIMATED_RUN_NANOS,
          clock: () => new Date(),
          emit,
        });

        await finishRun(db, runId, result, new Date(), { priorNanos });

        // A pause is only half-recorded until the question a human has to
        // answer is durable. `serialized_messages` alone says *where* the run
        // stopped; the approvals row says *what* is being asked, and is what
        // the queue lists and what /api/agent/resume decides against.
        if (result.status === "paused_for_approval" && result.pendingApproval) {
          const pending = result.pendingApproval;
          await recordPendingApproval(db, {
            workspaceId: ticket.workspaceId,
            runId,
            toolUseId: pending.toolUseId,
            toolName: pending.toolName,
            toolInput: pending.toolInput,
            safetyClass:
              prepared.registry.get(pending.toolName)?.safetyClass ??
            "confirm_write",
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
        await finishRun(
          db,
          runId,
          {
            status: "failed",
            outcome: null,
            iterations: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
            // What the run really spent before it broke, not zero: writing
            // zero here would hand the day's cap back money that is gone.
            // The tokens stay zeroed — the spans already carry them.
            costNanos: accruedNanos,
            estimated: false,
            messages: [],
            serializedMessages: null,
            pendingApproval: null,
            refusal: null,
            budgetReason: null,
            error: message,
          },
          new Date(),
          { priorNanos },
        ).catch(() => {
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
      // Nginx and friends buffer by default, which turns a live trace into one
      // block at the end — the opposite of the thing being demonstrated.
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
