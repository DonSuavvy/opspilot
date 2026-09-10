# Evals

## The golden suite

Cases live in `src/evals/cases.ts`, beside the prompts they guard. Running a
suite upserts each into `eval_cases` by `slug`, so editing a case updates its
row rather than forking it.

`eval_cases` is the one table with no `workspace_id`, and its slug index is
globally unique. The suite is the developer's regression net, not per-visitor
data; a TTL-cleaned sandbox must never take it along. `eval_runs` and
`eval_results` are the opposite — executions against one workspace's SOP
version, so they cascade with it.

## Why scoring is deterministic

Assertions read structure, never prose. Three sources:

- the forced terminal `resolve_ticket` outcome (`action`,
  `refund_amount_cents`, `reply`, `confidence`),
- the run's tool and guardrail spans in `run_spans`,
- the pause the loop reports when a confirm-write tool stopped the run —
  its tool name and arguments, off the loop's own result.

A suite run therefore leaves paused `agent_runs` rows with no matching row
in `approvals`, by design: the pause is scored from the loop's result, and
the write barrier means nothing an eval case asks for is ever queued for a
human to approve.

No LLM judge: that puts a second sampled model between a prompt change and the
verdict on it, so a red case cannot say which of the two moved.

Sampling could not carry determinism anyway — `temperature` is unavailable on
the Sonnet 5 and Opus 5 models. It lives in the scorer and the policy instead —
the policy is pure, `now` injected, so refund-window cases do not drift as real
time passes.

## What the runner does not do

**It never resumes a paused run.** When a case expects `issue_refund` to pause,
the pause *is* the observation: the run's status and the pause the loop reports
are what the assertion reads.

**It never writes to the workspace.** Writes go through a recording wrapper that
captures what the handler was asked to do and returns what it would have
returned. So a suite runs repeatedly against the same seed: `INV-2002` is
still paid 22 days ago on the twentieth run.

## What a run is pinned to

`eval_runs` records `sop_version_id`, `model` (the logical name — `haiku`,
`sonnet`, `opus`, never a wire id), `git_sha`, and `prompt_version`, a hash of
the compiled system prompt.

Those four make any two runs diffable: a differing result is attributable only
if you know which input changed. Same SHA and hash but a different SOP version
means the SOP did it; a changed hash under an unchanged SOP version means the
compiler or a placeholder moved.

## Adding a case

Add an `EvalCase` to `src/evals/cases.ts`. The shape is `evalCaseSchema` in
`src/evals/case.ts`, and it is closed — an unrecognised key is a parse error,
not a silently dropped one.

- `slug`: kebab-case, and stable. It is the upsert key on `eval_cases` and the
  key the diff matches runs on, so renaming one reads downstream as a case
  removed and another added.
- `title`: what the scorecard and the diff show.
- `description`: why the case exists, and for a disabled one why it is off.
  Defaults to `""`.
- `ticket`: `{ customer, subject, body }` — the ticket to inject. `customer` is
  an external id like `CUS-1001`, or `null` for the unidentifiable-customer
  case. **A case carries no fixtures.** It is a ticket plus expectations and
  deliberately nothing else: `eval_cases` is the one table with no
  `workspace_id`, because the suite is a property of the product rather than of
  a tenant, and the same eight cases must run against the demo workspace, a
  Day 8 sandbox, and whatever CI seeds.
- `expect`: the expectations below.
- `tags`: defaults to `[]`.
- `enabled`: defaults to `true`, so switching a case off is an act rather than
  an omission. A disabled case keeps its row and its history.

`ticket` and `expect` are the *object's* keys. `eval_cases` stores them in
columns named `ticket_payload` and `expectations`; nothing you write in
`cases.ts` uses those names.

Expectation keys, all optional — a case names the ones that matter to it:

- `status`: the loop's terminal status. One of `completed`,
  `paused_for_approval`, `refused`, `failed`, `budget_refused`.
- `action`: `resolve_ticket`'s `action`. Completed runs only.
- `refundCents`: `resolve_ticket`'s `refund_amount_cents`. Either an exact
  integer (`0` for none) or `{ max: n }`, for a case where the amount is a
  judgement call but "not more than this" is policy.
- `pausesFor`: `{ tool, amountCents? }` — the run stopped for human approval on
  this tool.
- `toolsCalled`: each name must appear as a non-error `tool_exec` span.
- `toolsNever`: no name may appear as *any* `tool_exec` span, error or not.
- `guardrailOn`: a `guardrail` span with this name exists. The name is the
  guardrail's, not a tool's — `injection_scan` for the pre-scan that narrows a
  flagged run.
- `replyMentions`: case-insensitive substrings of the outcome's `reply`.
- `maxIterations`: loop iterations used, at most.

