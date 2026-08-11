# FAILURES.md

A dated log of what broke, how it was caught, and what changed.

This file exists because the interesting question about any codebase is not
whether it works — it's what happened on the way to working, and whether anyone
was looking.

Every entry below is a real problem this repository had. Most are defects; two
are not, and are labelled as such — entry 4 is an API trap caught during
implementation, and entry 7 is a process-evidence gap whose own verdict was
"unverifiable, not false." Calling those defects would be the same kind of
overclaim the rest of this file exists to record. Most were caught before they
could matter. Several were caught only because the code was reviewed by someone
other than the person who wrote it.

## How this repo is checked

The project's core engineering principle is **never trust the model** — the
refund limit is enforced in the SOP *and* revalidated in code, because a model's
proposal is an input, not a decision.

The same principle is applied one level up: **don't trust the code either, and
don't trust your own review of it.** Concretely, that means:

1. **Test-first for anything with logic.** RED → GREEN → REFACTOR. From
   2026-08-11 the failing test is committed *separately* from the fix, so the
   RED step is visible in `git log` rather than merely asserted (see entry 7 —
   an audit correctly called this out as unverifiable when it wasn't).
2. **Gates are verified with fresh evidence, never "it passed earlier."**
   Database-dependent checks live in `scripts/verify-*.ts` so `npm test` stays
   DB-free and CI can't silently depend on local state.
3. **Independent adversarial review.** Work is reviewed by agents that did not
   write it, given deliberately skeptical prompts — one auditing whether the
   README's claims survive contact with reality, one hunting for defects with
   instructions to be genuinely critical rather than reassuring.
4. **Every finding is reproduced before it is fixed.** A reviewer saying
   something is broken is a hypothesis. Entry 1 below was confirmed with a
   standalone probe before a line of the fix was written — and one of my own
   probes was initially *vacuous* and had to be redone, which is exactly why
   this step exists.

That third point is worth being explicit about: **the reviewers were AI agents,
not humans.** For a project about operating agents in production, using agents
to audit agent code — and then verifying their findings rather than taking them
on faith — is the practice being demonstrated, not a shortcut around it. They
were right about the substantive things and I confirmed each one myself.

---

## 1. The schema sanitizer was position-blind — 2026-08-11

**Severity: critical (latent).** Not triggered by any shipped tool, but it
undermined the exact guarantee the component existed to provide.

**Caught by:** independent code-review agent. Not by tests, not by boot
validation, not by me.

Anthropic's strict tool use rejects numerical and string constraints, so
`toStrictJsonSchema()` strips them from Zod's output before the schema goes on
the wire. The implementation deleted any key matching a blocklist, recursing
everywhere — which is wrong, because **JSON Schema is position-sensitive and a
blocklist applied by key name is not.**

Three reachable failures, all reproduced empirically before fixing:

```
1a. field named 'pattern':
   properties: [ 'other' ]   required: [ 'pattern', 'other' ]
   !! REQUIRED BUT ABSENT: pattern
```

A tool field named `pattern` was deleted from `properties` while surviving in
`required` — a schema demanding a field it simultaneously forbids. Nothing could
ever validate against it.

```
1b. nested z.record():
   {"type":"object","propertyNames":{...},"additionalProperties":{"type":"number"}}
```

`z.record()` emits `additionalProperties` as a *schema* and no `properties`, so
the closing block never fired and an illegal non-boolean value shipped.

```
1c. object-valued .default():
   {"keep":"z"}          # 'pattern' silently stripped from the default value
```

**What made it dangerous:** none of it threw. The sanitizer returned a quietly
wrong schema, so boot-time validation — the feature whose entire selling point
is *"a misconfigured tool fails at startup, not at 2am in production"* — was
blind to it. A silent success is worse than a loud failure.

**What it was NOT:** the recursion through `$defs`, `anyOf`/`oneOf`, and nested
object arrays was already correct. The reviewer checked and said so, which kept
the fix narrow.

**Fix:** the walk now tracks what a node *is* rather than matching key names
globally — `properties`/`$defs`/`patternProperties` hold name→schema maps whose
keys are author identifiers; `default`/`const`/`enum` hold literal data and are
never recursed into. Objects close on `type === "object"` unconditionally. Open
maps (`z.record()`, `.passthrough()`) now **fail at boot** rather than being
forced closed, because a closed record accepts nothing — refusing the tool is
more honest than shipping a field that silently matches nothing.

Added `assertConsistent()`: a boot check that no `required` entry names an
absent property. One assertion catches this whole bug class.

**Lesson:** a transform that can produce something unusable should *report*,
not return. And every test used ordinary field names — one test with a field
called `pattern` would have caught this on the first day.

---

## 2. `.env.example` shipped empty, so the README's own instructions failed — 2026-08-11

**Caught by:** independent audit agent, by actually running the README verbatim
on a fresh clone instead of reading it.

The README said `cp .env.example .env.local`, then run migrations. But
`DATABASE_URL=` in that file was **empty** — the working URL existed only in a
comment above it. The very next command died:

```
Error  Please provide required params for Postgres driver:
    [x] url: ''
```

**Compounding it:** the error message in `src/db/client.ts` pointed at port
**5433**, while the project uses **5434** — and 5433 is held by an unrelated
project on this machine, so a reader following the error would have connected to
the wrong database and gotten a confusing failure instead of a clean one. Four
other files said 5434; only that string disagreed.

**Lesson:** documentation that has never been executed is unverified, exactly
like code that has never been run. The fix is not proofreading — it's running
the quickstart on a clean checkout.

---

## 3. CI would have failed on its first real run — 2026-08-11

**Caught by:** review, then confirmed by cloning the repo and running CI's exact
steps. A local run *cannot* surface this.

`npm run typecheck` passed locally and failed on a clean checkout:

```
src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'.
```

Next 16 generates global helper types into `.next/types/`, which `tsconfig`
includes but git ignores. Locally they exist because `next dev` has run; on a
fresh clone they don't.

**Verified negatives** — both wrong, both tried:
- Committing `next-env.d.ts` does not fix it. Wrong file; the symbols come from `.next/types/`.
- `npm ci` was not the problem, despite heavy dependency churn that session.

**Fix:** `"typecheck": "next typegen && tsc --noEmit"` — in the *script*, not
the workflow, so local, CI, and fresh clones behave identically.

**Lesson:** a CI workflow that has never executed is an unverified deliverable.
`git clone` of the local repo is a faithful stand-in when there's no remote yet.

---

## 4. Zod's JSON Schema output is not strict-legal — 2026-08-11

**Caught by:** probing the serialiser during implementation rather than assuming
its output.

`z.number().int().positive()` emits `exclusiveMinimum` **and** an unrequested
`maximum: 9007199254740991`; `.min(1).max(500)` on a string emits
`minLength`/`maxLength`. Anthropic's `strict: true` rejects all numerical and
string constraints.

Easy to miss because the official SDKs silently strip unsupported constraints
and validate client-side — so this can work by accident until you hand-roll the
request.

**Fix:** strip the keywords for the wire; keep the Zod schema enforcing them at
parse time. Stripping narrows what the *model* is told, never what the *code*
accepts — a negative `amount_cents` still fails `safeParse`. (The first
implementation of this fix was itself buggy — see entry 1.)

---

## 5. A nullable enum compared with `!==` inverted an escalation rule — 2026-08-11

**Caught by:** review, before it reached the agent loop.

Escalation flagged churn risk when `refundOutcome !== "approve"`. But that field
is `RefundOutcome | null`, and `null` means *no refund was requested*. So every
high-value customer asking a routine how-to question was escalated as a churn
risk. The comment directly above the code already said "a churn risk is a
*dissatisfied* high-value customer" — the code just didn't implement its own
comment.

**Why no test caught it:** every churn test passed either `"deny"` or a *low*
lifetime value. The high-value + `null` cell was never exercised, and the one
high-value test also tripped a second reason, so the assertion would have passed
either way.

**Why it mattered:** escalation rate is a headline metric in Mission Control. A
false positive here inflates precisely the number the dashboard exists to
report.

**Fix:** dissatisfaction must be positively established — refund denied, or an
explicit signal the model sets from ticket tone.

**Lesson:** a nullable enum has three states. `!== X` is not "is not X".

---

## 6. The demo's headline claim held by a 74-millisecond margin — 2026-08-11

**Caught by:** audit agent, which refused to trust the project's own gate script
and re-derived the claim independently across the full dataset.

The demo turns on narrowing the refund window 30 → 14 days and **exactly one**
invoice flipping. `verify-seed.ts` asserted three *hardcoded* invoice numbers —
which cannot substantiate a claim quantified over all 54 rows.

Re-derived independently, the claim was true: exactly one invoice flipped. But
three filler invoices sat at **exactly 30.0009 days**, outside the window only
because real time elapses between seeding and evaluation. Had evaluation run
instantly, four invoices would have flipped and the demo would have been mush.

**Impact status: not a live bug.** `paidAt` is fixed at seed time and `now` only
advances, so those rows are stably outside the window. But the property was true
*by accident*, and nothing in the repo would have noticed if the seed generator
changed.

**Fix:** filler ages now clear both boundaries by 6+ days *by construction*, and
`verify-seed.ts` evaluates all 54 invoices and asserts the quantified property
directly — plus that nothing sits within a day of a boundary.

**Lesson:** assert the claim you actually make. Checking three examples of "all"
is checking three examples.

---

## 7. TDD was claimed but not evidenced — 2026-08-11

**Caught by:** audit agent, checking `git log --stat` against the commit
messages instead of believing them.

Commits claimed tests were written first and watched fail. `git log` showed
tests and implementation landing in the **same commit** every time, with a clean
reflog and no rewritten history. The verdict was precise and fair:
**unverifiable from history, not false.**

**Fix:** from this date, the failing test is committed separately from the fix.
Costs nothing; turns a process claim into evidence anyone can check. Entry 1's
fix is the first to do it — `test: … (RED)` followed by `fix: …`.

**Lesson:** if a practice is worth claiming, it's worth leaving evidence of.

---

## 8. Present-tense prose for code that didn't exist — 2026-08-11

**Caught by:** audit agent, cross-checking README prose against the actual
handlers.

The README described the `issue_refund` handler revalidating against policy and
rejecting out-of-policy calls — in the present tense. In reality all nine tool
handlers throw `NotImplementedError` by design until Day 2. The "What's built"
table was scrupulously accurate; only the prose section overclaimed. Same for a
"public demo runs `claude-haiku-4-5`" line when no demo is deployed.

`docs/PLAN.md` also still specified Next.js 15 while the repo runs 16, despite
`CLAUDE.md` naming PLAN.md the source of truth.

**Fix:** both claims scoped to the day they land; PLAN.md corrected.

**Lesson:** the honest-sounding sections are the ones to re-read. An accurate
status table sitting above inaccurate prose is worse than either alone, because
the accurate part earns trust the inaccurate part then spends.

---

## 9. The policy engine failed open on a malformed policy — 2026-08-11

**Severity: critical.** The single worst defect found in this repository.

**Caught by:** a second independent review round, on code that had already been
through one adversarial pass and had 79 passing tests.

`evaluateRefund` takes `policy: PolicyConfig`. That type is erased at build
time, and the value it describes arrives at runtime from
`sop_versions.policy_config` — a `jsonb` blob written by the SOP editor, which
is the product's headline feature. Nothing parsed it.

Every rule in the engine is a `>` comparison, and **`x > undefined` is
`false`**. So a missing key did not throw. It silently removed that limit:

```
invoice: 400 days old, requesting $99,999.99 | hard cap: $500.00
A. well-formed DEFAULT_POLICY     outcome=deny      approved=$0.00       violations=[outside_refund_window,exceeds_max_refund]
B. refund:{} (all keys missing)   outcome=approve   approved=$99999.99   violations=[]
F. windowDays missing only        outcome=deny      approved=$0.00       violations=[exceeds_max_refund]
```

Case B is a $99,999.99 refund on a year-old invoice, approved with **zero
violations** and no human in the loop. Case F shows the deletion is per-key, so
a single typo is enough. A typo'd ceiling was worse than useless: it didn't deny
the refund, it routed it to the approval queue as a *legitimate* pending
request.

**Why it is the worst one:** this module is the code half of "never trust the
model." It exists so that a model's proposal is revalidated by something that
cannot be talked out of it. It was revalidating against a blob it trusted
completely.

**Fix:** `policyConfigSchema` — a Zod schema parsed **at the point of decision,
not only at the boundary**. The first attempt validated only in a
`parsePolicyConfig` helper that callers were expected to call; re-running the
original probe showed `evaluateRefund` still approving $99,999.99, because a
guarantee nothing is obliged to invoke is documentation, not enforcement. That
is the same "claimed but not enforced" pattern this very file catalogues, so the
parse moved inside both `evaluateRefund` and `evaluateEscalation`. `.strict()`
is what catches the misspelling — without it a typo'd key is dropped as unknown
and the real key reads as missing, which is the identical silent failure.

**Lesson:** a TypeScript interface is a claim about a value, not a check on it.
Wherever a typed value crosses a runtime boundary — a database, a request body,
a file — the type is a comment until something parses it. And "I added a
validator" is not the same as "the thing is validated."

---

## 10. The safety net from entry 1 had no test that could fail — 2026-08-11

**Caught by:** mutation testing during the second review, not by reading.

Entry 1's fix added `assertConsistent()` and claimed "one assertion catches this
whole bug class." Deleting the call entirely left the suite green:

```
  SURVIVED  remove assertConsistent() call entirely   <-- TEST HOLE
  SURVIVED  assertConsistent: never report orphans    <-- TEST HOLE
```

The test that *looked* like coverage — "never lets required reference a property
that does not exist" — asserted a property the fixed sanitizer already
guarantees on its own, so it passed with or without the check. That is exactly
the "asserting on the wrong cell" pattern from entry 5, recurring **inside the
fix for entry 1**.

**Fix:** tests that feed `assertConsistent` an inconsistency the sanitizer
cannot produce, via Zod's `.meta()` raw-schema injection. Both mutations are now
killed. The whole suite was then mutation-tested: fourteen deliberate reversions
of every fix in this round, fourteen caught.

**Lesson:** a test that passes is not evidence of coverage. The only way to know
an assertion is load-bearing is to break the thing it guards and watch it fail.
A regression test written in the same sitting as its fix is especially suspect,
because it was written by someone who already knew the answer.

---

## 11. Three smaller ones from the same pass — 2026-08-11

**The regression net contradicted the fix it was protecting.** `keywordsIn()` in
`tools.test.ts` collected every key at every depth — *position-blind*, the exact
bug entry 1 was about. A tool field legitimately named `pattern` failed it,
while `registry.test.ts:145` asserts that same field must survive. Two test
files demanding opposite things is worse than either being wrong alone, because
the first one to fail sends you to the wrong file. Reproduced by adding a
`pattern` field to `search_kb`: `search_kb leaked "pattern" into its wire
schema` — the sanitizer was right, the test was wrong.

**TLS was selected by substring.** `getDb()` used
`url.includes("localhost")` over the *whole* connection string, so a password,
username or database name containing `localhost` silently disabled encryption
against a remote host. It failed open, in the one direction that loses
confidentiality rather than availability. Now decided from the parsed hostname,
which also makes a malformed `DATABASE_URL` fail at `getDb()` rather than on the
first query.

**Two boundary bugs the engine's own comments already promised.** A future-dated
`paidAt` produced a negative age, which read as inside every refund window —
unlimited refunds from clock skew or a mis-mapped column. And `settled` tested
`paidAt !== null` while the age calculation used truthiness; they disagree on
`undefined`, which a Drizzle row or a JSON round-trip can produce, so an invoice
with no payment date at all came back **approved**. A nullable field now gets
exactly one null test.

**Lesson:** the nullable-enum class from entry 5 is not one bug, it's a habit.
Two comparisons against the same nullable field, written minutes apart with
different idioms, will eventually disagree.

---

## 12. A comment that was confidently wrong about Postgres — 2026-08-11

**Caught by:** a reviewer that refused to take the comment at face value and
tested the claim against the running database.

`sops.active_version_id` carried a comment explaining that a real foreign key
was impossible without a deferred constraint, because `sops` and `sop_versions`
are mutually referential. Both halves were wrong. The column is nullable, so
there is no insert-time cycle, and a *composite* FK enforces more than the
single-column one could — including that the target version belongs to this same
SOP. Verified in a rolled-back transaction on this project's own PG17:

```
ALTER TABLE
OK: three-step insert order works with a NON-deferred FK
ERROR: insert or update on table "sops" violates foreign key constraint "sops_active_version_fk"
```

**Impact status: not a live bug.** No FK was missing that should have been there
— the constraint is still deliberately deferred to Day 4. What was wrong was the
*stated reason*.

**Fix:** the comment now carries the working SQL, the two traps that come with it
(the PG15+ column-list form of `ON DELETE SET NULL`, and the seed's insert
order), and an honest reason for waiting.

**Lesson:** for a repository read by engineers, a confidently wrong explanation
costs more than a missing feature. The feature is a to-do; the explanation is
evidence about whether the author knows the system. Comments asserting what a
database *cannot* do should be tested exactly like code.
