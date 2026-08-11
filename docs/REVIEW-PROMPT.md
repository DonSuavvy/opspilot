# REVIEW-PROMPT.md

The independent-review prompt used on this project, kept in the repo so the
practice is reproducible rather than a story about something that happened once.

[`FAILURES.md`](FAILURES.md) records what these reviews **found**. This file is
what **finds** it.

## How to run it

Paste the block below into a **fresh** session in the repo root.

Fresh is the whole point. A session that just wrote the code carries every
assumption that produced it, so its "independent" review inherits the same blind
spots. Cold context is what makes the review adversarial rather than a
self-check wearing a costume.

Run it after any phase whose output you're about to build on — not after every
commit.

---

````
Launch three independent review agents in parallel to verify this project's
foundation before I build the next phase on it. Run them in the background and
relay a consolidated result.

PROJECT CONTEXT (give this to every agent):
- Repo: the current working directory. Public at github.com/DonSuavvy/opspilot
- "OpsPilot" — an AI agent running a fictional SaaS support/billing back office.
  Portfolio piece for an "AI Prompt Engineer & Agent Builder" application, so it
  will be read by a security-literate engineer.
- docs/PLAN.md is the authoritative build plan (10 days, per-day gates).
  CLAUDE.md holds repo conventions. docs/FAILURES.md logs defects already found
  and fixed — agents should NOT re-report anything already fixed there, but
  SHOULD check whether each fix actually holds.
- Tell each agent explicitly what is intentionally incomplete, so they don't
  burn effort reporting scaffolding as bugs. Currently: tool handlers throw
  NotImplementedError by design (Day 2), there is no agent loop, no UI beyond
  the scaffold page, and no deployment.

AGENT 1 — FOUNDATION FITNESS (the most important one)
Question: will the next phases actually work on top of this, or will something
need retrofitting?
Read docs/PLAN.md Days 2-10, then assess whether the current schema, tool
registry, and policy engine can carry them WITHOUT redesign. Specifically:
- Pause/resume across serverless invocations: is everything needed to
  reconstruct a paused run actually persisted, with the right types?
- Trace/span model: can it represent streaming spans, token/cost/latency
  accounting, and cache hit/miss, or are columns missing?
- SOP versioning: can prompt assembly and a version-diff view be built on it?
- Eval pinning: can any two eval runs be compared reproducibly?
- Anything that will be expensive to change once real data exists.
Report: what's ready, what's missing, and what would be painful to retrofit —
ranked by how costly the retrofit gets if deferred.

AGENT 2 — ADVERSARIAL CORRECTNESS
Hunt for defects in src/policy/, src/agent/, src/db/, scripts/.
A position-blind JSON Schema sanitizer bug and a nullable-enum comparison bug
were already found here (see docs/FAILURES.md) — look for SIBLINGS of those
classes, and verify those two fixes are actually complete rather than patched
at the reported symptom.
Pay attention to: boundary conditions, nullable/optional comparisons, recursion
that assumes shape, anything that fails silently instead of throwing, and any
place a guarantee is claimed but not enforced in code.
Verify Anthropic API specifics against current docs rather than memory — model
IDs and tool-use rules changed in 2025-26.

AGENT 3 — CLAIMS AUDIT
Assume every claim is marketing until proven. Verify README.md, CLAUDE.md,
docs/FAILURES.md and the commit messages against reality by RUNNING things, not
reading them. Clone to a temp dir and execute the README's quickstart verbatim.
Confirm test counts, the "no test requires a database" claim (unset
DATABASE_URL entirely), and each gate claim. Flag any present-tense description
of code that doesn't exist, and any doc that contradicts the code.

RULES FOR ALL THREE:
- Be genuinely critical. Do not reassure me. If an area is clean, say so in one
  line and move on — don't pad the list.
- REPRODUCE before reporting. A finding without evidence is a hypothesis.
  Include the command output that demonstrates it.
- Apply confidence filtering: report only what you'd actually raise in review,
  ranked most severe first, with file:line and a concrete suggested fix.
- Say explicitly what you checked and found CLEAN, so I can tell coverage from
  silence.
- Do NOT modify files, do NOT commit, do NOT push. Clean up temp dirs.
- Docker note: a Postgres container may be running on port 5434. Do not stop it
  and do not run `npm run db:down` in the main repo.

Then: reproduce every finding yourself before acting on any of it, fix what's
real, and tell me what you rejected and why.
````

---

## Why it's shaped this way

Each of these earned its place by catching something the previous shape missed.

**Three agents, three different questions.** "Is this correct?" and "is this the
right foundation?" find different problems. A schema can be flawless and still
be missing the column Day 5 needs — and that's the expensive miss, because it
surfaces after there's data in the table. Agent 1 exists because correctness
review alone never asks that question.

**"Say what you found CLEAN."** Without it there's no way to distinguish
*checked and fine* from *never looked at*. In the first round this is what
established that the `$defs`/`anyOf` recursion was already sound, which kept a
fix narrow instead of turning it into a rewrite. Silence is not coverage.

**"Reproduce before reporting."** A reviewer's claim is a hypothesis. Every
finding acted on in FAILURES.md was reproduced first — and the sanitizer bug
was confirmed with a standalone probe before a line of the fix was written.

**"Don't re-report what's already fixed, but check the fixes hold."** Stops
paying twice for the same findings, while still catching a fix that only patched
the reported symptom. Real risk: the sanitizer fix addressed three
manifestations of one root cause, and patching the three without the cause would
have looked identical from the outside.

**Naming what's intentionally incomplete.** Without it, agents spend their
budget reporting `NotImplementedError` handlers and a scaffold homepage as
defects. Costs one sentence, saves most of a review.

**"Do not reassure me."** Review agents drift toward agreeable summaries.
Saying so plainly, and pairing it with confidence filtering, is what produces a
short list of real findings instead of a long list of hedged ones.

## The rule that matters most

The closing line — *reproduce every finding yourself before acting on it* —
is not politeness toward the reviewers. It's necessary.

In the first round one of my own verification probes came back clean because it
tested the wrong object. A false negative that would have "confirmed" no bug
existed. Agents are wrong in both directions: they miss real defects and they
report imaginary ones. The prompt is only half the practice; verifying its
output is the other half.

This is the same principle the product is built on. The refund limit is enforced
in the SOP **and** revalidated in code, because a model's proposal is an input,
not a decision. A review agent's finding is also an input, not a decision.

## Adapting it

| When | Change |
|---|---|
| Day-to-day, after a code change | Drop Agent 3. The claims audit is worth running before sharing the repo or after a docs pass, not after every commit. |
| Day 6 onward (Eval Lab) | Add a fourth agent reviewing whether eval cases actually **discriminate** — a suite where every case passes regardless of the SOP is worse than no suite, because it manufactures confidence. |
| Day 7 onward (guardrails) | Point Agent 2 at the injection defenses specifically, and have it assert against the audit log that zero side-effect tools fired — not against the reply text, which is the easy thing to fake. |
| Before sending the application | Run all three, plus have Agent 3 read the README as a hiring reviewer would and flag anything that reads as overclaiming. |
