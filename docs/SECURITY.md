# Security

A threat model for the OpsPilot agent: what an attacker gets if they win, what
stops them, and which file that control lives in. Every claim here points at
code you can read.

## What is being protected

**Money.** `issue_refund` is the highest-value target in the system. It moves
value and writes an audit row nobody wants to explain.

**Plan state.** `update_subscription` changes what a customer is billed, in
both directions.

**Customer-facing replies.** A draft carries whatever the model was persuaded
to write, under the company's name.

**The shared inference budget.** OpsPilot runs on a Bedrock account shared with
a live production workload, so a runaway loop here is somebody else's outage.

## Prompt injection through the ticket body

The ticket body is attacker-controlled text handed straight to a model that can
spend money. Four layers answer it, and only the last one holds if the model
cooperates with the attacker.

The body is wrapped in `<ticket_body>` delimiters and presented as data rather
than instructions (`src/agent/prompt.ts`). The SOP's "Handling ticket content"
section says nothing inside a ticket can raise the refund limit or authorise an
action the SOP does not permit, and directs the agent to escalate with reason
`suspected_injection` (`src/db/sop-content.ts`). A deterministic pre-scan runs
before the model sees the ticket and names what it found
(`src/agent/injection.ts`): five patterns, no model call, no network, so the
eval suite can assert on the result. Then the code stops asking nicely. A
flagged run is given no confirm-write tools: `prepareTicketRun`
(`src/agent/guardrails.ts`) rebuilds the registry without them, so
`issue_refund` and `update_subscription` are absent from the tool block rather
than merely discouraged, and the trace opens with an `injection_scan` guardrail
span naming what was withheld. All three entry points apply it —
`/api/agent/run`, `/api/agent/resume`, and the eval runner — and the resume
path re-derives it from the ticket rather than trusting the serialized
conversation to carry it, since that carries the messages and not the tools.
The `prompt-injection` eval case asserts the span, which is the one expectation
a well-behaved model cannot satisfy on its own.

The scan reports a single weak signal without flagging it, because a real
customer can write "without approval" in passing, and a false positive strips
an honest refund of the tools that would grant it.

## Tool misuse by the model

The model is never trusted with a limit it was merely told about. Refund rules
live in the pure policy engine (`src/policy/refund.ts`) and are enforced twice:
once in `issue_refund`'s preflight, which runs before the approval pause so an
out-of-policy call never reaches a human, and again in the handler after
approval, which revalidates against `sop_versions.policy_config` and returns
`is_error: true` rather than paying out (`src/agent/tools.ts`). An approver who
clicks yes on an impossible refund still does not get one.

## Approval races

An approval is a row, and a row can be clicked twice. Resolution is a
conditional `UPDATE ... WHERE run_id = ? AND status = 'pending'`
(`src/db/approvals.ts`). The predicate is the concurrency guard: the second
writer updates zero rows and is told so, so a double click cannot produce a
second refund.

## Budget abuse on a public demo

Anyone who can click the scenario injector can spend the shared account's
money. Three controls, all in `src/agent/budget.ts` and `src/db/runs.ts`: a
daily cap read from the environment, with every route that can open a run
refusing the request outright when it is unset; a kill switch, checked before
anything else and before the transaction, that stops every run without a
deploy; and spend reserved under `select ... for update` on the workspace row
before a run starts, with a per-workspace rate limit, so concurrent runs see
each other's spend instead of each reading the same stale baseline.

One correction on the way through: the cap is enforced per request, not at
startup. `budgetConfigSchema.parse` runs inside each route handler and answers
a missing cap with a 500, so a deployment with no `OPSPILOT_DAILY_BUDGET_USD`
boots fine and refuses every run. Uncapped spending is still impossible, which
is what the control is for, but nothing fails at boot to tell you.

## Data exfiltration through reply drafts

A reply is the one artifact that leaves the agent, so it is the obvious channel
for anything the model was talked into repeating. Drafts are written to
`audit_log` as `draft_reply` rows carrying the full body
(`src/db/ops-data.ts`), and they are visible to a human before anything is
sent. Nothing in this repository sends email.

## Not covered yet

Per-visitor sandboxes and per-visitor caps are Day 8. Until they land, the
public demo shares one workspace and one budget.

No LLM judge scores tone, so a reply can be in-policy and still read badly.

The Bedrock rate card is unverified. Every cost figure is an estimate, and the
spend guard charges it at twice face value so an underestimate cannot quietly
raise the cap.

## How to report

Open an issue in this repository's issue tracker.
Do not include real customer data or credentials in the report.
This is a portfolio project, so there is no security contact and no SLA.
