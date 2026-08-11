# REVIEWS.md

A record of every review pass run against this repository: how it was run, what
it covered, what it found, **what it rejected**, and what it could not verify.

`docs/FAILURES.md` answers *what broke*. This file answers *how do you know you
looked* — and it exists because those are different claims. A defect log with no
method behind it is a list of things that happened to be noticed. A method with
no defects found is unfalsifiable. Both together are auditable: a reader can
check the coverage claims against the commands, and the rejections against the
evidence.

The rejections are the part worth reading. Anyone can act on every finding a
reviewer produces; that is not review, it is dictation. The judgement is in
which findings survive contact with the actual code and the actual schedule.

---

## Round 2 — 2026-08-11 — Foundation fitness

**Question asked:** will Days 2–10 of `docs/PLAN.md` build on this foundation,
or will something need retrofitting?

**Headline:** one critical defect (the policy engine failed open on a malformed
policy — a $99,999.99 refund approved against a $500 ceiling with zero
violations), 20 further findings fixed, 5 findings rejected or deferred with
reasons recorded below. Suite went 79 → 131 tests. Every fix is pinned by a
mutation test.

### Why this round happened

Round 1 (`FAILURES.md` entries 1–8) had already found a critical latent bug and
a broken quickstart. The obvious failure mode after a successful review is to
treat the code as *now reviewed*. Round 2 exists to test that assumption before
Day 2 puts an agent loop, tool handlers, and real data on top of it — the point
at which schema mistakes stop being free.

### Method

Three independent agents, launched in parallel, each with a brief written to
resist the failure mode of the previous round. None could see the others' work.

| | Agent 1 | Agent 2 | Agent 3 |
|---|---|---|---|
| **Role** | Foundation fitness | Adversarial correctness | Claims audit |
| **Question** | Can Days 2–10 be built on this without redesign? | Where are the defects? | Does the documentation survive execution? |
| **Method required** | Read PLAN Days 2–10, trace each feature to the schema | Hunt siblings of two known defect classes; mutation-test | Run things, don't read them; clone and execute the README verbatim |
| **Output demanded** | Ranked by *retrofit cost if deferred*, not severity | Reproduction command + verbatim output per finding | `claimed vs actual` for every countable claim |
| **Cost** | 391k tokens, 43 tool calls, 15m50s | 423k tokens, 47 tool calls, 17m32s | 388k tokens, 41 tool calls, 12m20s |

Total ≈ **1.2M tokens across ~46 minutes wall-clock** (parallel, so ~17m
elapsed). Recorded because multi-agent review has a real cost and pretending
otherwise is the kind of claim this file exists to prevent.

**Constraints given to every agent**, and why each one mattered:

- **Read-only on the repo; no commits, no pushes.** A reviewer that edits is no
  longer an independent reviewer of what it edited.
- **Reproduce before reporting; a finding without executed evidence is labelled
  `HYPOTHESIS`.** Round 1 produced a probe that passed for the wrong reason, so
  the bar is executed output, not confident prose.
- **Say explicitly what you checked and found clean.** Without this, silence and
  coverage are indistinguishable, and a short findings list reads as a clean
  bill of health when it may mean the area was never opened.
- **Do not stop the Postgres container on :5434, do not run `db:down`, do not
  write to the database.** A shared dev container; a reviewer that drops a
  volume has destroyed the evidence.
- **Told explicitly what is intentionally incomplete** — handlers throw
  `NotImplementedError`, no agent loop, no UI, no deployment. Without this,
  reviewers spend their budget reporting scaffolding as bugs.
- **Confidence filter: if an area is clean, say so in one line and move on.**
  Padding a findings list is how a review becomes noise.

**Two briefs contained a deliberate trap.** Agent 2 was handed a specific
hypothesis — that `assertConsistent` mishandles `SCHEMA_MAP_KEYS` and would
false-positive on a field named `type` — stated confidently and asked to verify
empirically. It is **wrong**. A reviewer that confirms whatever it is handed is
worse than no reviewer, because it launders the asker's assumptions as findings.

