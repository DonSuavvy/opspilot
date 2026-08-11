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

## Round 3 — 2026-08-12 — Verification of Round 2

**Question asked:** Round 2 audited the code. Does Round 2's own write-up
survive the same treatment?

**Method:** a single agent that **did not participate in Round 2**, given the
round's write-up and told to treat it the way Round 2's Agent 3 was told to
treat the README — as marketing until executed. Its prompt is recorded verbatim
at [`docs/reviews/round-2-verification-prompt.md`](reviews/round-2-verification-prompt.md).

**Headline:** five documentation claims that do not hold, one **critical live
defect** in the policy engine, a smaller live defect in Round 2's own TLS fix,
and one of Round 2's rejected findings overturned outright. Two further defects
are recorded **open** rather than closed by default. Suite 131 → **164**. The
code findings are fixed in `fc0b78d`, `49127b3` and `2273ae1`; the claims are
corrected in place in the Round 2 section below, each marked as a Round 3
correction rather than quietly rewritten.

### Why the corrections are marked rather than edited away

This repository's argument is that its author verifies claims instead of
asserting them. A false claim in its documentation is therefore worse than an
ordinary bug: it is the product failing at the one thing it exists to
demonstrate. Silently correcting the text would produce a clean document and
destroy the evidence that the check happened — which is the same move as a
green suite that never had a failing test.

### Findings ledger

| ID | Severity | Finding | Where | Status |
|---|---|---|---|---|
| R3-01 | **Critical** | Policy engine trusted its *evaluation input*; `new Date(undefined)` approved $50.00 on a 400-day-old invoice with zero violations | `src/policy/refund.ts` | Fixed `2273ae1` |
| R3-02 | Medium | Loopback lookup did not fold hostname case; `@LOCALHOST` demanded TLS from a Docker PG that offers none | `src/db/client.ts` | Fixed `fc0b78d` |
| R3-03 | Medium | `eval_runs`/`eval_results` had no `workspace_id`, so deleting a workspace orphaned their rows instead of removing them — R2-R1's rejection overturned | `src/db/schema.ts` | Fixed `49127b3` |
| R3-04 | High (claim) | "Clean-clone CI parity" run against a tree that did not contain the round's work | `docs/REVIEWS.md` | Corrected + re-run |
| R3-05 | High (claim) | "Every fix is pinned by a mutation test" — a different 14 left 3 alive | `README.md`, `docs/REVIEWS.md`, `docs/FAILURES.md` | Corrected + pinned |
| R3-06 | Medium (claim) | `.strict()` rationale describes a mechanism that cannot occur | `docs/REVIEWS.md`, `docs/FAILURES.md`, `src/policy/refund.ts` | Corrected |
| R3-07 | Medium (claim) | Test split gave three categories for four files, folding a file the round rewrote | `docs/REVIEWS.md`, `README.md` | Corrected |
| R3-08 | Medium (claim) | R2-R1 rejected on "those tables have zero rows" — `invoices` has 54 | `docs/REVIEWS.md` | Corrected, conclusion kept |
| R3-09 | Medium (latent) | `evaluateEscalation` drops `churn_risk` on a NaN LTV | `src/policy/refund.ts` | Fixed — new `unknown_customer_value` reason |
| R3-10 | Low | `getDb()`'s malformed-URL guard catches less than it claims | `src/db/client.ts` | **Open — dev papercut** |

The claim findings are corrected at their sites in the Round 2 section below;
R3-09 and R3-10 are `FAILURES.md` entries 13 and 14.

### R3-01 — the half-fixed bug class · **Critical**

Round 2 fixed `evaluateRefund`'s `policy` argument, correctly reasoning that
`PolicyConfig` is a compile-time claim about a value arriving from `jsonb` at
runtime. `RefundEvaluationInput` is the identical shape of claim — its `invoice`
comes from a Drizzle row, and from Day 2 its fields carry model-proposed values
— and nothing parsed it. Round 2 named this class and did not notice it applied
twice.

