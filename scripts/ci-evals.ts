/**
 * The CI eval gate: run the golden suite once, write a scorecard, fail on red.
 *
 * Shaped after `scripts/verify-evals.ts` and wired the way
 * `src/app/api/evals/run/route.ts` wires the streaming endpoint, so there is
 * one way to start a suite and it is visible in both places. The differences
 * from the route are the two that matter in CI: this one calls a real model
 * against a freshly seeded database, and it turns the result into an exit code.
 *
 * **Thin on purpose.** Everything the comment says lives in
 * `formatScorecard`, which is pure and unit-tested. This file runs the suite,
 * writes bytes and sets an exit code, which is exactly the set of things a
 * test cannot check.
 *
 * **It costs money, and the account is shared.** Roughly $0.16 on Haiku for
 * eight cases against covara, which also serves a law firm's live generation.
 * `maxRetries: 8` is not tuning, it is the fix for the burst that killed three
 * cases of the first calibration run with a Bedrock 429. Do not re-run this to
 * chase a green: the results are durable in `eval_runs`, and a case that lost
 * to a 429 says so in its own row.
 *
 * Run: npm run evals:ci
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { budgetConfigSchema } from "../src/agent/budget";
import { createClient, providerFromEnv } from "../src/agent/provider";
import { streamingMessageCreator } from "../src/agent/streaming";
import { closeDb, getDb, type Db } from "../src/db/client";
import { workspaces } from "../src/db/schema";
import { loadActiveSop } from "../src/db/sops";
import { GOLDEN_CASES } from "../src/evals/cases";
import { resolveGitSha } from "../src/evals/pin";
import {
  formatScorecard,
  type ScorecardCase,
  type ScorecardPin,
} from "../src/evals/scorecard";
import { runEvalSuite, type EvalSuiteEvent } from "../src/evals/suite";

/** Haiku, per CLAUDE.md's model strategy: CI eval runs are a Haiku context. */
const MODEL = "haiku" as const;

/**
 * Eight sequential runs is roughly 25 model calls in under a minute, and the
 * SDK's default two retries do not absorb the 429 that produces. The route
 * asks for the same number for the same reason.
 */
const MAX_RETRIES = 8;

const DEFAULT_SCORECARD_PATH = "scorecard.md";

/**
 * What a missing provider looks like to whoever is reading a red CI job.
 *
 * Named rather than left to `providerFromEnv`'s throw, because the first time
 * this fails it will be on a fork PR or a fresh checkout, and the useful
 * sentence is where the secrets come from, not which variable was empty. No
 * value is echoed: this text lands in a public log.
 */
const MISSING_PROVIDER =
  "Evals need AWS_ANTHROPIC_* secrets; see docs/RUNBOOK.md";

/** The demo's single workspace, the same assumption `/api/evals/run` makes. */
async function seededWorkspaceId(db: Db): Promise<string> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (!ws) throw new Error("no workspace — run `npm run db:seed`");
  return ws.id;
}

/** `execFileSync`, not `execSync`: no shell, so no environment is interpreted. */
function gitShaFromShell(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * True when the provider trio is present.
 *
 * Checked here rather than caught from `providerFromEnv` so a fork PR, which
 * GitHub gives no secrets, gets the one sentence that tells its author what
 * happened. A partly configured Bedrock block still falls through to
 * `providerFromEnv`, which names the missing variable better than this can.
 */
function hasProviderEnv(env: NodeJS.ProcessEnv): boolean {
  const bedrock =
    (env.AWS_ANTHROPIC_ACCESS_KEY_ID ?? "").length > 0 ||
    (env.AWS_ANTHROPIC_SECRET_ACCESS_KEY ?? "").length > 0 ||
    (env.AWS_ANTHROPIC_REGION ?? "").length > 0;
  return bedrock || (env.ANTHROPIC_API_KEY ?? "").length > 0;
}

async function main(): Promise<number> {
  if (!hasProviderEnv(process.env)) {
    console.error(MISSING_PROVIDER);
    return 1;
  }

  const db = getDb();
  const workspaceId = await seededWorkspaceId(db);
  const budgetConfig = budgetConfigSchema.parse(process.env);
  const provider = providerFromEnv(process.env);
  const client = createClient(provider, process.env, {
    maxRetries: MAX_RETRIES,
  });

  // Read before the suite, and from the same place `verify-evals.ts` reads it:
  // the refund window is half the SOP label, and the suite's events carry the
  // version number but not the window.
  const sop = await loadActiveSop(db, workspaceId);
  const gitSha = resolveGitSha(process.env, gitShaFromShell);

  const cases: ScorecardCase[] = [];
  let promptVersion = "";
  let suiteError: string | null = null;

  const startedAt = Date.now();
  let summary: Awaited<ReturnType<typeof runEvalSuite>> | null = null;

  try {
    summary = await runEvalSuite({
      db,
      workspaceId,
      // Null runs against whatever `db:seed` made active, which in CI is v1.
      sopVersionId: null,
      model: MODEL,
      cases: GOLDEN_CASES,
      createMessage: streamingMessageCreator(client),
      provider,
      budgetConfig,
      gitSha,
      // One instant for the whole suite, so a refund-window case cannot flip
      // because the job straddled midnight.
      now: new Date(),
      emit: (event: EvalSuiteEvent) => {
        if (event.type === "run") promptVersion = event.promptVersion;
        if (event.type === "case") {
          // Named field by field rather than spread: `agentRunId` is a row id
          // and has no place in a public PR comment, and listing the rest is
          // how a new event field stays out of the scorecard until someone
          // decides it belongs there.
          cases.push({
            slug: event.slug,
            title: event.title,
            passed: event.passed,
            failureReason: event.failureReason,
            assertions: event.assertions,
            costUsd: event.costUsd,
            latencyMs: event.latencyMs,
          });
          console.log(`  ${event.passed ? "PASS" : "FAIL"}  ${event.slug}`);
        }
      },
    });
  } catch (error) {
    // A suite that broke still gets a scorecard. The cases that finished
    // before the throw are real results, and the comment naming the error is
    // more use than a job that ends with a stack trace and no comment.
    suiteError = error instanceof Error ? error.message : String(error);
  }

  const pin: ScorecardPin = {
    sopVersion: sop.version,
    refundWindowDays: sop.policyConfig.refund.windowDays,
    promptVersion: promptVersion || summary?.promptVersion || "unknown",
    gitSha,
    model: MODEL,
    provider: provider.id,
    // Bedrock's rates are unverified, so every cost from them is an estimate
    // and the scorecard says so rather than asserting a figure.
    estimated: provider.rateCard(MODEL).verifiedOn === null,
  };

  const failedCases = cases.filter((c) => !c.passed).length;

  const markdown = formatScorecard(
    {
      passed: summary?.passed ?? cases.length - failedCases,
      failed: summary?.failed ?? failedCases,
      total: summary?.total ?? cases.length,
      costNanos: summary?.costNanos ?? 0,
      wallMs: Date.now() - startedAt,
      cases,
      error: suiteError,
    },
    pin,
  );

  const scorecardPath = process.env.SCORECARD_PATH ?? DEFAULT_SCORECARD_PATH;
  writeFileSync(scorecardPath, markdown, "utf8");

  // The job summary is what a reader sees without leaving the Actions tab.
  // Appended, not written: other steps own the rest of the file.
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, `${markdown}\n`, "utf8");

  console.log(`\n${markdown}`);

  return suiteError !== null || failedCases > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await closeDb();
    // Not `process.exit`: it can cut off a scorecard still draining to stdout,
    // and the scorecard is the point of the job.
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exitCode = 1;
  });