### Verification protocol applied to the findings

Every finding was reproduced independently before any file was touched. The
reproductions are recorded per finding below. Three checks were applied on top:

1. **Fix completeness, not symptom removal.** After each fix, the *original*
   probe was re-run. This caught the first attempt at the critical finding: a
   boundary validator that left the engine still approving $99,999.99.
2. **Mutation testing.** Fourteen deliberate reversions of the fixed code, run
   against the suite on a scratch copy. All fourteen were caught. A fix whose
   reversion the suite tolerates is not covered, only accompanied.
3. **Independent verification of API claims.** No documentation claim about the
   Anthropic API was edited on a subagent's assertion — each was checked against
   current reference material first. Writing a subagent's stale recollection
   into the repo would convert an accurate doc into an inaccurate one, in the
   exact file a security-literate reader checks.

---

### Findings ledger

Severity is impact **if it reached production**, not how hard it was to find.

| ID | Severity | Finding | Location | Status |
|---|---|---|---|---|
| R2-01 | **Critical** | Policy engine fails open on malformed `policy_config` | `src/policy/refund.ts` | Fixed |
| R2-02 | High | `serialized_messages` is `jsonb`; cannot hold the payload | `src/db/schema.ts` | Fixed |
| R2-03 | High | `assertConsistent()` had no test that could fail | `src/agent/registry.ts` | Fixed |
| R2-04 | High | README claimed all round-1 fixes were test-first — false for 4 of 5 | `README.md` | Fixed |
| R2-05 | Medium | Regression net walked schema position-blind; contradicted `registry.test.ts` | `src/agent/tools.test.ts` | Fixed |
| R2-06 | Medium | TLS selected by substring over whole connection string (fails open) | `src/db/client.ts` | Fixed |
| R2-07 | Medium | Future-dated `paidAt` bypasses the refund window | `src/policy/refund.ts` | Fixed |
| R2-08 | Medium | `settled` and `ageDays` applied different null tests to one field | `src/policy/refund.ts` | Fixed |
| R2-09 | Medium (latent) | `format` reached the wire with no allowlist; `contentEncoding` too | `src/agent/registry.ts` | Fixed |
| R2-10 | Medium | Comment confidently wrong about Postgres FK capability | `src/db/schema.ts` | Fixed |
| R2-11 | Medium | Test counts stale; table did not sum to its own stated total | `README.md` | Fixed |
| R2-12 | Medium | Present-tense prose for the resume round trip, unscoped | `README.md` | Fixed |
| R2-13 | Medium | "Eight entries, every one a real defect" — two are not defects | `docs/FAILURES.md` | Fixed |
| R2-14 | Medium | Money thresholds and `approvedCents`-on-denial unpinned by tests | `src/policy/refund.test.ts` | Fixed |
| R2-15 | Low | Three escalation toggles never exercised — dead configuration | `src/policy/refund.test.ts` | Fixed |
| R2-16 | Low | `Number.isInteger` admits values past 2^53 as "integer cents" | `src/policy/refund.ts` | Fixed |
| R2-17 | Low | `verify:boot` never exercised the sanitizer failure path | `scripts/verify-boot.ts` | Fixed |
| R2-18 | Low | `stop_details` guidance invited the wrong refusal test | `CLAUDE.md` | Fixed |
| R2-19 | Low | Sonnet 5 intro pricing not reflected in the cost table | `docs/PLAN.md` | Noted |
| R2-20 | Low | No `engines` field; Node version unstated anywhere | `package.json` | Fixed |
| R2-21 | Low | "15-table" prose enumerated 14 (omitted `sops`) | `README.md` | Fixed |
| R2-R1 | — | Forward-looking schema columns for Days 3–8 | `src/db/schema.ts` | **Rejected** |
| R2-R2 | — | Re-seed orphans eval-run provenance | `src/db/seed.ts` | **Deferred to Day 6** |
| R2-R3 | — | Recursive schemas / `prefixItems` pass boot validation | `src/agent/registry.ts` | **Deferred** |
| R2-R4 | — | Validate policy at the boundary only | — | **Rejected, superseded** |
| R2-R5 | — | `assertConsistent` position-blindness | — | **Disproved** |