`new Date(undefined)` is an Invalid Date, which is a real `Date` instance, so it
survived the `paidAt ?? null` normalisation and poisoned `ageDays`. Both
`ageDays < 0` and `ageDays > windowDays` are false against NaN, so it skipped
the future-dated guard **and** the window check together:

```
paidAt = new Date(undefined)   before: approve $50.00 on a 400-day-old invoice, violations=[]
                                after: deny, violations=[invalid_invoice_data, invoice_not_paid]
amountCents = NaN              before: approve $30.00 against a $20.00 invoice, violations=[]
                                after: deny, violations=[invalid_invoice_data]
```

Under $100 those auto-approved with no human. Between $100 and $500 they reached
the approval queue looking clean, with no violations listed — the same trap
Round 2 documented in R2-01 and then left open one argument to the left.

### What Round 2 got right

Stated as plainly as the failures, because a verification round that only
reports errors is as unbalanced as a review that only reports successes.

- **R2-01 was real and correctly ranked.** The policy engine did fail open, it
  was the worst defect in the repository, and the write-up of the wrong first
  fix — a validator nothing was obliged to call — is the most useful paragraph
  in this file.
- **The TLS work survived mutation testing intact.** Six reversions on
  `src/db/client.ts`, **six killed**. The one defect found there is a case-fold
  edge Round 2's fix did not reach, not a hole in its tests.
- **R2-R5 was genuinely disproved**, and the planted-hypothesis technique did
  what it was meant to.
- **R2-R1's conclusion holds for five of its seven items**, and holds for
  `invoices` too once the premise is replaced with the evidence.

### Verification evidence

Measured on `48db720`, the last commit that changes code — named that precisely
because "which tree did the gate run against" is exactly what R3-04 was about.
The only commit after it is the documentation edit recording these numbers:

```
typecheck exit=0    test exit=0    lint exit=0    verify:boot exit=0    verify:seed PASS
```

- **Suite:** **164 passed (4 files)** — 93 `refund.test.ts`, 42
  `registry.test.ts`, 9 `tools.test.ts`, 20 `client.test.ts`. Counted per file,
  because the three-way split is what R3-07 was about.
- **Trajectory:** 79 → 131 (Round 2) → 164. Both endpoints were measured per
  file, so the decomposition is checked rather than inferred: Round 2's suite was
  70 / 42 / 9 / 10 and this one is 93 / 42 / 9 / 20 — 23 policy tests and 10
  db-client tests added, and **nothing** to registry or tools. Measuring that
  split is what exposed R3-07 in the first place: `registry.test.ts` counted 42,
  not the 51 the prose claimed, because 51 was silently `registry` plus `tools`.
- **No test requires a database:** 164 passing with `DATABASE_URL` and
  `ANTHROPIC_API_KEY` both unset.
- **Clean-clone CI parity — genuinely, this time.** Fresh `git clone` of
  `48db720`, no `.next/`, full `npm ci` (exit 0), then `typecheck` → `test` →
  `lint`, all exit 0, 4 files / 164 tests. The clone was confirmed to contain the
  work under review: `invalid_invoice_data` present in `src/policy/refund.ts`,
  migrations `0000`, `0001` and `0002` all present.
- **Migrations `0001` and `0002` validated against a real Postgres.** Both
  applied inside `BEGIN … ROLLBACK` on the shared PG17 container: 5 `ALTER
  TABLE`, 2 `CREATE INDEX`, all accepted. `serialized_messages` became `text`
  and `eval_runs.workspace_id` became `uuid` inside the transaction, and
  Postgres reported the delete rule on both new foreign keys as `ON DELETE
  CASCADE` — read from `pg_constraint`, not from the migration file. After
  rollback the container is byte-identical: `jsonb`, column absent, 54 invoices,
  1 applied migration, 0 leftover indexes. Neither migration is applied.
- **Mutation testing, `src/policy/refund.ts`:** 14 reversions, **11 killed, 3
  survived** — all three the `.strict()` calls. Now pinned: removing each in
  turn fails **exactly one** named test (`rejects an unknown key inside the
  refund block` / `inside the escalation block` / `at the top level`).
