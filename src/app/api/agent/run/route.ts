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
import { budgetConfigSchema } from "@/agent/budget";
import { cachedSystem } from "@/agent/cache";
import { compileSop } from "@/agent/sop";
import { createOpsData } from "@/db/ops-data";
import { getDb } from "@/db/client";
import { loadActiveSop } from "@/db/sops";
import { runAgentLoop, type SpanEvent } from "@/agent/loop";
import { buildRegistry } from "@/agent/registry";
import { createClient, providerFromEnv } from "@/agent/provider";
import { encodeSseEvent, spanToRow } from "@/agent/trace";
import { finishRun, spentTodayNanos, startRun, writeSpan } from "@/db/runs";
import { streamingMessageCreator } from "@/agent/streaming";
import { TOOLS } from "@/agent/tools";
import { and, eq } from "drizzle-orm";
import { customers, tickets } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * What one model call is assumed to cost, for the pre-flight only.
 *
 * ~15k input + ~500 output on Haiku's $1/$5 card, rounded up. The guard adds
 * this to the run's accrued spend before *every* call, so an estimate that is
 * too low simply refuses one iteration later than ideal — and on an unverified
 * rate card it is charged at double anyway.
 */
const ESTIMATED_CALL_NANOS = 20_000_000; // $0.02

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
  const baseline = await spentTodayNanos(db, ticket.workspaceId, now);

  // The run row exists before span 0 is emitted: run_spans.run_id is notNull
  // with an FK to it, and the id below is the one Postgres generated.
  const runId = await startRun(db, {
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    model: "haiku",
    sopVersionId: sop.versionId,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
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

        const result = await runAgentLoop({
          registry,
          createMessage: streamingMessageCreator(client),
          model: provider.modelId("haiku"),
          rates: provider.rateCard("haiku"),
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
          messages: [
            {
              role: "user",
              content:
                `Ticket ${ticket.id}\nSubject: ${ticket.subject}\n` +
                (customer ? `Customer: ${customer.externalId}\n` : "") +
                `\n<ticket_body>\n${ticket.body}\n</ticket_body>`,
            },
          ],
          toolContext: {
            workspaceId: ticket.workspaceId,
            runId,
            ticketId: ticket.id,
            now,
            data: createOpsData(db, ticket.workspaceId),
          },
          budget: { config: budgetConfig, spentTodayNanos: baseline },
          estimatedCallNanos: ESTIMATED_CALL_NANOS,
          clock: () => new Date(),
          emit,
        });

        await finishRun(db, runId, result, new Date());

        try {
          controller.enqueue(
            encoder.encode(
              encodeSseEvent("done", {
                runId,
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
            costNanos: 0,
            estimated: false,
            messages: [],
            serializedMessages: null,
            pendingApproval: null,
            refusal: null,
            budgetReason: null,
            error: message,
          },
          new Date(),
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