---

### R2-01 — The policy engine failed open · **Critical**

`evaluateRefund` accepted `policy: PolicyConfig`. That type is erased at build
time; the value arrives at runtime from `sop_versions.policy_config`, a `jsonb`
blob written by the SOP editor — the product's headline feature. Nothing parsed
it. Every rule is a `>` comparison, and **`x > undefined` is `false`**, so an
absent key did not error. It removed the limit.

```
invoice: 400 days old, requesting $99999.99 | hard cap in DEFAULT_POLICY: $500.00
A. well-formed DEFAULT_POLICY     outcome=deny      approved=$0.00       violations=[outside_refund_window,exceeds_max_refund]
B. refund:{} (all keys missing)   outcome=approve   approved=$99999.99   violations=[]
C. refund key absent entirely     outcome=approve   approved=$99999.99   violations=[]
F. windowDays missing only        outcome=deny      approved=$0.00       violations=[exceeds_max_refund]
```

Case F establishes the deletion is per-key, so a single typo is sufficient — and
a typo'd ceiling was worse than useless: it did not deny, it routed $99,999.99
into the approval queue as a *legitimate* pending request, where a human sees a
correctly-formatted approval task with no indication anything is wrong.

**Why this one outranks everything else found:** this module is the code half of
*never trust the model*. It exists so a model's proposal is revalidated by
something that cannot be argued with. It was revalidating against a blob it
trusted completely. The guarantee the project is built to demonstrate was, at
this layer, decorative.

**Fix — and the wrong first attempt.** The first fix added `parsePolicyConfig`
at the boundary, for callers to invoke. Re-running the original probe showed
`evaluateRefund` **still approving $99,999.99**, because a guarantee nothing is
obliged to call is documentation. The parse moved inside both `evaluateRefund`
and `evaluateEscalation`. `.strict()` is load-bearing: without it a misspelled
key is discarded as unknown and the real key reads as absent — the identical
silent failure wearing a different hat.

Verified after fixing, against the blob the seed actually writes:

```
ACCEPTED — the shipped policy round-trips through the validator
  windowDays: 30 | maxAutoApprove: 10000 | maxRefund: 50000
```

### R2-02 — `serialized_messages` could not hold what it is for · High

`jsonb` rejects the NUL escape that `JSON.stringify` emits:

```
JSON.stringify emitted : [{"role":"user","content":"invoice\u0000INV-2002"}]
ERROR:  unsupported Unicode escape sequence
DETAIL:  \u0000 cannot be converted to text.
```

The same value as `text` stores fine. The usual remedy — sanitise before
writing — is **unavailable for this column specifically**: replaying a paused
turn requires passing thinking blocks back byte-identical, so editing the
payload is precisely what the resume contract forbids. This column is a replay
buffer, never queried by content.

The failure would land on the *pause* write — the one that ends the invocation —
so a run would be lost mid-flight with no resume path, on Day 5, in the feature
the whole hand-rolled-loop argument exists to support.

Fixed to `text`. Migration `0001` verified in a rolled-back transaction: table
empty (0 rows), converts cleanly, container left untouched.

### R2-03 — The safety net had no test that could fail · High (test integrity)

`FAILURES.md` entry 1 claims `assertConsistent()` means "one assertion catches
this whole bug class." Mutation testing, baseline 79 passing:

```
  SURVIVED  remove assertConsistent() call entirely   <-- TEST HOLE
  SURVIVED  assertConsistent: never report orphans    <-- TEST HOLE
```