- **Mutation testing, `src/db/client.ts`:** 6 reversions, **6 killed**.
- **`.strict()` semantics:** probed directly against the installed Zod 4.4.3.
  Transcript at R2-01 below.
- **`invoices` row check:** 54 rows, checked against all five constraints the
  R2-R1 reviewer proposed. Zero violations on each.

### Not verified — coverage gaps stated plainly

These are gaps in **this** round, and they are larger than Round 2's.

- **`src/agent/registry.ts` was not examined at all.** The format allowlist's
  behaviour at depth, and whether `assertConsistent` produces false positives or
  false negatives, are unchecked. So is whether `tools.test.ts` and
  `registry.test.ts` now agree after R2-05 — the two files that were previously
  demanding opposite things.
- **`scripts/verify-boot.ts` gate effectiveness is unchecked.** R2-17's fix is
  committed; what is unverified is whether the gate now actually catches what it
  is supposed to. It remains a gate whose usefulness is *asserted* rather than
  demonstrated — which is what R2-17 found wrong with it in the first place.
- Both gaps have the same cause: **two sub-agents assigned to them terminated on
  a session limit before reporting.** Recorded as an absence rather than left to
  look like coverage, which is the failure mode this file exists to prevent.
- **Neither migration is applied.** Both were validated — Postgres parsed and
  accepted them inside a rolled-back transaction, and reported `ON DELETE
  CASCADE` on both new foreign keys from `pg_constraint` — so "the DDL is valid"
  is now observed rather than inferred. What remains unobserved is the
  *behaviour*: no workspace has actually been deleted and no eval row watched to
  disappear with it. That needs the migration applied for real.
- **No live Anthropic API call**, and **Neon is still untested** — both carried
  forward unchanged from Round 2.

### Follow-ups carried forward

| Action | When | Why |
|---|---|---|
| Point the eval runner at a workspace with `expires_at IS NULL` | Day 6 | `eval_runs` now cascades from `workspaces`; the TTL sweep that reaps demo sandboxes would otherwise erase the regression baseline the CI gate compares against |
| `npm run db:migrate` | Before Day 2 | `0001` **and** `0002` are generated and unapplied |
| Decide the contract for an unknown `customerLifetimeValueCents` | Day 2 | `FAILURES.md` entry 13. Every option is a contract change; it needs an owner, not a default |
| Examine `registry.ts`, the two test files' agreement, and `verify:boot` | Day 2 | The coverage gap above — the largest unreviewed surface in the repo |

### Lessons

1. **A gate run against the wrong tree is worse than a gate not run.** The
   clean-clone check passed, and it passed on code that did not contain the
   round's work. Nothing in the output said so. Any claim about a clone needs
   the commit it was taken at recorded beside it.
2. **A kill rate measures the mutants you chose.** Round 2 chose fourteen and
   killed fourteen, then wrote "every fix is pinned." A different fourteen on
   one file left three alive. When the same party picks the mutants and reports
   the score, the number is evidence about the picker.
3. **Fixing half a bug class and naming the other half is the dangerous case.**
   R2-01's write-up contains every element needed to find R3-01. Having the
   words is not having the check.
4. **A correct conclusion resting on a false premise still has to be fixed.**
   R2-R1 reached the right answer through a row count that was wrong for the one
   table in its list that holds data.

---

## Round 2 — 2026-08-11 — Foundation fitness

**Question asked:** will Days 2–10 of `docs/PLAN.md` build on this foundation,
or will something need retrofitting?

**Headline:** one critical defect (the policy engine failed open on a malformed
policy — a $99,999.99 refund approved against a $500 ceiling with zero
violations), 20 further findings fixed, 5 findings rejected or deferred with
reasons recorded below. Suite went 79 → 131 tests. Fourteen deliberate
reversions of the fixed code were run, and all fourteen were killed.