**Expectations come from the SOP's rules and a real calibration run, never from
imagination.** Read the SOP version the case runs against, work out what it
mandates, run it once, read the trace. A case written from a guess encodes
the guess: when it goes red you cannot tell whether the agent regressed or the
case was always wrong.

## The CI gate

`.github/workflows/evals.yml` runs the golden suite on a pull request and posts
the scorecard as a comment it edits in place on every push. It is a separate
workflow from `ci.yml` because it calls a real model on an account shared with
a production system, so it must not run on every push.

### What triggers it

Five paths, and nothing else:

- `src/db/sop-content.ts` — the SOP the demo workspace is seeded with
- `src/agent/prompt.ts` — the constitution above the SOP
- `src/agent/sop.ts` — the compiler that turns the two into bytes
- `src/evals/**` — the cases, the scorer, the runner, the suite
- `.github/workflows/evals.yml` — so a change to the gate is gated by itself

Everything on that list moves what the model reads or what a result means.
Nothing off it should change an eval outcome, and if it does, that is a
finding worth a case of its own.

### What fails it

Any failing case, plus a suite that threw. There is no threshold and no
allowance for flakes.

That is the right definition today because `main` is 8/8. With every case green,
a red one is a regression by definition, and the alternative would be to compare
against a stored baseline that does not exist yet: `eval_runs` holds every past
run, but nothing marks which run is the bar. Until something does, "all green"
is the only baseline that cannot drift.

The failure the definition does get wrong is a Bedrock 429. The scorecard says
so in the row — `runEvalSuite` appends the loop's error to the failure reason —
so read the row before assuming the agent moved. Do not re-run the job to chase
a green: it spends the money again, and the row already told you.

### Reading the comment

```
<!-- opspilot-scorecard -->

## Eval scorecard

SOP v1 · 30-day · prompt `0ecf547f0ba1` · model `haiku` on `bedrock` · commit `e7e9675`

**8/8 passed** · $0.078064 (estimated) · 1m 4s wall time

| case | result | failed assertions | cost | latency |
| --- | --- | --- | --- | --- |
| `refund-in-window` | pass | — | $0.007343 | 4.1s |
```

The pin line first: two comments are only comparable if the SOP version, the
refund window, the prompt hash and the commit are all in front of you. A red
case under a changed prompt hash and an unchanged SOP version means the
compiler moved, not the document.

Then the table, in suite order. Rows do not sort by result, so a scorecard
lines up row for row against the one it replaced. A failing row carries every
failed assertion as `name: expected X, got Y`; a case that failed before it was
scored carries its failure reason instead, which is where a 429 shows up.

Cost reads `(estimated)` because Bedrock's rates are unverified. See CLAUDE.md.

### What it costs

$0.078 for eight cases on Haiku, measured 2026-09-10 on the run that gated this
workflow in. Wall time was 1m 4s. Both are estimates against an unverified rate
card and will move with the prompt, so treat the dollar cap in the workflow
(`OPSPILOT_DAILY_BUDGET_USD: "1.00"`, about six suites) as the number that
matters rather than this one.

Locally the same thing is `npm run evals:ci`, against whatever `DATABASE_URL`
points at. It writes `SCORECARD_PATH` (default `scorecard.md`, gitignored),
appends to `$GITHUB_STEP_SUMMARY` when CI sets it, and exits 1 on a red case.

### Where the secrets live

Repository secrets, under the same names the code reads:
`AWS_ANTHROPIC_ACCESS_KEY_ID`, `AWS_ANTHROPIC_SECRET_ACCESS_KEY`,
`AWS_ANTHROPIC_REGION`. `scripts/wizard-deploy.sh` sets them.

A fork PR gets none of them, so the job stops at the env check with
`Evals need AWS_ANTHROPIC_* secrets; see docs/RUNBOOK.md` and no model call.
This repo is solo, so that is a fine place to stop. Handing secrets to a fork
would mean `pull_request_target` and a label gate, which is a different design.

## Reading a diff

`diffEvalRuns` sorts cases into regressed, fixed, unchanged, added and removed.
Read `regressed` first; it is the only bucket that blocks a merge.

Each entry carries `flips` — assertions whose verdict or `actual` moved, shown
as `before` and `after`. `unchanged` has flips too: a refund that slid from 4900
to 2400 but stayed under the policy maximum keeps its verdict.

Three pages render this. `/evals` runs the suite, streaming a case at a time,
and lists every past run with a "diff vs previous" link built from the next
row down. `/evals/<id>` is one run in full: what it was pinned to, then every
assertion it made, failed cases first. `/evals/diff?base=<older>&head=<newer>`
is `diffEvalRuns` itself, five buckets in the order above, with the flips of
each regressed and fixed case as a before/after table.