The test that *looked* like coverage asserted a property the fixed sanitizer
already guarantees unaided, so it passed with or without the check — the same
"asserting on the wrong cell" pattern as `FAILURES.md` entry 5, recurring inside
the fix for entry 1. Fixed with tests that inject an inconsistency the sanitizer
cannot produce, via Zod `.meta()`.

### R2-04 — A false process claim, in the section arguing for process honesty · High

`README.md` stated: *"Every one is fixed, test-first, with the failing test
committed first."* `git log --stat` shows only the sanitizer had a RED commit
(`21aa814`, test-only, 80 lines, one file). The other four landed inside
`9771b3f` with no preceding test — and one of them (`verify-seed.ts`) is not a
vitest test, so it could not have had one.

The location is what makes this High rather than Medium: it sits in the section
whose argument is that this project is scrupulous about process evidence. An
accurate table earns trust that inaccurate prose beneath it then spends.

### R2-05 through R2-21 — remaining findings

Each was reproduced before being fixed; the reproductions are in the session
record and the substantive ones are written up in `FAILURES.md` entries 9–12.

- **R2-05** Adding a legitimately-named `pattern` field to `search_kb` produced
  `search_kb leaked "pattern" into its wire schema` — the sanitizer was correct,
  the test was position-blind, and `registry.test.ts:145` asserts that same field
  must survive. Two test files demanding opposite things is worse than either
  being wrong alone: the first to fail sends you to the wrong file.
- **R2-06** `url.includes("localhost")` matched passwords, usernames, database
  names and query strings, silently disabling TLS against a remote host. Fails
  open in the one direction that costs confidentiality rather than availability.
- **R2-07 / R2-08** Two boundary bugs the engine's own comments already promised
  against: a negative age read as inside every window, and `settled` vs
  `ageDays` disagreed on `undefined`. Same class as `FAILURES.md` entry 5 — that
  is a habit, not a bug.
- **R2-09** `z.base64()` leaked `format` **and** `contentEncoding`. Latent: no
  shipped tool emits `format`. Verified against current reference material that
  exactly ten string formats are supported.
- **R2-10** The `sops.active_version_id` comment claimed a real FK "needs a
  deferred constraint." Disproved in a rolled-back transaction: a non-deferred
  composite FK applies cleanly, the three-step insert order works, and a
  cross-SOP pointer is rejected by the database.
- **R2-11 / R2-12 / R2-13 / R2-21** Documentation accuracy: stale counts, a table
  not summing to its own total, unscoped present-tense prose next to a section
  that *had* the scoping callout, and "every one a real defect" applied to two
  entries that are not defects.
- **R2-14 / R2-15 / R2-16 / R2-17 / R2-18 / R2-19 / R2-20** Test holes, a
  gate that never exercised the component with the actual bug history, guidance
  that invited `if (stop_details)` as a refusal test, and an unstated Node
  version.

---

### Rejected and deferred — with reasoning

**R2-R1 · Forward-looking schema columns · Rejected.** The strongest brief
demanded ranking by *retrofit cost if deferred*, and it returned a well-argued
list: `run_spans.parent_span_id`, `eval_cases.revision`, `workspace_id` on the
eval tables, prompt-hash pinning on `agent_runs`, `refunds` and `drafts` tables,
an approvals uniqueness index, `invoices` CHECK constraints. The argument was
that each is *un-backfillable* once data exists.

Rejected because **those tables have zero rows.** "Un-backfillable" describes a
cost that begins accruing when data appears, and no data exists. Adding the
column on the day the feature lands costs exactly what adding it today costs,
minus the risk of designing storage for a feature whose shape is not settled.
Speculative columns are also not free: they invite the reader to believe a
feature exists.

One exception was taken, and it proves the rule: **R2-02 was fixed**, because it
is a correctness defect in an existing column — `jsonb` cannot store the
documented payload — not a speculative addition. The discriminator is *"is this
column wrong, or merely absent?"*

