@AGENTS.md

# OpsPilot

An AI agent that runs a fictional SaaS company's support/billing back office.
The reliability engineering **is** the product: the SOP is a versioned editable
prompt, every run is fully traced, risky actions are gated behind human
approval, and the eval suite runs in CI.

Portfolio project for the Data Skill Source "AI Prompt Engineer & Agent Builder"
application.

## Source of truth

**`docs/PLAN.md` is authoritative** — feature pillars, data model, the 10-day
schedule with per-day gates, model strategy, and the cut order. Read it before
planning any work. When a decision isn't covered there, make the boring choice
and move on.

The 3-minute demo arc in PLAN.md is the north star. Anything that doesn't make
that arc better gets cut first:

1. Inject a ticket → agent resolves it live with a streaming trace.
2. Edit the SOP (refund window 30 → 14) → re-run → the decision changes.
3. Run the eval suite → a case regresses → diff shows why → fix → green.
4. Inject the adversarial ticket → injection flagged, zero tools fired, escalated.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript strict, `src/` layout |
| UI | Tailwind v4 (CSS-first, **no `tailwind.config`**), shadcn/ui on Radix, Lucide, Geist |
| DB | Postgres via Drizzle ORM — local Docker for dev, Neon for deploy |
| Validation | Zod 4 (native `z.toJSONSchema()`) |
| Tests | Vitest, node environment, config in `vitest.config.mts` |
| Agent | Hand-rolled tool loop over a provider adapter (`@anthropic-ai/bedrock-sdk` on covara, `@anthropic-ai/sdk` as fallback) |

**No LangChain or agent frameworks.** This is deliberate and load-bearing for
the interview story: pause/resume across serverless invocations requires
serializing the message array mid-loop and reconstructing it later, which the
SDK tool runner doesn't support.

## Commands

```bash
npm run dev            # Next dev server
npm run typecheck      # tsc --noEmit
npm run test           # vitest run (no DB required — keep it that way)
npm run lint

npm run db:up          # local Postgres on :5434 (5433 is taken by legal-dms)
npm run db:down        # tear down, including the volume
npm run db:generate    # drizzle-kit generate (works offline)
npm run db:migrate
npm run db:seed        # idempotent; deletes the demo workspace and re-seeds
npm run db:studio

npm run verify:boot    # proves boot validation rejects a bad tool definition
npm run verify:seed    # proves the seeded DB supports the demo arc (needs DB)
npm run verify:evals   # proves an eval run is pinned, totalled, and harmless (needs DB)
```

## Conventions

### TDD is not optional

Per the global protocol, these are **test-first, RED → GREEN → REFACTOR**:
the policy engine, tool handlers, eval scorers, the SOP compiler, and cost
accounting. Write the test, run it, *watch it fail*, then implement.

If you wrote code before the test: delete the implementation, write the test,
watch it fail, reimplement.

**Commit the failing test separately from the implementation.** Days 1's commits
landed tests and implementation together, which means the RED step is invisible
in `git log` — an independent audit correctly flagged the TDD claim as
*unverifiable from history*, not false. Two commits (`test: <x> (RED)` then
`feat: <x> (GREEN)`) costs nothing and turns a process claim into evidence
anyone can check. Do this from Day 2 onward.

### Verification before completion

Never claim "done" or "works" without fresh evidence from this session. Run the
command, read the output, quote it. "It passed earlier" is not evidence.

`npm test` must never require a database. DB-dependent checks live in
`scripts/verify-*.ts` and run manually, so CI stays green without Postgres.

### Purity

The policy engine (`src/policy/`) is a pure function of its arguments — no DB,
no I/O, and **`now` is always injected, never `Date.now()`**. Temperature is not
available on Sonnet/Opus 5, so eval determinism lives in the scorers and the
policy rather than in sampling. A wall-clock read would make the refund-window
cases drift and go flaky.

### Never trust the model

Refund limits are enforced twice on purpose: in the SOP so the model knows them,
and in the `issue_refund` handler so the code guarantees them. The handler
revalidates against `sop_versions.policy_config` and rejects out-of-policy calls
with `is_error: true`, which the agent must then handle.

## Gotchas already paid for

Each of these cost real time. Don't rediscover them.

