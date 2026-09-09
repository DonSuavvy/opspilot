/**
 * Day 7 gate evidence: the spend guard holds under concurrency.
 *
 * CLAUDE.md carried this as an OPEN failure for five days — "the spend guard
 * is per-run, not per-account" — with the honest note that it was *confirmed
 * by inspection, not yet by a concurrent test*. This is that test. It needs
 * Postgres, and `npm test` must never need Postgres, so it lives here.
 *
 * What only a database can prove, and unit tests structurally cannot:
 *
 * 1. **The lock.** Five reservations fired at the same instant against a cap
 *    that fits two. The old code let all five through, because each read a
 *    baseline that none of the others had written to yet. `select ... for
 *    update` on the workspace row is what makes reservation *n* see the
 *    n-1 before it.
 * 2. **The rate limit**, counted from rows rather than from memory — a
 *    serverless deployment has no memory to count in.
 * 3. **The accrual arithmetic**, which is where the design sketch for this
 *    work was wrong. Two accruals past the reservation, then a finish: the
 *    incremental form everyone reaches for first inflates the row on the
 *    second one, and only a sequence of three writes shows it.
 * 4. **The resume round-trip**, where a run's cost is written by two separate
 *    invocations and the first half used to be silently overwritten.
 *
 * Everything runs against a **throwaway workspace**, created here and deleted
 * in a `finally`. The demo workspace's spend today is what Mission Control
 * shows and what the daily cap actually governs; a gate script that moved it
 * would be corrupting the thing it verifies. Rows are cleared between checks
 * too, so each starts from a known baseline of zero.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq } from "drizzle-orm";

import type { BudgetConfig } from "../src/agent/budget";
import { ESTIMATED_RUN_NANOS } from "../src/agent/budget";
import type { AgentLoopResult } from "../src/agent/loop";
import { closeDb, getDb } from "../src/db/client";
import { agentRuns, workspaces } from "../src/db/schema";
import {
  accrueRunCost,
  finishRun,
  reserveResume,
  reserveRun,
  spentTodayNanos,
} from "../src/db/runs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  checks += 1;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${label} (got ${String(actual)}${
      ok ? "" : `, want ${String(expected)}`
    })`,
  );
}

const NANOS_PER_USD = 1_000_000_000;
const usd = (nanos: number) => (nanos / NANOS_PER_USD).toFixed(6);

/**
 * A cap chosen here, never `.env.local`'s. The point is to reach the limit on
 * purpose, and a script that needed the operator's real cap to be small would
 * be untestable on any machine configured for actual use.
 */
function budget(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    dailyCapNanos: 5_000_000_000,
    killSwitch: false,
    runsPerMinute: 1_000,
    ...over,
  };
}

/** The loop result `finishRun` writes. Only the cost matters here. */
function finished(costNanos: number): AgentLoopResult {
  return {
    status: "completed",
    outcome: null,
    iterations: 1,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    costNanos,
    estimated: false,
    messages: [],
    serializedMessages: null,
    pendingApproval: null,
    refusal: null,
    budgetReason: null,
    error: null,
  };
}