**R2-R2 · Re-seed orphans eval-run provenance · Deferred to Day 6.** The DDL
chain is real: `db:seed` deletes the demo workspace → `sop_versions` cascades →
`eval_runs.sop_version_id` is `ON DELETE SET NULL`, and `eval_runs` has no
`workspace_id`, so its rows survive pointing at nothing. It becomes a live
defect the moment Day 6 records the first eval run. Recorded here rather than
pre-solved, for the same reason as R2-R1.

**R2-R3 · Recursive schemas and `prefixItems` pass boot validation · Deferred.**
Confirmed genuinely unsupported by strict tool use. But no shipped tool uses
`z.lazy` or `z.tuple`, and `$ref`-cycle detection is real work for a case
nothing currently reaches. Recorded so it is a decision rather than an oversight.

**R2-R4 · Validate the policy at the boundary only · Rejected on own evidence.**
The suggested fix was a `parsePolicyConfig` helper for callers to invoke. Applied,
then the original probe was re-run, and the engine still approved $99,999.99.
Superseded by parsing at the point of decision.

**R2-R5 · `assertConsistent` position-blindness · Disproved.** This was the trap
planted in the brief — a confident, specific, wrong hypothesis. The agent tested
it and returned:

> the hypothesised false positive **does not occur**, verified empirically. A
> field named `type` inside `properties` always maps to a *schema object*
> (`{"type":"string","const":"object"}`), never the bare string `"object"`, so
> `node.type === "object"` cannot fire spuriously.

The review's credibility rests as much on this as on anything it found.

---

### Verification evidence

Every gate, run fresh at the close of the round:

```
verify:boot exit=0     verify:seed exit=0     lint exit=0
test exit=0            typecheck exit=0
```

- **Suite:** 131 passed (4 files) — 70 policy, 51 registry, 10 db client.
- **Mutation testing:** 14 reversions attempted, **14 killed**, 0 survived.
- **"No test requires a database":** re-confirmed with `DATABASE_URL` unset
  *and* poisoned (`postgres://nope:nope@127.0.0.1:1/nope`) — 131 passing both
  times, and with `ANTHROPIC_API_KEY` unset.
- **Clean-clone CI parity:** fresh `git clone` with no `.next/`, full `npm ci`,
  then `typecheck && test && lint` — all pass. This is the only way to surface
  the `next typegen` class of failure (`FAILURES.md` entry 3).
- **Migration `0001`:** applied inside `BEGIN … ROLLBACK` against the live
  container — 0 rows in `agent_runs`, converts to `text`, rolled back. The
  container remains `jsonb` until `npm run db:migrate` is run.
- **Shared container:** `54` invoices before and after; no leftover constraints
  or indexes from probe transactions.

### Not verified — coverage gaps stated plainly

- **The write half of the README quickstart was never executed.** Agents were
  forbidden `db:up` / `db:migrate` / `db:seed` to protect the shared container,
  so "quickstart verified" covers the no-Docker path and read-only gates only.
  `FAILURES.md` entry 2 was exactly a quickstart defect, so this gap is live.
- **No live Anthropic API call was made.** Every API claim is verified against
  current reference material, not against the wire. Specifically unconfirmed by
  request: whether `default` and optional properties are accepted under
  `strict: true`, and whether `prefixItems` / recursive `$ref` are rejected.
- **Migration `0001` is not applied** to any database.
- **Concurrency is reasoned, not raced.** `run_spans.seq` collisions,
  double-resume, and duplicate approvals are argued from the DDL. There is no
  agent loop yet to race them with.
- **Neon is untested.** All database verification ran against local PG17.
- **Node 22 is unverified.** CI pins 22; every local run used Node 24.

### Follow-ups carried forward

