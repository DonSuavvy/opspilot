# Runbook

Operating OpsPilot once it is live: budgets, the kill switch, what an outage
looks like, sandbox cleanup, seeding, and deploy. Read `docs/SECURITY.md` for
the threat model behind these controls and `docs/PLAN.md` for why they exist
on this schedule.

## Budgets

Three environment variables gate every run. All three are read fresh by each
request; none is cached at boot.

- `OPSPILOT_DAILY_BUDGET_USD`: the daily spend cap, in dollars, shared across
  every sandbox and the durable demo workspace. Required. A missing, empty,
  non-numeric, zero, or negative value makes every route that can start a run
  refuse with a 500, on purpose: an unset cap must not mean unlimited money.
- `OPSPILOT_RUNS_PER_MINUTE`: how many runs one sandbox may start in a rolling
  60-second window. Optional, defaults to 10.
- `OPSPILOT_GLOBAL_RUNS_PER_MINUTE`: the same check across every sandbox
  combined. A burst spread thin across many sandboxes can still trip
  Bedrock's rate limit on the shared covara account, which is what this
  catches and the per-sandbox limit cannot.

The daily cap is enforced under a Postgres advisory lock rather than a lock on
one workspace row, because with sandboxes there is no single row that means
"the whole system's spend today." A run reserves its estimated cost before it
starts, so concurrent runs across different sandboxes see each other's spend
instead of each reading the same stale total.

### Reading /ops

Mission Control lists every workspace with its slug, and for each one: today's
spend against the cap, the rate-limit counters, pending approvals, and recent
eval runs. Costs on Bedrock are estimates charged at a safety multiple, and
the page says so next to the number. Start here when a demo looks slow or a
run refuses unexpectedly.

```bash
open https://<host>/ops
```

### Reading /api/health

The health endpoint answers two different questions with two different
signals. Down and paused are not the same incident.

```bash
curl -s https://<host>/api/health | python3 -m json.tool
```

- `db.ok: false` or `budget.state: "killed"`: the response status is 503.
  Something is actually broken, or the kill switch is on. Page someone.
- `ok: false` with status 200 and `budget.state: "exhausted"`: the daily cap
  is spent. This is the spend guard working, not an incident. Do not page
  anyone for it.
- `budget.state: "unknown"`: the budget config could not be parsed, or the
  database was unreachable when the check ran. Read the server log; the
  reason never reaches the response body on purpose.

No environment value ever appears in the body, by design, so this endpoint is
safe to poll without auth.

## Kill switch

`OPSPILOT_KILL_SWITCH` pauses intake immediately, ahead of every other check
including the daily cap, and with no deploy required.

```bash
vercel env update OPSPILOT_KILL_SWITCH production
```

Type `true` at the prompt, then redeploy or wait for the next request. Set it
back to `false` the same way to resume intake. `/api/health` reports this as
`budget.state: "killed"` and a 503, and `/ops` shows the same state on every
workspace's budget card.

## Model outage

If Bedrock is unreachable or misconfigured, `/api/health`'s `provider.ok` is
`false` and `provider.name` is `"none"`. The overall response stays 200 unless
the database is also down, because a bad provider config is a configuration
problem, not downtime the platform caused.

### What a visitor sees

Starting a run calls `providerFromEnv` and `createClient` before the stream
opens, and a failure there comes back as a plain JSON error with a 500, the
only point in the request where a status code is still available to carry it
(`src/app/api/agent/run/route.ts`). The inbox's run console reads that error
and renders it inline, in a red banner on the ticket panel, verbatim: whatever
the provider adapter's message says (for example, a missing Bedrock
credential, or a SigV4 failure) is what the visitor reads. There is no
pre-recorded trace fallback: if the model is unreachable, the panel shows the
error and nothing else, rather than a scripted trace standing in for a real
run.

What to check first, in order:

```bash
curl -s https://<host>/api/health | python3 -m json.tool
```

```bash
vercel env ls production
```

```bash
vercel logs --environment production --level error --since 30m
```

A 429 from Bedrock during a burst (the eval suite, or several sandboxes
running at once) shows up in `agent_runs.error` on the run itself, not in
`/api/health`, since a single throttled run is not the platform being down.
Mission Control's run list is the place to look for that pattern.

## Sandbox cleanup

Each visitor gets a sandbox: a workspace seeded lazily on first use, cookie
scoped, with a 24-hour TTL on `expires_at`. `GET /api/cron/cleanup` sweeps
expired sandboxes and doubles as the Neon keep-alive ping, since the database
would otherwise idle long enough to cold-start between visits.

### The cron route

