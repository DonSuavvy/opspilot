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
| Agent | Raw `@anthropic-ai/sdk` with a hand-rolled tool loop |

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
  can decline via safety classifiers; `stop_details` is populated *only* on a
  refusal and is null otherwise.
- **The seed's invoice ages are load-bearing.** `INV-2002` is paid 22 days ago
  precisely so it is inside a 30-day window and outside a 14-day one. If that
  stops being true, demo arc step 2 silently demonstrates nothing.
  `npm run verify:seed` asserts it.

## Model strategy

| Context | Model |
|---|---|
| Public demo | `claude-haiku-4-5` (rate-capped, ~pennies) |
| Quality mode / Loom | `claude-sonnet-5` or `claude-opus-5` |
| CI eval runs | `claude-haiku-4-5` |
| Bake-off | all three |

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
src/agent/tools.ts      the 9 tools — schemas live, handlers land Day 2
src/db/schema.ts        Drizzle schema (15 tables)
src/db/client.ts        lazy getDb()
src/db/seed.ts          deterministic Beacon Analytics seed
scripts/verify-*.ts     gate evidence that needs a database
```

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