| Action | When | Why |
|---|---|---|
| `npm run db:migrate` | Before Day 2 | `serialized_messages` is still `jsonb` |
| Call `parsePolicyConfig` when the SOP editor **writes** | Day 4 | Reject a bad edit at authoring time, not at refund time |
| Re-run the README quickstart including migrate/seed | Day 2 | The gap above |
| Pricing table needs an effective-date field | Day 3 | Sonnet 5 intro rate expires 2026-08-31 |
| Revisit R2-R2 (eval provenance) | Day 6 | Becomes live on the first eval run |
| Revisit R2-R3 (recursive schemas) | Day 2 | If any tool schema grows a `z.lazy` |
| Composite FK on `sops.active_version_id` | Day 4 | SQL and traps recorded in the schema comment |

### Lessons

1. **A validator nothing must call is documentation.** The first fix for R2-01
   was correct code in the wrong place, and only re-running the original probe
   revealed it. Fix verification has to re-run the *original* reproduction, not
   the new test.
2. **A passing test proves nothing about coverage.** Two of this round's
   findings were holes in tests written alongside their own fixes, by someone
   who already knew the answer. Mutation testing is the only check that
   distinguishes a load-bearing assertion from a decorative one.
3. **Plant a wrong hypothesis in the brief.** R2-R5 cost nothing and is the only
   evidence that the other findings were not simply the asker's assumptions
   echoed back.
4. **"Un-backfillable" is a claim about data that exists.** Retrofit-cost
   arguments need a row count attached.
5. **Never write a subagent's API recollection into the repo unverified.**
   Converting an accurate document into an inaccurate one is a worse outcome
   than the finding was worth.

---

## Round 1 — 2026-08-11 — Post-gate adversarial pass

Two agents (claims audit, defect hunt) run after the Day-1 gate passed. Found
the position-blind schema sanitizer, a quickstart broken by an empty
`.env.example`, a CI failure invisible to local runs, a demo property true only
by a 74-millisecond margin, an inverted escalation rule, and an unevidenced TDD
claim. Written up in full as `FAILURES.md` entries 1–8; the practice change it
produced — committing the failing test separately — starts at `21aa814`.

---

## Appendix — the review prompts

Recorded because the prompts are the instrument. A review is only as good as
what it was told to disbelieve, and a reader cannot judge the findings without
seeing the brief that produced them.

**Shared framing given to all three agents:** repo path and public URL; the
project's purpose and audience (a security-literate engineer); `PLAN.md` as
authoritative; `FAILURES.md` as already-fixed and not to be re-reported, *but*
to be checked for whether each fix holds; an explicit list of what is
intentionally incomplete; the read-only and container constraints; the
reproduce-before-reporting bar; the confidence filter; and a required
"CHECKED AND CLEAN" section so coverage is distinguishable from silence.

**Agent 1 — foundation fitness.** Asked to trace Days 2–10 against the schema,
naming five specific load-bearing mechanisms (pause/resume reconstruction,
the trace/span model, SOP versioning, eval pinning, and anything expensive to
change once data exists). Output ordered by *retrofit cost if deferred*, not by
severity — the ordering is the question.

**Agent 2 — adversarial correctness.** Given the two known defect classes and
asked for **siblings**, plus whether each fix was complete or patched at the
reported symptom. Contained the deliberate wrong hypothesis (R2-R5). Required to
verify Anthropic API specifics against current documentation rather than memory,
and to mutate source on a scratch copy to prove test coverage.

**Agent 3 — claims audit.** Told to assume every claim is marketing until proven
*by execution*: clone to a temp dir, run the README verbatim, count the tests,
unset `DATABASE_URL` entirely, check each gate for vacuous passing, and produce
a `claimed vs actual` table for every countable claim.

Round 2's own work was then checked by a fourth agent that had not participated
in it. That prompt is recorded verbatim at
[`docs/reviews/round-2-verification-prompt.md`](reviews/round-2-verification-prompt.md),
including the note on why it is written as goal-and-constraints rather than as a
numbered procedure.