- **Next 16 differs from training data.** The generated `AGENTS.md` says so and
  points at bundled docs in `node_modules/next/dist/docs/`. Read those before
  writing route handlers or SSE streaming. Do not delete `AGENTS.md` — `next dev`
  rewrites it, so removing it just recreates an uncommitted diff.
- **Zod's JSON Schema output is not strict-legal.** `z.number().int().positive()`
  emits `exclusiveMinimum` *and* `maximum`; `.min()/.max()` on strings emits
  `minLength`/`maxLength`. Anthropic's `strict: true` rejects all numerical and
  string constraints. `toStrictJsonSchema()` in `src/agent/registry.ts` strips
  them at every depth. The Zod schema keeps enforcing them at parse time, so
  stripping narrows what the *model* is told, never what the *code* accepts.
- **`strict: true` does not scale to nine tools, and the error blames the wrong
  thing.** Bedrock rejects the full tool block with `400 Compiled grammar size
  (329.9MB) exceeds maximum allowed size (300MB). Simplify your JSON schema` —
  from **3.2KB** of schema whose largest member is 658 bytes. There is nothing
  to simplify: the cost is in the compiled grammar, and it accumulates across
  the set. Measured with `npx tsx scripts/probe-grammar.ts`: every tool alone
  compiles, any eight compile, nine do not, and all nine compile with `strict`
  removed. Dropping a tool works today and breaks at the tenth. So `strict` is
  now the caller's choice — `toAnthropicTools({ strict: false })` — and the
  agent loop defaults it **off**, because the provider this runs on cannot take
  it. Nothing is weakened: the loop parses every call with the tool's own Zod
  schema before the handler, which was always the real guard. Re-test if the
  tool set shrinks or a provider raises the cap. Full write-up: FAILURES 19.
- **`getDb()` is lazy on purpose.** A module-scope pool would make every module
  that transitively imports the schema throw at *import* time when
  `DATABASE_URL` is unset, taking down vitest, tsc and CI for unrelated reasons.
- **`typecheck` runs `next typegen` first, and must keep doing so.** Next 16
  generates the global `LayoutProps`/`PageProps` types into `.next/types`,
  which tsconfig includes but git ignores. Locally they already exist, so
  `tsc --noEmit` passes; on a clean checkout it fails with
  `TS2304: Cannot find name 'LayoutProps'`. Verify CI changes against a real
  clean clone, since a local run cannot surface this:
  ```bash
  rm -rf /tmp/opspilot-ci && git clone -q . /tmp/opspilot-ci && cd /tmp/opspilot-ci \
    && npm ci && npm run typecheck && npm run test && npm run lint
  ```
- **Prompt-cache minimums are model-dependent**: 512 tokens on Opus 5, 1024 on
  Sonnet 5, **4096 on Haiku 4.5**. Demo mode runs Haiku, so a short prefix will
  silently not cache. Either pad the constitution past 4096 or display "below
  cache threshold" honestly — never claim a hit that didn't happen.
- **`stop_reason: "refusal"` must be handled before reading `content`.** Opus 5
  can decline via safety classifiers. `stop_details` is populated *only* on a
  refusal and is null for every other stop reason — but **branch on
  `stop_reason`, never on `stop_details`**: it can be null *on* a refusal too,
  and `explanation` is not guaranteed. `if (stop_details)` is the wrong test and
  will miss refusals.
- **Bedrock is a different client *and* different model ids.** Use
  `AnthropicBedrock`, not `AnthropicBedrockMantle` — Mantle 404s every model on
  the covara account. The two spell the same field differently
  (`awsSecretKey` vs `awsSecretAccessKey`) and mixing them throws "must be
  provided together", which reads like a *missing* variable. Model ids carry
  non-uniform suffixes that cannot be inferred — haiku needs a date **and** a
  version, opus a bare `-v1`, sonnet neither — and all need the `global.`
  prefix, which selects the cross-region inference profile that makes them
  resolve from `ap-southeast-1` at all. Four plausible guesses 400'd before the
  right strings came from reading Causa's working config.
- **Bedrock pricing is unverified and may be ~2x.** AWS prices Claude
  separately; the only figure retrievable showed a retired model at $6/$30
  against the first-party $3/$15. `BEDROCK_RATES` carries `verifiedOn: null`,
  every cost from it is `estimated: true`, and the spend guard charges it at
  `UNVERIFIED_RATE_SAFETY_FACTOR`. Fix by reading covara's line items in Cost
  Explorer, then set real rates *and* a `verifiedOn` date — a test fails if you
  set one without the other.
