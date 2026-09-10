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
