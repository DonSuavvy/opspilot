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

Two things this file does **not** claim. **Entry 13 is open** — a live defect,
deliberately unfixed because every available fix is a contract change that needs
an owner's decision rather than a default. And entries 9 and 10 carry dated
corrections: a later pass found that both had described their own fixes
inaccurately. Those corrections are marked in place rather than edited away,
because a defect log that quietly rewrites itself is worth about as much as a
green suite that never had a failing test.

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
parse moved inside both `evaluateRefund` and `evaluateEscalation`.

**Correction — 2026-08-12.** This entry originally continued: *"`.strict()` is
what catches the misspelling — without it a typo'd key is dropped as unknown and
the real key reads as missing, which is the identical silent failure."* **That
mechanism cannot occur.** A misspelling leaves the correct key absent, and an
absent required key is rejected with or without `.strict()`. Measured against
the installed Zod 4.4.3:

```
typo: maxRefundCent (missing final s)
  .strict()        REJECTED (invalid_type: expected number, received undefined
                             | unrecognized_keys: "maxRefundCent")
  without strict   REJECTED (invalid_type: expected number, received undefined)
all 4 correct keys PLUS one bogus extra key
  .strict()        REJECTED (unrecognized_keys: "maxRefundDollars")
  without strict   ACCEPTED                            <-- the real difference
```

`.strict()` buys something narrower and still worth having: it rejects an
**extra** key alongside an otherwise-complete, valid policy. That is the Day-4
SOP editor writing a limit this engine does not implement — without it the key
is dropped in silence and the operator believes a rule is enforced that no line
of code reads. The code comment carried the same wrong explanation and was
corrected with it.

**The class was only half-closed — 2026-08-12.** The argument above applies
word for word to `RefundEvaluationInput`, and this entry made it without
noticing. That interface is erased at build time too, its `invoice` arrives from
a Drizzle row, and from Day 2 its fields carry model-proposed values. Nothing
parsed it either. `new Date(undefined)` is an Invalid Date — a real `Date`
instance — so it survived normalisation and poisoned `ageDays`, and NaN is false
against both `< 0` and `> windowDays`, skipping the future-dated guard **and**
the window check at once:

```
paidAt = new Date(undefined)   before: approve $50.00 on a 400-day-old invoice, violations=[]
amountCents = NaN              before: approve $30.00 against a $20.00 invoice, violations=[]
```

Under $100 those auto-approved with no human; between $100 and $500 they reached
the approval queue with an empty violations list, which is the trap this entry
describes two paragraphs above. Fixed in `2273ae1`: invoice fields now yield a
single `invalid_invoice_data` violation rather than throwing, because this
engine's job is to report *every* violation so the trace viewer can show why a
refund was refused, and a `ZodError` shows the reader nothing.

**Lesson:** a TypeScript interface is a claim about a value, not a check on it.
Wherever a typed value crosses a runtime boundary — a database, a request body,
a file — the type is a comment until something parses it. And "I added a
validator" is not the same as "the thing is validated." Nor is naming a bug
class the same as checking every place it applies: this entry described the
class precisely and then shipped with the second instance still open, one
argument to the left of the one it fixed.

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
killed. Fourteen further deliberate reversions were then run across the round's
fixes, and all fourteen were caught.

**Correction — 2026-08-12.** That last sentence originally read *"the whole
suite was then mutation-tested: fourteen deliberate reversions of every fix in
this round, fourteen caught."* Fourteen reversions that all die prove those
fourteen lines are covered. They are not a statement about every fix, and the
sentence was written as though they were. A later pass ran fourteen **different**
reversions on `src/policy/refund.ts` alone: **11 killed, 3 survived**, all three
being the `.strict()` calls this file describes in entry 9. They are pinned now
— removing each in turn fails exactly one named test. A separate 6 reversions on
`src/db/client.ts` were all killed.

