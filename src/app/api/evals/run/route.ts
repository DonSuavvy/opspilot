/**
 * POST /api/evals/run — run the golden suite, streaming a scorecard as it fills.
 *
 * The Day 6 gate, and demo arc step 3: run the suite, watch a case regress,
 * see why. Streaming rather than a single JSON response because eight cases on
 * Haiku take long enough that a blank screen reads as a hang, and because the
 * point being demonstrated is that each case is a real agent run — which is
 * only legible if they arrive one at a time.
 *
 * Written against the Next 16 route-handler streaming pattern in
 * `node_modules/next/dist/docs/01-app/02-guides/streaming.md`, and shaped after
 * `/api/agent/run` so the two SSE endpoints fail the same way.
 */
import { execFileSync } from "node:child_process";

import { budgetConfigSchema } from "@/agent/budget";
import { createClient, providerFromEnv, type LogicalModel } from "@/agent/provider";
import { streamingMessageCreator } from "@/agent/streaming";
import { encodeSseEvent } from "@/agent/trace";
import { getDb } from "@/db/client";
import { workspaces } from "@/db/schema";
import { GOLDEN_CASES } from "@/evals/cases";
import { resolveGitSha } from "@/evals/pin";
import { runEvalSuite, type EvalSuiteEvent } from "@/evals/suite";

export const dynamic = "force-dynamic";

/**
 * A suite is eight sequential agent runs. Vercel's cap will need addressing
 * before Day 8; locally this is the honest number.
 */
export const maxDuration = 300;

const MODELS: readonly LogicalModel[] = ["haiku", "sonnet", "opus"];

interface RunEvalsRequest {
  sop_version_id?: string;
  model?: string;
}

/**
 * The demo has exactly one workspace, as `/api/sop` also assumes. Day 8
 * replaces this with the visitor's cookie-scoped sandbox.
 */
async function demoWorkspaceId(db: ReturnType<typeof getDb>) {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");
  return ws.id;
}

/**
 * `execFileSync`, not `execSync`: no shell, so nothing in the environment can
 * be interpreted as a command. Nothing here is interpolated today, and this is
 * the spelling that keeps that true if something ever is.
 *
 * `stderr: "ignore"` because outside a git checkout this writes "not a git
 * repository" to the server log on every request, and the caller has already
 * decided that a missing SHA is a null rather than an error.
 */
function gitShaFromShell(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export async function POST(request: Request) {
  let body: RunEvalsRequest;
  try {
    body = (await request.json()) as RunEvalsRequest;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const model = (body.model ?? "haiku") as LogicalModel;
  if (!MODELS.includes(model)) {
    return Response.json(
      { error: `model must be one of ${MODELS.join(", ")}` },
      { status: 400 },
    );
  }

  // Everything that can fail on configuration fails here, while there is still
  // a status code to report it with. Once the event-stream headers are out the
  // only channel left is an `error` event, which a `curl -N` reader sees as a
  // successful request that happens to say nothing useful.
  let db;
  let workspaceId;
  let budgetConfig;
  let provider;
  let client;
  try {
    db = getDb();
    workspaceId = await demoWorkspaceId(db);
    budgetConfig = budgetConfigSchema.parse(process.env);
    provider = providerFromEnv(process.env);
    // A burst, unlike the demo's single-ticket path: eight runs back to back
    // is roughly 25 model calls in under a minute, which exhausted the SDK's
    // default two retries on covara and killed the last three cases of the
    // first calibration run with a Bedrock 429. See `ClientTuning`.
    client = createClient(provider, process.env, { maxRetries: 8 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const gitSha = resolveGitSha(process.env, gitShaFromShell);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Enqueue is guarded and the suite is not. A reader closing their
       * terminal must not destroy a run that is spending real money and
       * writing durable rows — the results are in Postgres either way, and
       * `GET` on the run id can read them back.
       */
      const send = (event: string, payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(encodeSseEvent(event, payload)));
        } catch {
          // Reader gone. The suite continues; the rows are what matter.
        }
      };

      try {
        await runEvalSuite({
          db,
          workspaceId,
          sopVersionId: body.sop_version_id ?? null,
          model,
          cases: GOLDEN_CASES,
          createMessage: streamingMessageCreator(client),
          provider,
          budgetConfig,
          gitSha,
          // One instant for the whole suite: the policy engine measures refund
          // windows from it, and a case must not flip because the suite
          // happened to straddle midnight.
          now: new Date(),
          emit: (event: EvalSuiteEvent) => {
            const { type, ...payload } = event;
            send(type, payload);
          },
        });
      } catch (error) {
        send("error", {
          error: error instanceof Error ? error.message : String(error),
        });
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
      // Nginx and friends buffer by default, which delivers the whole
      // scorecard at the end — the opposite of what this endpoint is for.
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
