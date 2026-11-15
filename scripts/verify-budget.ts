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
 *    baseline that none of the others had written to yet.
 *    `pg_advisory_xact_lock` on one fixed key is what makes reservation *n*
 *    see the n-1 before it.
 * 2. **The rate limit**, counted from rows rather than from memory — a
 *    serverless deployment has no memory to count in.
 * 3. **The accrual arithmetic**, which is where the design sketch for this
 *    work was wrong. Two accruals past the reservation, then a finish: the
 *    incremental form everyone reaches for first inflates the row on the
 *    second one, and only a sequence of three writes shows it.
 * 4. **The resume round-trip**, where a run's cost is written by two separate
 *    invocations and the first half used to be silently overwritten.
 * 5. **That the cap is one figure, not one per tenant.** Checks 8 to 10 need
 *    a second workspace, because a per-workspace lock and a per-workspace sum
 *    satisfy checks 1 to 7 perfectly. Per-visitor sandboxes mint a workspace
 *    per browser cookie, so the scoped version handed every stranger a fresh
 *    daily cap. Check 10 is the control: the same race with the workspace row
 *    lock back in place, which over-admits.
 *
 * Everything runs against **two throwaway workspaces**, created here and
 * deleted in a `finally`. The demo workspace's spend today is what Mission
 * Control shows and what the daily cap actually governs; a gate script that
 * moved it would be corrupting the thing it verifies. Rows are cleared
 * between checks too, so each starts from a known baseline of zero — which
 * now matters more, since the sum no longer filters by workspace and a
 * leftover row from check 3 would be spend check 8 could see.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq, gte, inArray, sql } from "drizzle-orm";

