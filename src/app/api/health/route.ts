/**
 * GET /api/health — the one endpoint a monitor is allowed to poll.
 *
 * No auth, on purpose: an uptime check that needs a credential is a second
 * thing that can be misconfigured, and everything below is already public
 * knowledge about a demo. What that buys has to be paid for in discipline —
 * **no environment value ever reaches the body.** Not a connection string, not
 * a region, not a variable name. `pg` errors quote the DSN they failed on and
 * `providerFromEnv` builds its message out of variable names, so failures here
 * are reported as a boolean and a latency, never as the text that came back.
 * The detail goes to the server log, where it already lives.
 *
 * **The two failure axes are deliberately different.** A monitor needs to tell
 * "OpsPilot is down" from "OpsPilot is deliberately paused" — the first is an
 * incident and the second is the spend guard doing its job. So a dead database
 * or a pulled kill switch is 503, while an exhausted budget is 200 with
 * `ok: false` and `budget.state: "exhausted"`. Paging someone at 3am because a
 * demo hit its five-dollar cap would train them to ignore the pager.
 */
import { sql } from "drizzle-orm";

import { budgetConfigSchema } from "@/agent/budget";
import { providerFromEnv } from "@/agent/provider";
import { getDb } from "@/db/client";
import { budgetGauge, type BudgetState } from "@/db/ops";
import { spentTodayNanos } from "@/db/runs";
import { workspaces } from "@/db/schema";

// Health is the definition of a thing that must not be cached.
export const dynamic = "force-dynamic";

const NANOS_PER_USD = 1_000_000_000;

interface DbCheck {
  ok: boolean;
  latencyMs: number;
}

interface ProviderCheck {
  ok: boolean;
  name: string;
}

interface BudgetCheck {
  state: BudgetState | "unknown";
  remainingUsd: number | null;
}

/**
 * `select 1`, timed.
 *
 * Deliberately not a count of anything: this asks whether the pool can reach
 * Postgres and get an answer, and a query over real rows would fold table size
 * and seed state into a number that is supposed to mean "reachable".
 *
 * The workspace id comes back on the same handle so the budget check below
 * does not open a second one, and so a database that answers `select 1` but
 * has no rows is reported honestly rather than as a budget failure.
 */
async function checkDb(): Promise<{
  check: DbCheck;
  workspaceId: string | null;
}> {
  const startedAt = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .limit(1);
    return {
      check: { ok: true, latencyMs: Date.now() - startedAt },
      workspaceId: ws?.id ?? null,
    };
  } catch (error) {
    // Logged, never returned: `pg` puts the connection string in this message.
    console.error("[health] database check failed", error);
    return {
      check: { ok: false, latencyMs: Date.now() - startedAt },
      workspaceId: null,
    };
  }
}

/**
 * Whether a provider is configured, and which one.
 *
 * **Never a model call.** A health endpoint anyone can poll that spends money
 * on every poll is a denial-of-wallet against an account shared with a law
 * firm's live generation — the exact thing `budget.ts` exists to prevent, and
 * it would arrive through the one route with no spend guard on it.
 * `providerFromEnv` is pure and answers the only question worth asking here:
 * is the configuration complete enough to call anything at all.
 *
 * `id` is `"bedrock"` or `"anthropic"`, which names a vendor rather than a
 * secret. On failure the name is `"none"` — the thrown message lists variable
 * names and does not belong in a public body.
 */
function checkProvider(): ProviderCheck {
  try {
    return { ok: true, name: providerFromEnv(process.env).id };
  } catch (error) {
    console.error("[health] provider check failed", error);
    return { ok: false, name: "none" };
  }
}

/**
 * The spend guard's own state.
 *
 * `budgetConfigSchema` fails closed — an absent or unparseable cap throws
 * rather than defaulting to unlimited — which is right for a run and wrong
 * here: a 500 from the endpoint whose job is to report trouble tells a monitor
 * nothing except that the monitor is broken. So a config that will not parse
 * degrades to `state: "unknown"`, which is neither healthy nor a false alarm,
 * and the reason goes to the log.
 */
async function checkBudgetState(
  workspaceId: string | null,
): Promise<BudgetCheck> {
  const parsed = budgetConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[health] budget config is unparseable", parsed.error.issues);
    return { state: "unknown", remainingUsd: null };
  }

  const config = parsed.data;

  // A pulled switch is answered without a round trip, exactly as `reserveRun`
  // does — and it is the answer even when the database is unreachable, since
  // nothing may spend while it is on.
  if (config.killSwitch || workspaceId === null) {
    const gauge = budgetGauge({
      spentNanos: 0,
      capNanos: config.dailyCapNanos,
      killSwitch: config.killSwitch,
    });
    return config.killSwitch
      ? { state: gauge.state, remainingUsd: null }
      : { state: "unknown", remainingUsd: null };
  }

  try {
    const spent = await spentTodayNanos(getDb(), workspaceId, new Date());
    const gauge = budgetGauge({
      spentNanos: spent,
      capNanos: config.dailyCapNanos,
      killSwitch: config.killSwitch,
    });
    return {
      state: gauge.state,
      remainingUsd: gauge.remainingNanos / NANOS_PER_USD,
    };
  } catch (error) {
    console.error("[health] spend read failed", error);
    return { state: "unknown", remainingUsd: null };
  }
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const { check: db, workspaceId } = await checkDb();
  const provider = checkProvider();
  const budget = await checkBudgetState(workspaceId);

  // "Down" and "paused" are different questions, and the status code answers
  // the first while `ok` answers the second.
  const down = !db.ok || budget.state === "killed";
  const ok =
    db.ok &&
    provider.ok &&
    (budget.state === "ok" || budget.state === "warning");

  return Response.json(
    { ok, checkedAt, db, provider, budget },
    { status: down ? 503 : 200 },
  );
}