> **Corrected by Round 3.** This paragraph originally ended *"every fix is
> pinned by a mutation test."* Fourteen reversions that all die prove those
> fourteen lines are covered and say nothing about the lines nobody reverted.
> Round 3 ran fourteen **different** reversions on `src/policy/refund.ts` and
> three survived — every one of them a `.strict()` call. They are pinned now;
> see Round 3 above.

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
   *Round 3 correction:* this establishes that the fourteen reverted lines are
   covered. It was then written up as though it established that **every** fix
   was covered, which is a different and much larger claim. Choosing the
   mutants and reporting the kill rate are the same act here, so the number
   measures the chooser as much as the suite.
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
| R2-R1 | — | Forward-looking schema columns for Days 3–8 | `src/db/schema.ts` | **Rejected** — R3: holds for 5 of 7; bad premise; `workspace_id` overturned |
| R2-R2 | — | Re-seed orphans eval-run provenance | `src/db/seed.ts` | Deferred to Day 6 — **fixed in `49127b3`** |
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
and `evaluateEscalation`.

`.strict()` is load-bearing, but not for the reason first written here. This
section originally claimed that without it *"a misspelled key is discarded as
unknown and the real key reads as absent — the identical silent failure."*
**That mechanism cannot occur.** A misspelling leaves the correct key absent,
and an absent required key is rejected either way. Measured against the
installed Zod 4.4.3:

```
typo: maxRefundCent (missing final s)
  .strict()        REJECTED (invalid_type: expected number, received undefined
                             | unrecognized_keys: "maxRefundCent")
  without strict   REJECTED (invalid_type: expected number, received undefined)
all 4 correct keys PLUS one bogus extra key
  .strict()        REJECTED (unrecognized_keys: "maxRefundDollars")
  without strict   ACCEPTED                            <-- the real difference
```

What `.strict()` actually buys is narrower and still worth having: it rejects
an **extra** key alongside an otherwise-complete, valid policy. That is the
Day-4 SOP editor writing a limit this engine does not implement — without
`.strict()` the key is dropped in silence and the operator believes a rule is
enforced that no line of code reads. It is applied at all three levels because
each object polices only its own keys.

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

> **Corrected by Round 3 — the premise was false for one item in its own list.**
> `invoices` holds **54 rows**, seeded, and this same document reports "54
> invoices before and after" ten lines further down. The cost model was wrong
> too: a CHECK constraint on a populated table is not a backfill problem, it is
> a validation problem — the `ALTER TABLE` either passes against existing rows
> or fails outright.
>
> The conclusion survives, on evidence rather than on the bad premise. All 54
> rows were checked against every constraint the reviewer proposed —
> `amount_cents < 0`, `refunded_cents < 0`, `refunded_cents > amount_cents`,
> paid status with a null `paid_at`, and a future `paid_at`. **Zero violations
> on all five.** So the constraint would apply cleanly whenever it is added,
> and deferring it costs nothing. Right answer, wrong reason, and the wrong
> reason was the one written down.
>
> Round 3 also overturned item 3 outright: `workspace_id` on the eval tables
> **shipped** in `49127b3`. Of the seven items, the rejection holds for five.

One exception was taken, and it proves the rule: **R2-02 was fixed**, because it
is a correctness defect in an existing column — `jsonb` cannot store the
documented payload — not a speculative addition. The discriminator is *"is this
column wrong, or merely absent?"*

**R2-R2 · Re-seed orphans eval-run provenance · Deferred to Day 6, then fixed.**
The DDL chain was real: `db:seed` deletes the demo workspace → `sop_versions`
cascades → `eval_runs.sop_version_id` is `ON DELETE SET NULL`, and `eval_runs`
had no `workspace_id`, so its rows survived pointing at nothing. It would have
become a live defect the moment Day 6 recorded the first eval run.

> **Superseded by Round 3.** Round 3 overturned the `workspace_id` half of
> R2-R1, and `49127b3` added `workspace_id` to `eval_runs` and `eval_results`
> with `ON DELETE cascade` from `workspaces` (migration `0002`). Re-seeding now
> deletes those rows instead of orphaning them, so the sentence above no longer
> describes the schema. It is kept because it is the reasoning that produced
> the deferral, and a deferral whose stated cause has been deleted is not
> auditable.
>
> The fix moves the problem rather than ending it: `eval_runs` now cascades
> from `workspaces`, and the Day-8 TTL sweep that reaps demo sandboxes deletes
> workspaces. Day 6 must therefore run evals against a workspace with
> `expires_at IS NULL`, or the sweep erases the regression baseline the CI gate
> compares against. Carried in Round 3's follow-ups table above.

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

