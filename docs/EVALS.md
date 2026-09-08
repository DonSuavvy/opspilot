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
- the pending row in `approvals` when the run paused.

No LLM judge: that puts a second sampled model between a prompt change and the
verdict on it, so a red case cannot say which of the two moved.

Sampling could not carry determinism anyway — `temperature` is unavailable on
the Sonnet 5 and Opus 5 models. It lives in the scorer and the policy instead —
the policy is pure, `now` injected, so refund-window cases do not drift as real
time passes.

## What the runner does not do

**It never resumes a paused run.** When a case expects `issue_refund` to pause
into the approval queue, the pause *is* the observation: the run's status and
the pending approval row are what the assertion reads.

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

Add an `EvalCase` to `src/evals/cases.ts`: `slug` (stable — the upsert key and
the diff's match key), `title`, `description`, `ticketPayload` (the ticket
to inject plus its fixtures), `expectations`, `tags`, `enabled`.

Expectation keys:

- `status`: terminal run status.
- `action`: the `resolve_ticket` action.
- `refundCents`: cents refunded, `0` for none.
- `pausesFor`: tool the run must pause on.
- `toolsCalled`: tools that must have fired.
- `toolsNever`: tools that must not have fired.
- `guardrailOn`: guardrail span that must exist.
- `replyMentions`: text the reply must contain.
- `maxIterations`: loop cap the run must stay under.

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