- **OPEN — the spend guard is per-run, not per-account.** `spentTodayNanos()`
  sums `agent_runs.cost_usd`, and `finishRun` is that column's only writer, so
  a run *in flight* contributes zero to the baseline every other run reads.
  Two concurrent `POST /api/agent/run` calls therefore each see the same
  starting figure and each may spend up to the full daily cap; ten concurrent
  calls, ten times the cap. The in-run accrual added on Day 2 fixes the
  sequential case *inside* one run and does nothing across runs. Confirmed by
  inspection, not yet by a concurrent test. This is exactly the "stranger
  clicking the scenario injector" case `budget.ts` was written for, and it
  becomes reachable on Day 8 when sandboxes go public — fix before then, by
  charging spend as it accrues or taking a row lock, not by patching the read.
- **CLOSED, and the original claim was wrong — constraint stripping stays.**
  This was logged as "stripping is now gratuitous once `strict` is off, and the
  model is told `amount_cents` is a bare `number`". Measuring it before acting
  on it reversed the conclusion, twice over. `type` was never on the strip list,
  so the model *is* told `integer`. And across all nine tools exactly eight
  keywords are stripped, of which **seven are Zod's MAX_SAFE_INTEGER
  boilerplate** (`maximum: 9007199254740991` and its negative twin, emitted for
  every `z.number().int()`). Restoring them would put noise in the cached prefix
  and teach the model nothing. Exactly one strip carried signal — positivity on
  `amount_cents` — and that now lives in the field's `description`, where the
  model actually reads it, pinned by a test. **Lesson: a follow-up written from
  reasoning is a hypothesis; measure before building the mechanism it asks for.**
- **A burst of agent runs trips a Bedrock 429, and the SDK's default two
  retries do not absorb it.** The golden suite is eight runs back to back —
  roughly 25 model calls in under a minute — and the first calibration run lost
  its last three cases to `429 Too many requests, please wait before trying
  again`. covara is shared with Causa's live generation, so that is real
  capacity in use elsewhere rather than a bug to route around: `createClient`
  takes an optional `maxRetries` and `/api/evals/run` asks for 8, while the
  demo's single-ticket path keeps the default because it has no burst. The
  second half of this cost more time than the first: on the scorecard a
  throttled case read `expected status "completed", got "failed"`, exactly like
  a case the agent had botched, with the 429 visible only in
  `agent_runs.error`. `runEvalSuite` now appends the loop's error to the
  failure reason, and the scorer stays pure.
- **An eval expectation written from the SOP is a hypothesis until two runs
  agree.** `refund-out-of-window` asserted `action: "escalated"`, straight from
  the SOP's "escalate when policy denies what the customer asked for". Haiku
  escalated on one run and answered with the denial on the next; both satisfy
  the document, which also tells it to lead with the outcome. The fix was to
  drop the assertion, not to pick a winner — `refundCents: 0` and
  `toolsNever: ["issue_refund"]` are what the case is for and held every time.
  Assert the constraint the policy guarantees, not the route the model happens
  to take to it.
- **The seed's invoice ages are load-bearing.** `INV-2002` is paid 22 days ago
  precisely so it is inside a 30-day window and outside a 14-day one. If that
  stops being true, demo arc step 2 silently demonstrates nothing.
  `npm run verify:seed` asserts it.

## Model strategy

Models are named **logically** (`haiku` / `sonnet` / `opus`) everywhere except
`src/agent/provider.ts`, which maps them to whatever the active provider calls
them. Never write a wire model id anywhere else.

| Context | Logical model | On Bedrock (covara) — what you actually get |
|---|---|---|
| Public demo | `haiku` | Haiku 4.5 ✅ |
| Quality mode / Loom | `sonnet` / `opus` | **4.6, not 5** — see below |
| CI eval runs | `haiku` | Haiku 4.5 ✅ |
| Bake-off | all three | Haiku 4.5 + Sonnet 4.6 + Opus 4.6 |

**The runtime provider is Bedrock, not the first-party API.** OpsPilot runs on
the `covara` account (345485442040) via `AWS_ANTHROPIC_*` in `.env.local`;
`ANTHROPIC_API_KEY` is the fallback path and Bedrock wins if both are set.
That account is **shared with Causa's live Claude generation for a working law
firm**, which is why `src/agent/budget.ts` exists and why it landed on Day 2
rather than Day 7 as PLAN.md scheduled. Do not point the public demo at it
without revisiting that.