Every gate, run fresh at the close of Round 2. Every figure in this section is
Round 2's, measured then — current numbers are in Round 3 above:

```
verify:boot exit=0     verify:seed exit=0     lint exit=0
test exit=0            typecheck exit=0
```

- **Suite:** 131 passed (4 files) — 70 `refund.test.ts`, 42 `registry.test.ts`,
  9 `tools.test.ts`, 10 `client.test.ts`.
  *Round 3 correction:* this line originally read "70 policy, 51 registry, 10 db
  client" — three categories for four files. "51 registry" folded
  `registry.test.ts` and `tools.test.ts` together, and `tools.test.ts` is a file
  this very round rewrote (R2-05). The totals are unchanged. Provenance of the
  split, since that is the whole point: the 42 and the 9 were measured at
  `2273ae1` and hold for `3c13f0e` because neither file was touched between the
  two (`git diff --stat 3c13f0e..2273ae1 -- '*.test.ts'` lists only
  `client.test.ts` and `refund.test.ts`). The 70 and the 10 are Round 2's own
  figures, carried forward unverified; they are consistent with the total.
- **Mutation testing:** 14 reversions attempted, **14 killed**, 0 survived — of
  the fourteen chosen. *Round 3 correction:* see the headline note above. A
  different fourteen on `src/policy/refund.ts` left three alive.
- **"No test requires a database":** re-confirmed with `DATABASE_URL` unset
  *and* poisoned (`postgres://nope:nope@127.0.0.1:1/nope`) — 131 passing both
  times, and with `ANTHROPIC_API_KEY` unset.
- **Clean-clone CI parity: withdrawn — this gate did not cover this round.**
  A fresh `git clone` was run, and it passed, but Round 2's work was entirely
  **uncommitted** at the time, so the clone reproduced `603776e` — the
  pre-review tree. That tree runs 79 tests and contains zero occurrences of
  `parsePolicyConfig` — `git grep -c parsePolicyConfig 603776e; echo $?` prints
  `1`, git's no-matches exit. The exit code is quoted rather than the empty
  output because empty output is also what a bad rev or pathspec produces; the
  same command for `evaluateRefund` at that rev exits `0` and prints a hit,
  which is what makes the negative mean something.
  The gate that exists to catch what a working tree hides was run against a tree
  that did not contain the fixes, two bullets under "Suite: 131 passed," where
  it reads as though the clone ran the 131. It ran 79 tests of code this round
  had already superseded.

  **Now genuinely true, at `2273ae1`.** Round 3 re-ran it after the work was
  committed: fresh `git clone`, no `.next/`, full `npm ci` (exit 0), then
  `typecheck` (exit 0) → `test` (exit 0, 4 files / **164 tests**) → `lint`
  (exit 0). The clone was confirmed to contain the fixes — `invalid_invoice_data`
  present in `src/policy/refund.ts`, migrations `0000`, `0001` and `0002` all
  present. This is still the only way to surface the `next typegen` class of
  failure (`FAILURES.md` entry 3).
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
| `npm run db:migrate` | Before Day 2 | `0001` **and** `0002` are unapplied: `serialized_messages` is still `jsonb`, and the eval tables still have no `workspace_id` |
| Call `parsePolicyConfig` when the SOP editor **writes** | Day 4 | Reject a bad edit at authoring time, not at refund time |
| Re-run the README quickstart including migrate/seed | Day 2 | The gap above |
| Pricing table needs an effective-date field | Day 3 | Sonnet 5 intro rate expires 2026-08-31 |
| Revisit R2-R2 (eval provenance) | Closed | Fixed by `49127b3`; replaced by the `expires_at` follow-up in Round 3 |
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