**Lesson:** a test that passes is not evidence of coverage. The only way to know
an assertion is load-bearing is to break the thing it guards and watch it fail.
A regression test written in the same sitting as its fix is especially suspect,
because it was written by someone who already knew the answer. And a kill rate
describes the mutants somebody chose: when the same party picks the mutants and
reports the score, the number is evidence about the picker as much as the suite.

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

---

## 13. The escalation engine has entry 9's bug, pointing the other way — 2026-08-12

**Severity: medium (latent). Status: OPEN — deliberately not fixed.**

**Caught by:** fixing entry 9's other half. Once `evaluateRefund` was made to
parse its own input, the same question was asked of `evaluateEscalation` and it
had not been.

`evaluateEscalation` parses its `policy` argument and **not** its input. The
churn-risk rule reads:

```ts
input.customerLifetimeValueCents >= rules.churnRiskLtvCents && dissatisfied
```

`customerLifetimeValueCents` is typed `number`, which is erased at build time;
the value arrives from a Drizzle row. `NaN >= x` and `undefined >= x` are both
`false`, so a missing or unparseable lifetime value does not throw and does not
escalate — it silently drops `churn_risk`. **A dissatisfied $5,000 customer gets
handled as routine.**

This is entry 9's failure mode in the opposite direction. There, a deleted limit
made the engine *over*-permissive and approved refunds it should have denied.
Here a deleted limit makes it *under*-escalate, so the failure is invisible: no
violation, no error, one fewer row in a queue nobody is counting. Silent
under-escalation is the harder of the two to notice in production.

**Why it is still open.** Every fix is a contract change, and picking one by
default is how a headline metric ends up meaning something nobody agreed to:

- a new `EscalationReason` for unknown LTV changes the enum the eval scorers key
  off;
- throwing contradicts this engine's stated job of returning exhaustive reasons
  rather than failing;
- treating unknown LTV as a churn risk inflates escalation rate, which is a
  Mission Control KPI — the exact metric entry 5's bug inflated.

Recorded as an open defect with a named owner decision rather than closed with
whichever option was cheapest to type.

**Evidence status:** reasoned from the source and from JavaScript comparison
semantics (`NaN >= 500000` and `undefined >= 500000` both evaluate to `false`,
confirmed), **not** from an executed reproduction. This file's standard is
reproduce-before-fixing; nothing is being fixed here, and inventing a transcript
that was never produced would be the same overclaim the corrections above exist
to record.

**Lesson:** when a bug class is found in one function, the next move is to grep
for its siblings, not to fix the instance. Entry 9 named the class and shipped
with two more instances live — one in its own module's other exported function.

---

## 14. A guard that catches less than its comment claims — 2026-08-12

**Severity: low (dev papercut).**

**Caught by:** testing the claim in a comment instead of reading it — the same
move that produced entry 12.

`src/db/client.ts` says its `resolveSsl` throw "surfaces a bad `DATABASE_URL`
here rather than on the first query several layers away." It catches less than
that. Drop the scheme — one easy way to mistype a connection string — and
`new URL()` parses it happily:

```
input          : "localhost:5434/opspilot"
did NOT throw  : protocol=localhost: hostname=""
resolveSsl()   : { rejectUnauthorized: true }   <- TLS
```

`localhost:` is read as the *protocol* and the hostname is empty, so the string
is not malformed as far as `URL` is concerned. The empty hostname misses
`LOCAL_HOSTS`, TLS is demanded, and the failure lands on connect — precisely
where the comment promises it will not.

**Impact status: not a security bug.** It fails closed. An empty hostname is not
a loopback host, so the mistake produces TLS-against-nothing and a confusing
connection error, never a silent plaintext connection to a remote host. That is
the direction entry 11's TLS fix cared about, and it still holds.

**Why record it at all:** the code is fine; the *comment* overstates what the
code does, and this repository's own entry 12 argues that a confidently wrong
explanation costs more than a missing feature. A reader who trusts this comment
will not check their connection string when a query fails.

**Lesson:** `new URL()` is a parser, not a validator. It accepts any
`scheme:opaque` string, so "it parsed" means "it was URL-shaped," not "it is the
kind of URL you wanted."