**Sonnet 5 and Opus 5 are not available on covara** — both 400 as invalid model
identifiers (verified 2026-08-13). The demo arc is unaffected because it runs
Haiku, but PLAN.md's quality-mode and bake-off entries mean 4.6 on this
account. Pricing is unchanged across that gap, so the rate cards stand.

API notes baked in: no `temperature` on Opus/Sonnet 5; thinking is default-on
for Opus 5 (omit `thinking`, use `output_config.effort: "low"` for agent runs);
Haiku 4.5 has no adaptive thinking and no `effort` — omit both; stream
everything.

**Before writing any Anthropic API code, load the `claude-api` skill.** Model
IDs and API shapes changed in 2025–26; do not code from memory.

## Layout

```
docs/PLAN.md            authoritative build plan
src/policy/             pure policy engine (refund limits, escalation)
src/agent/registry.ts   tool registry: Zod -> strict JSON Schema, boot validation
src/agent/tools.ts      the 9 tools — 8 handlers live; update_subscription is a
                        deliberate stub
src/agent/loop.ts       the hand-rolled tool loop (MessageCreator seam)
src/agent/data.ts       OpsData — the workspace-bound seam handlers run against
src/agent/trace.ts      span -> run_spans row, and SSE framing
src/agent/streaming.ts  the production MessageCreator (stream -> finalMessage)
src/db/schema.ts        Drizzle schema (15 tables)
src/db/client.ts        lazy getDb()
src/db/ops-data.ts      Drizzle OpsData, scoped to one workspace
src/db/runs.ts          run + span persistence, today's spend
src/db/seed.ts          deterministic Beacon Analytics seed
src/db/evals.ts         eval run/result persistence, and the list + detail reads
src/evals/case.ts       the eval case schema — closed, so a typo'd key cannot pass
src/evals/cases.ts      GOLDEN_CASES: the eight, built from the seeded tickets
src/evals/score.ts      the pure scorer — expectations + observation -> assertions
src/evals/recorded-data.ts  reads through, writes recorded: the eval write barrier
src/evals/pin.ts        prompt version and git SHA, so two runs are comparable
src/evals/runner.ts     one case: loop + barrier + scorer
src/evals/suite.ts      the whole suite, sequentially, into one pinned eval_runs row
src/lib/agent-stream.ts   SSE trace reader, shared by both islands that start a run
src/lib/approval-copy.ts  describeApproval — the sentence a reviewer decides on
src/lib/eval-labels.ts    sopLabel, shortSha, compactJson — total over every null
src/components/approval-decision.tsx  approve or deny one paused run, in place
src/components/approval-queue.tsx     the pending rows, each decided on its own
src/components/eval-lab.tsx           the streaming scorecard and the run history
src/app/api/agent/run/  POST a ticket id, stream the trace back as SSE
src/app/api/evals/run/  POST to run the golden suite, streamed as a scorecard
src/app/approvals/      the queue page, server-rendered from listPendingApprovals
src/app/evals/          run the suite, and the history with a diff link per row
src/app/evals/[id]/     one run: the pin, then every assertion it made
src/app/evals/diff/     ?base=&head= — regressed, fixed, added, removed, unchanged
scripts/verify-*.ts     gate evidence that needs a database
scripts/probe-grammar.ts  which tool set blows the strict grammar cap
```

**Two seams carry the whole test strategy.** `MessageCreator` stands in for the
Anthropic client and `OpsData` for the database, so the loop and the handlers
are unit-tested with neither a key nor Postgres — and the things that genuinely
need both get their evidence from `scripts/verify-*.ts` and the day's gate.

## Safety classes

Ported from Cleo's three-class model. Every tool declares one:

- **read** — runs automatically (`get_customer`, `get_subscription`,
  `get_invoices`, `search_kb`)
- **auto-write** — reversible and logged (`draft_reply`, `escalate`,
  `resolve_ticket`)
- **confirm-write** — pauses into the approval queue (`issue_refund`,
  `update_subscription`)

`resolve_ticket` is the forced terminal tool: every run must end with a
structured outcome, because the deterministic eval scorers key off it.