`vercel.json` schedules it daily at 03:00 UTC. It requires a bearer token and
returns without touching the database if the token is wrong or missing.

### Manual invocation

Run it by hand after a change to the sweep logic, or if a demo needs a clean
slate right now instead of waiting for the schedule:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/cleanup
```

### TTL arithmetic on Hobby

Vercel's Hobby plan runs a cron once a day, not on an arbitrary schedule. A
sandbox created just after the 03:00 UTC sweep sits for its full 24-hour TTL
and then waits up to another 24 hours for the next sweep to find it. So a
sandbox can live anywhere from 24 to 48 hours in practice, not exactly 24.
This is a Hobby-plan constraint, not a bug in the TTL check itself, and it is
the reason the sweep is safe to also lean on as a keep-alive: it always runs
at least once a day regardless of sandbox traffic.

## Seeding

The durable `demo` tenant is separate from sandboxes. It never expires
(`expires_at` is null), and it is what the wizard-run smoke test and any
guided walkthrough should point at.

```bash
npm run db:seed
```

Sandboxes never need this: `ensureSandbox` in `src/db/sandbox.ts` seeds a new
workspace the first time its cookie is seen, with a real TTL instead of null.

Re-seed the `demo` tenant before any recorded demo or screenshot. The seed's
fixture dates are relative to the moment it runs, not fixed calendar dates,
and one of them is load-bearing: `INV-2002` has to be paid between 14 and 30
days ago for demo arc step 2 (the refund-window edit) to flip anything. The
seed carries its own drift guard for this:

```bash
npm run verify:seed
```

If that fails after time has passed since the last seed, re-seed and run it
again before trusting the demo.

## Deploy

### Why sin1

Neon runs this project's database in `ap-southeast-1`. `vercel.json` pins
`regions: ["sin1"]` (Singapore) so the agent's database round trips stay
local to that region instead of crossing the Pacific on every tool call.

### Environment variables

Everything a production deploy needs, beyond what Vercel sets on its own:

```bash
vercel env ls production
```

Expected: `DATABASE_URL` (the Neon pooled connection string),
`AWS_ANTHROPIC_ACCESS_KEY_ID`, `AWS_ANTHROPIC_SECRET_ACCESS_KEY`,
`AWS_ANTHROPIC_REGION`, `OPSPILOT_DAILY_BUDGET_USD`,
`OPSPILOT_RUNS_PER_MINUTE`, `OPSPILOT_GLOBAL_RUNS_PER_MINUTE`,
`OPSPILOT_KILL_SWITCH`, and `CRON_SECRET`. There is no public-model
environment variable: the public demo's model is the constant `DEMO_MODEL`
in `src/app/api/agent/run/route.ts`, hardcoded to `haiku` rather than read
from the environment.

`scripts/wizard-deploy.sh` walks through setting all of these, plus the
GitHub secrets below, plus linking and deploying the Vercel project.

### Verify gates, in order

Run these against a clean checkout before trusting a deploy. The first three
need no database; the rest need one, so run them after `db:migrate` and
`db:seed`.

```bash
npm run typecheck
```

```bash
npm run test
```

```bash
npm run lint
```

```bash
npm run verify:boot
```

```bash
npm run verify:seed
```

```bash
npm run verify:budget
```

```bash
npm run verify:evals
```

```bash
npm run verify:sandbox
```

`verify:sandbox` proves a fresh sandbox seeds itself on first use, resolves
its own ids, and cannot see another sandbox's data.

## CI secrets for the eval gate

`.github/workflows/evals.yml` (the `Evals` workflow) runs `npm run evals:ci`
(`scripts/ci-evals.ts`) on any pull request touching `src/policy/**`,
`src/agent/**`, `src/db/seed.ts`, `src/db/sop-content.ts`, `src/evals/**`,
`scripts/ci-evals.ts` or the workflow itself. It posts one
upserted scorecard comment per PR and fails the check on any failing case.
This is the CI gate the README's headline claim rests on: prompt changes go
through CI like code.

It needs the same three Bedrock credentials as production, set as repository
secrets rather than environment variables:

```bash
gh secret list
```

Expected: `AWS_ANTHROPIC_ACCESS_KEY_ID`, `AWS_ANTHROPIC_SECRET_ACCESS_KEY`,
`AWS_ANTHROPIC_REGION`. `scripts/wizard-deploy.sh` sets all three by reading
`.env.local`, or set them by hand:

```bash
gh secret set AWS_ANTHROPIC_ACCESS_KEY_ID --body "<value>"
```

Run the suite locally against the same credentials before trusting a CI run
to say something new:

```bash
npm run verify:evals
```