async function main() {
  const db = getDb();

  const [ws] = await db
    .insert(workspaces)
    .values({
      slug: `verify-budget-${Date.now()}`,
      label: "verify:budget throwaway",
    })
    .returning({ id: workspaces.id, slug: workspaces.slug });

  const workspaceId = ws!.id;
  const clear = () =>
    db.delete(agentRuns).where(eq(agentRuns.workspaceId, workspaceId));

  const rowCost = async (runId: string) => {
    const [row] = await db
      .select({ costUsd: agentRuns.costUsd })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    return row?.costUsd ?? null;
  };

  console.log(`\n${BOLD}Spend guard — throwaway workspace ${ws!.slug}${RESET}\n`);

  try {
    /* ------------------------------------------------------------------ */
    console.log(
      `${BOLD}1. Five concurrent reservations against a cap that fits two${RESET}`,
    );
    /**
     * The defect, reproduced as a race rather than argued from the code. With
     * `finishRun` as the only writer of `cost_usd`, all five of these read a
     * baseline of zero and all five were cleared for the full cap.
     */
    const now = new Date();
    const fits2 = budget({ dailyCapNanos: 2 * ESTIMATED_RUN_NANOS });

    const raced = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        reserveRun(db, {
          workspaceId,
          ticketId: null,
          model: "haiku",
          now,
          config: fits2,
          estimatedRunNanos: ESTIMATED_RUN_NANOS,
          // Verified, so the safety factor does not double the charge and the
          // cap arithmetic above stays legible.
          rateVerified: true,
        }),
      ),
    );

    const allowed = raced.filter((r) => r.ok);
    const denied = raced.filter((r) => !r.ok);

    check("exactly two got through", allowed.length, 2);
    check("the other three were refused", denied.length, 3);
    check(
      "and refused for money, not for rate",
      denied.every(
        (r) => !r.ok && r.reason !== "rate_limited" && r.reason !== "kill_switch",
      ),
      true,
    );
    check(
      "the cap holds exactly, not approximately",
      await spentTodayNanos(db, workspaceId, now),
      2 * ESTIMATED_RUN_NANOS,
    );
    check(
      "and only two rows exist",
      (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.workspaceId, workspaceId))
      ).length,
      2,
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}2. Three runs a minute, counted from rows${RESET}`,
    );
    const rateNow = new Date();
    const limited = budget({ runsPerMinute: 3 });
    const sequential = [];
    for (let i = 0; i < 5; i += 1) {
      sequential.push(
        await reserveRun(db, {
          workspaceId,
          ticketId: null,
          model: "haiku",
          now: rateNow,
          config: limited,
          estimatedRunNanos: ESTIMATED_RUN_NANOS,
          rateVerified: true,
        }),
      );
    }

    check("three started", sequential.filter((r) => r.ok).length, 3);
    check(
      "two were rate limited",
      sequential.filter((r) => !r.ok && r.reason === "rate_limited").length,
      2,
    );
    check(
      "and told how long to wait",
      sequential.every((r) => r.ok || r.retryAfterSeconds === 60),
      true,
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}3. Accruing past the reservation raises the day's spend${RESET}`,
    );
    const accrueNow = new Date();
    const one = await reserveRun(db, {
      workspaceId,
      ticketId: null,
      model: "haiku",
      now: accrueNow,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!one.ok) throw new Error(`reserve refused: ${one.reason}`);

    check(
      "the reservation is spend the moment it is taken",
      await spentTodayNanos(db, workspaceId, accrueNow),
      ESTIMATED_RUN_NANOS,
    );

    // Under the reservation: the row must not fall, or a run that has spent
    // half its estimate would hand the other half back to concurrent runs
    // while still holding it.
    await accrueRunCost(db, one.runId, {
      priorNanos: 0,
      reservationNanos: ESTIMATED_RUN_NANOS,
      accruedNanos: 5_000_000,
    });
    check(
      "an accrual below it does not release headroom",
      await spentTodayNanos(db, workspaceId, accrueNow),
      ESTIMATED_RUN_NANOS,
    );

    await accrueRunCost(db, one.runId, {
      priorNanos: 0,
      reservationNanos: ESTIMATED_RUN_NANOS,
      accruedNanos: 25_000_000,
    });
    check(
      "an accrual above it charges the excess",
      await spentTodayNanos(db, workspaceId, accrueNow),
      25_000_000,
    );

    /**
     * The check that discriminates between the two possible implementations,
     * and the reason this file exists in the shape it does.
     *
     * The obvious incremental SQL — `cost_usd = cost_usd - reservation +
     * greatest(reservation, accrued)` — is correct exactly once. On the
     * *second* accrual above the reservation it adds the excess to a row that
     * already contains it: $0.025 then $0.030 leaves $0.035, and `finishRun`
     * then subtracts the reservation from the inflated figure and compounds
     * it further. Every other check here passes under both forms. Only a
     * two-accrual sequence tells them apart.
     */
    await accrueRunCost(db, one.runId, {
      priorNanos: 0,
      reservationNanos: ESTIMATED_RUN_NANOS,
      accruedNanos: 30_000_000,
    });
    check(
      "a second accrual is absolute, not compounded",
      await rowCost(one.runId),
      usd(30_000_000),
    );

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}4. Finishing replaces the reservation with the actual${RESET}`,
    );
    await finishRun(db, one.runId, finished(30_000_000), new Date(), {
      priorNanos: 0,
    });
    check("the row reads what it spent", await rowCost(one.runId), usd(30_000_000));

    const cheap = await reserveRun(db, {
      workspaceId,
      ticketId: null,
      model: "haiku",
      now: accrueNow,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!cheap.ok) throw new Error(`reserve refused: ${cheap.reason}`);

    await finishRun(db, cheap.runId, finished(4_000_000), new Date(), {
      priorNanos: 0,
    });
    check(
      "a run cheaper than its estimate gives the difference back",
      await rowCost(cheap.runId),
      usd(4_000_000),
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}5. A resumed run keeps the first half of its cost${RESET}`,
    );
    /**
     * The bug found on the way to closing the concurrency one. `finishRun`
     * wrote `result.costNanos` flat, and on a resumed run that is only the
     * *second* invocation's accrual — so the first half was overwritten and
     * vanished, both from the run and from the day's spend the guard reads.
     */
    const resumeNow = new Date();
    const paused = await reserveRun(db, {
      workspaceId,
      ticketId: null,
      model: "haiku",
      now: resumeNow,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!paused.ok) throw new Error(`reserve refused: ${paused.reason}`);

    await finishRun(db, paused.runId, finished(10_000_000), new Date(), {
      priorNanos: 0,
    });
    check("the first half cost $0.01", await rowCost(paused.runId), usd(10_000_000));

    const second = await reserveResume(db, {
      runId: paused.runId,
      workspaceId,
      now: resumeNow,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!second.ok) throw new Error(`resume refused: ${second.reason}`);

    check(
      "the resume reports what was already spent",
      second.priorNanos,
      10_000_000,
    );
    check(
      "and adds its own reservation on top",
      await rowCost(paused.runId),
      usd(10_000_000 + ESTIMATED_RUN_NANOS),
    );

    await finishRun(db, paused.runId, finished(5_000_000), new Date(), {
      priorNanos: second.priorNanos,
    });
    check(
      "finishing the second half leaves $0.015, not $0.005",
      await rowCost(paused.runId),
      usd(15_000_000),
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}6. The kill switch refuses before the lock is needed${RESET}`,
    );
    const stopped = await reserveRun(db, {
      workspaceId,
      ticketId: null,
      model: "haiku",
      now: new Date(),
      config: budget({ killSwitch: true }),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });

    check("refused", stopped.ok, false);
    check(
      "and named as the operator action it is",
      stopped.ok ? null : stopped.reason,
      "kill_switch",
    );
    check(
      "with no row to show for it",
      (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.workspaceId, workspaceId))
      ).length,
      0,
    );
  } finally {
    // Cascades to agent_runs and run_spans via their FKs. The seeded
    // workspace is never touched: everything above lives in this one.
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }

  console.log(
    failures === 0
      ? `\n${GREEN}${BOLD}PASS${RESET} — ${checks} checks, the spend guard holds under concurrency\n`
      : `\n${RED}${BOLD}FAIL${RESET} — ${failures} of ${checks} check(s) failed\n`,
  );

  await closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
