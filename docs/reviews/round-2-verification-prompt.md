# Round 2 — independent verification prompt

Used to check Round 2's own work with an agent that did not perform it. Recorded
here because a verification pass whose prompt is unavailable cannot itself be
audited.

Written deliberately as goal + constraints + reasons rather than a numbered
procedure: current models plan better than a hand-written script does, and
prompts carried over from less capable models are usually too prescriptive and
lower output quality. The one thing the agent is told *how* to do is grounding
claims in tool results, because that is the failure mode being guarded against.

**Run against Claude Opus 5, after Claude Fable 5 declined it.** The first
attempt returned `stop_reason: "refusal"` — Fable 5 runs classifiers targeting
most cybersecurity content, and this prompt asks an agent to attack a codebase
whose subject matter is prompt injection and tool-misuse defence. That is a
known false-positive shape for benign security-adjacent work, and cyber-category
refusals name Opus as the recommended fallback, so the retarget is the
documented path rather than a workaround. Worth knowing before Day 7 builds the
adversarial eval case: **the guardrail work in this repo is itself close enough
to the classifier boundary to trip it**, which is a real operational constraint
on how those cases get written and tested, not a curiosity.

Three things in this prompt are tuned to Opus 5 specifically and should survive
edits: sub-agent use is **capped** rather than encouraged (Opus 5 delegates more
readily than its predecessor, and each sub-agent re-establishes context);
verification is kept in the main loop rather than delegated; and the agent is
told to report everything with confidence and severity and rank only at the end,
because Opus 5 follows a "only report what matters" instruction literally and
measured recall drops even as real bug-finding improves.

---

## The prompt

You are reviewing a review. Someone ran a three-agent adversarial pass over this
repository, acted on the findings, and wrote it up. Your job is to find where
that work is still wrong.

**Why this matters, so you can calibrate:** OpsPilot is a portfolio project for
an "AI Prompt Engineer & Agent Builder" application. A security-literate
engineer will read it, and the *credibility of its claims is the product* — the
repo's entire argument is that its author verifies things rather than asserting
them. An overclaim here is not a cosmetic defect; it is the product failing at
the exact thing it exists to demonstrate. That makes a false claim in
`docs/REVIEWS.md` or `docs/FAILURES.md` more damaging than an ordinary bug, and
it is where I most want you looking.

**Start here:** `docs/REVIEWS.md` (Round 2) is the account under test.
`docs/FAILURES.md` entries 9–12 are its defect write-ups. `docs/PLAN.md` is the
authoritative build plan. `CLAUDE.md` holds repo conventions. Round 2 started at
commit `603776e`, so `git diff 603776e` is everything it changed.

**What is intentionally incomplete** — do not report as defects: all nine tool
handlers throw `NotImplementedError` by design (Day 2); there is no agent loop,
no UI beyond the Next.js scaffold, and no deployment. Reporting scaffolding
wastes your budget and mine.

### What I want to know

Three questions, roughly in priority order.

**1. Are the fixes actually complete, or patched where the symptom showed?**
This is the standard the round applied to the code it reviewed, so it is the
standard it should be held to. The critical fix — parsing the policy blob inside
`evaluateRefund` / `evaluateEscalation` rather than at a boundary — is the one I
would attack first. Construct policy blobs and refund inputs it does not
anticipate. The engine now *throws* where it previously returned a decision;
satisfy yourself that every existing caller and gate survives that, and that
throwing is right rather than merely convenient. Look for siblings elsewhere:
other places a TypeScript type stands in for a runtime check, other comparisons
against nullable or tri-state values, other transforms that return something
unusable instead of reporting.

**2. Does `docs/REVIEWS.md` survive execution?** Treat every claim in it as
marketing until you have run something. It asserts specific numbers (131 tests,
70/51/10 by file, 14 mutations attempted and 14 killed), specific gate results,
a clean-clone CI pass, and that a migration was verified without touching the
shared container. Re-derive them. The mutation-testing claim is the one I would
trust least on its face, because it is the claim doing the most work: if the
suite tolerates a reversion the document says it catches, the document's central
evidence is wrong. Its "Not verified" section is a claim too — check that it is
honest and complete, and tell me what it should have listed and didn't.

**3. Will Days 2–10 work on this?** The round rejected a set of forward-looking
schema additions on the argument that the tables have zero rows, so
"un-backfillable if deferred" describes a cost that has not started accruing.
That reasoning is recorded in `docs/REVIEWS.md` as R2-R1, along with the one
exception it made and why. Tell me plainly whether you agree. If it is wrong, it
is wrong in an expensive direction, and I would rather find out now than on
Day 5.

### How to work

Reproduce before reporting; a finding without executed output is a hypothesis
and should say so. Before asserting that something is verified, audit the claim
against a tool result from this session rather than against your expectation of
what the command would print — the round you are checking caught two of its own
mistakes that way, including a test that passed for the wrong reason.

Verify anything about the Anthropic API against current documentation rather
than recall; model IDs, pricing, cache minimums and tool-use rules all changed
during 2025–26, and the repo makes specific claims about all four.

Use sub-agents only for genuinely independent tracks — a wide multi-file sweep,
or the three questions above run in parallel. Keep spawn counts low, and do not
delegate verification: checking your own findings belongs in your main loop.

Report everything you find, including things you are unsure about or judge
minor, each tagged with your confidence and an estimated severity. Do not filter
for importance while you are still looking — deciding what matters is my job,
and a finding I discard costs me a sentence, while one you silently drop costs
me the bug. Rank at the end, do not prune during.

Say explicitly what you examined and found clean. Without that I cannot tell
coverage from silence, which is the single most useful thing this kind of review
produces. If an area is genuinely fine, one line is the right length.

### Boundaries

Do not modify, commit, or push anything in the repository — if you need to
mutate code to prove a point, copy it somewhere else first. A Postgres container
is running on port 5434 and is shared: do not stop it, do not run `npm run
db:down`, and do not write to it. Read-only queries are fine. Note that
migration `0001` is deliberately **not** applied yet, so the live column is
still `jsonb` — that is expected, not a finding. Clean up anything you create.

If you conclude the review's own judgement was wrong somewhere — a finding it
should have rejected, or a rejection it should have acted on — say so directly.
That is more valuable to me than confirmation, and a reviewer that agrees with
everything it is handed is worth nothing. At least one claim in this write-up is
more confident than the evidence behind it strictly supports; I would rather you
found it than took my word that it is minor.

### What "done" looks like

A verdict I can act on: what holds, what does not, and what you could not check.
Order the final list by what would embarrass me most in front of a
security-literate reviewer, with `file:line` and a concrete fix for each — but
order it at the end, from everything you found, rather than deciding partway
through what is worth writing down. If the honest answer is that the work
stands, say that in a paragraph and spend the rest of your effort on question 3,
which is the one still open.