import type { BudgetConfig } from "../src/agent/budget";
import { decideReservation, ESTIMATED_RUN_NANOS } from "../src/agent/budget";
import type { AgentLoopResult } from "../src/agent/loop";
import { closeDb, getDb } from "../src/db/client";
import { agentRuns, workspaces } from "../src/db/schema";
import {
  accrueRunCost,
  finishRun,
  reserveResume,
  reserveRun,
  runCostUsd,
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
    // Both ceilings are lifted out of the way by default, so a check that is
    // not about arrival rate cannot be answered by one.
    globalRunsPerMinute: 1_000,
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

  /**
   * Two throwaway workspaces, because one cannot show the defect this file
   * now exists for.
   *
   * A per-workspace lock and a per-workspace sum look perfect from inside a
   * single workspace: every check below numbered 1 to 7 passed against them
   * and none of them could have failed. The cap only comes apart when a
   * second workspace exists, which is precisely what per-visitor sandboxes
   * create, one per cookie, for free, on demand.
   */
  const [wsA, wsB] = await db
    .insert(workspaces)
    .values([
      {
        slug: `verify-budget-a-${Date.now()}`,
        label: "verify:budget throwaway A",
      },
      {
        slug: `verify-budget-b-${Date.now()}`,
        label: "verify:budget throwaway B",
      },
    ])
    .returning({ id: workspaces.id, slug: workspaces.slug });

  const workspaceId = wsA!.id;
  const otherWorkspaceId = wsB!.id;
  const bothWorkspaces = [workspaceId, otherWorkspaceId];

  const clear = () =>
    db
      .delete(agentRuns)
      .where(inArray(agentRuns.workspaceId, bothWorkspaces));

  /** Rows across both workspaces. The global cap is a claim about the pair. */
  const rowsEverywhere = async () =>
    (
      await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(inArray(agentRuns.workspaceId, bothWorkspaces))
    ).length;

  const rowCost = async (runId: string) => {
    const [row] = await db
      .select({ costUsd: agentRuns.costUsd })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    return row?.costUsd ?? null;
  };

  /**
   * The pre-Day-8 reservation, kept alive as a control.
   *
   * Identical to `reserveRun` in every respect that is not the lock: the same
   * global sum of today's spend, the same `decideReservation`, the same
   * insert of the estimate. It takes `select ... for update` on the
   * workspace row instead of the global advisory lock, which is exactly the
   * line this change replaced, so whatever it does differently is that line's
   * doing and nothing else's.
   */
  async function reserveWithoutGlobalLock(
    wsId: string,
    now: Date,
    config: BudgetConfig,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select 1 from workspaces where id = ${wsId} for update`,
      );

      const midnight = new Date(now);
      midnight.setUTCHours(0, 0, 0, 0);
      const [row] = await tx
        .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
        .from(agentRuns)
        .where(gte(agentRuns.chargedAt, midnight));

      const decision = decideReservation({
        spentTodayNanos: Math.round(Number(row?.total ?? 0) * NANOS_PER_USD),
        runsInLastMinute: 0,
        globalRunsInLastMinute: 0,
        estimatedRunNanos: ESTIMATED_RUN_NANOS,
        rateVerified: true,
        config,
      });

      if (!decision.allowed) return false;

      await tx.insert(agentRuns).values({
        workspaceId: wsId,
        ticketId: null,
        model: "haiku",
        status: "running",
        startedAt: now,
        chargedAt: now,
        costUsd: runCostUsd(ESTIMATED_RUN_NANOS, "reservation"),
      });

      return true;
    });
  }

  console.log(
    `\n${BOLD}Spend guard — throwaway workspaces ${wsA!.slug} and ${wsB!.slug}${RESET}\n`,
  );

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
      await spentTodayNanos(db, now),
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
      await spentTodayNanos(db, accrueNow),
      ESTIMATED_RUN_NANOS,
    );

    // Under the reservation: the row must not fall, or a run that has spent
    // half its estimate would hand the other half back to concurrent runs
    // while still holding it.
    await accrueRunCost(db, one.runId, {
      priorNanos: 0,
      reservationNanos: ESTIMATED_RUN_NANOS,
      accruedNanos: 5_000_000,
      now: accrueNow,
    });
    check(
      "an accrual below it does not release headroom",
      await spentTodayNanos(db, accrueNow),
      ESTIMATED_RUN_NANOS,
    );

    await accrueRunCost(db, one.runId, {
      priorNanos: 0,
      reservationNanos: ESTIMATED_RUN_NANOS,
      accruedNanos: 25_000_000,
      now: accrueNow,
    });
    check(
      "an accrual above it charges the excess",
      await spentTodayNanos(db, accrueNow),
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
      now: accrueNow,
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
      `\n${BOLD}6. A resume across midnight is charged to the day it spends on${RESET}`,
    );
    /**
     * The defect this check exists for.
     *
     * `spentTodayNanos` summed on `started_at`, but every writer of `cost_usd`
     * — `reserveResume`, `accrueRunCost`, `finishRun` — writes back into the
     * *original* row. So a run paused at 23:50 and resumed at 00:10 charged
     * its second half to yesterday: money spent today, invisible to today's
     * sum, and the cap it is meant to enforce quietly raised by however much
     * the resume cost. The fix is a second timestamp, `charged_at`, moved
     * every time the cost is.
     *
     * One timestamp per row, so the row moves wholesale: yesterday's half
     * follows the resume onto today rather than being split across two days.
     * That is the conservative direction — today's sum, the one the guard
     * reads, is never short.
     */
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const lastNight = new Date(dayStart.getTime() - 10 * 60_000);
    const afterMidnight = new Date(dayStart.getTime() + 10 * 60_000);

    const overnight = await reserveRun(db, {
      workspaceId,
      ticketId: null,
      model: "haiku",
      now: lastNight,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!overnight.ok) throw new Error(`reserve refused: ${overnight.reason}`);

    await finishRun(db, overnight.runId, finished(10_000_000), lastNight, {
      priorNanos: 0,
    });

    check(
      "yesterday's half is yesterday's spend",
      await spentTodayNanos(db, lastNight),
      10_000_000,
    );
    check(
      "and today's sum, before the resume, does not see it",
      await spentTodayNanos(db, afterMidnight),
      0,
    );

    const overnightResume = await reserveResume(db, {
      runId: overnight.runId,
      workspaceId,
      now: afterMidnight,
      config: budget(),
      estimatedRunNanos: ESTIMATED_RUN_NANOS,
      rateVerified: true,
    });
    if (!overnightResume.ok) {
      throw new Error(`resume refused: ${overnightResume.reason}`);
    }

    check(
      "the reservation the resume takes is today's money",
      await spentTodayNanos(db, afterMidnight),
      10_000_000 + ESTIMATED_RUN_NANOS,
    );

    await finishRun(
      db,
      overnight.runId,
      finished(5_000_000),
      afterMidnight,
      { priorNanos: overnightResume.priorNanos },
    );

    check(
      "and today's sum carries the whole row once it finishes",
      await spentTodayNanos(db, afterMidnight),
      15_000_000,
    );
    /**
     * The two timestamps having parted ways is the whole mechanism, so it is
     * asserted directly rather than inferred.
     *
     * Not asserted: that yesterday's sum has *dropped* to zero.
     * `spentTodayNanos` is a `>= midnight` sum with no upper bound, so asking
     * it about yesterday necessarily includes today as well — a check written
     * that way fails under the fix and under the bug alike, and says nothing
     * about either.
     */
    const timestamps = await db
      .select({
        startedAt: agentRuns.startedAt,
        chargedAt: agentRuns.chargedAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, overnight.runId));

    check(
      "the row still records when it started",
      timestamps[0]?.startedAt.getTime(),
      lastNight.getTime(),
    );
    check(
      "and separately when it was last charged",
      timestamps[0]?.chargedAt.getTime(),
      afterMidnight.getTime(),
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}7. The kill switch refuses before the lock is needed${RESET}`,
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

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}8. Five concurrent reservations across two sandboxes, one cap that fits two${RESET}`,
    );
    /**
     * Check 1 with the workspaces pulled apart, and the only version of it
     * that could ever have failed.
     *
     * Every check above lives in one workspace, so a per-workspace lock and a
     * per-workspace sum satisfied all of them. Per-visitor sandboxes mint a
     * workspace per cookie: ten strangers were ten separate daily caps, and
     * "the daily cap" meant nothing an operator would recognise. Splitting the
     * same five racing reservations across two workspaces is the smallest
     * arrangement that tells a global cap from a per-tenant one.
     */
    const crossNow = new Date();
    const globalFits2: BudgetConfig = budget({
      dailyCapNanos: 2 * ESTIMATED_RUN_NANOS,
    });

    const across = await Promise.all(
      [workspaceId, workspaceId, workspaceId, otherWorkspaceId, otherWorkspaceId].map(
        (id) =>
          reserveRun(db, {
            workspaceId: id,
            ticketId: null,
            model: "haiku",
            now: crossNow,
            config: globalFits2,
            estimatedRunNanos: ESTIMATED_RUN_NANOS,
            rateVerified: true,
          }),
      ),
    );

    check("exactly two got through", across.filter((r) => r.ok).length, 2);
    check(
      "the other three were refused for money, not for rate",
      across
        .filter((r) => !r.ok)
        .every(
          (r) =>
            !r.ok &&
            r.reason !== "rate_limited" &&
            r.reason !== "kill_switch",
        ),
      true,
    );
    check("and two rows exist across both sandboxes", await rowsEverywhere(), 2);
    check(
      "the day's spend is the cap, counted over every workspace",
      await spentTodayNanos(db, crossNow),
      2 * ESTIMATED_RUN_NANOS,
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}9. The demo's per-minute ceiling trips while each sandbox is idle${RESET}`,
    );
    /**
     * The rate limit's version of the same defect.
     *
     * Both workspaces stay well inside `runsPerMinute: 10` here. Nothing in
     * the per-workspace count can explain the refusal, which is the point:
     * only a count taken across every workspace can, and the scope on the
     * refusal says so out loud rather than leaving a reader to infer it.
     */
    const burstNow = new Date();
    const demoLimit = budget({ runsPerMinute: 10, globalRunsPerMinute: 3 });
    const burst = [];
    for (const id of [
      workspaceId,
      otherWorkspaceId,
      workspaceId,
      otherWorkspaceId,
      workspaceId,
    ]) {
      burst.push(
        await reserveRun(db, {
          workspaceId: id,
          ticketId: null,
          model: "haiku",
          now: burstNow,
          config: demoLimit,
          estimatedRunNanos: ESTIMATED_RUN_NANOS,
          rateVerified: true,
        }),
      );
    }

    check("three started", burst.filter((r) => r.ok).length, 3);
    check(
      "two were rate limited",
      burst.filter((r) => !r.ok && r.reason === "rate_limited").length,
      2,
    );
    check(
      "and blamed the demo rather than the sandbox",
      burst
        .filter((r) => !r.ok)
        .every((r) => !r.ok && r.rateLimitScope === "global"),
      true,
    );
    const perWorkspace = await db
      .select({ workspaceId: agentRuns.workspaceId, n: sql<string>`count(*)` })
      .from(agentRuns)
      .where(inArray(agentRuns.workspaceId, bothWorkspaces))
      .groupBy(agentRuns.workspaceId);

    check(
      "while the busiest sandbox started two, nowhere near its own ten",
      Math.max(...perWorkspace.map((r) => Number(r.n))),
      2,
    );

    await clear();

    /* ------------------------------------------------------------------ */
    console.log(
      `\n${BOLD}10. The control: the same race with only a workspace row lock${RESET}`,
    );
    /**
     * Check 8 with one variable changed, so the lock is shown to be
     * load-bearing rather than asserted to be.
     *
     * Everything here is the fixed code's arithmetic: the same global sum of
     * today's spend, the same `decideReservation`, the same insert of the
     * estimate. The only difference is which lock is taken.
     *
     * **The cap fits one, not two, and the reason is worth stating.** A
     * workspace row lock still serialises each workspace's own reservations,
     * so with two workspaces exactly two reservations ever race: the first
     * from each. Two racers cannot over-admit against a cap that fits two, and
     * a control that quietly passed would have proved nothing. A cap of one is
     * the smallest one that can tell the two locks apart here, and the same
     * arithmetic says a deployment with ten sandboxes has ten racers.
     *
     * Both halves run against the same cap so the numbers are comparable.
     */
    const controlNow = new Date();
    const fits1: BudgetConfig = budget({ dailyCapNanos: ESTIMATED_RUN_NANOS });
    const fiveAcross = [
      workspaceId,
      workspaceId,
      workspaceId,
      otherWorkspaceId,
      otherWorkspaceId,
    ];

    const withLock = await Promise.all(
      fiveAcross.map((id) =>
        reserveRun(db, {
          workspaceId: id,
          ticketId: null,
          model: "haiku",
          now: controlNow,
          config: fits1,
          estimatedRunNanos: ESTIMATED_RUN_NANOS,
          rateVerified: true,
        }),
      ),
    );

    check(
      "with the global lock, one got through",
      withLock.filter((r) => r.ok).length,
      1,
    );

    await clear();

    const controlAdmitted = (
      await Promise.all(
        fiveAcross.map((id) =>
          reserveWithoutGlobalLock(id, controlNow, fits1),
        ),
      )
    ).filter(Boolean).length;
    const controlSpend = await spentTodayNanos(db, controlNow);

    console.log(
      `  (the control admitted ${controlAdmitted} and spent ${usd(controlSpend)} against a cap of ${usd(ESTIMATED_RUN_NANOS)})`,
    );
    check("without it, more than one did", controlAdmitted > 1, true);
    check(
      "and the day's spend is over the cap",
      controlSpend > ESTIMATED_RUN_NANOS,
      true,
    );

    await clear();
  } finally {
    // Cascades to agent_runs and run_spans via their FKs. The seeded
    // workspace is never touched: everything above lives in these two.
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, bothWorkspaces));
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
