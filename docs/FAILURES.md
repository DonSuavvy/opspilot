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

Two things this file does **not** claim. **Entry 14 is open** — a live defect,
left that way because it is a comment overstating what its code does rather than
anything that changes a decision. Entry 13 was held open for the same discipline
and is now closed: every available fix was a contract change, so it waited for an
owner's decision instead of taking whichever option was cheapest to type. And
entries 9 and 10 carry dated corrections: a later pass found that both had
described their own fixes inaccurately. Those corrections are marked in place
rather than edited away, because a defect log that quietly rewrites itself is
worth about as much as a green suite that never had a failing test.

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

The exact prompt is checked in at [`REVIEW-PROMPT.md`](REVIEW-PROMPT.md), along
with why each instruction is in it. This file records what the reviews found;
that one records how to run them again.

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

**Severity: medium (latent). Status: FIXED — after an owner decision.**

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

**Why it was held open first.** Every fix is a contract change, and picking one
by default is how a headline metric ends up meaning something nobody agreed to:

- a new `EscalationReason` for unknown LTV changes the enum the eval scorers key
  off;
- throwing contradicts this engine's stated job of returning exhaustive reasons
  rather than failing;
- treating unknown LTV as a churn risk inflates escalation rate, which is a
  Mission Control KPI — the exact metric entry 5's bug inflated.

It was recorded as an open defect with a named owner decision rather than closed
with whichever option was cheapest to type. The owner chose the first.

**Fix:** a new `unknown_customer_value` reason. An unreadable lifetime value now
escalates with a stated cause instead of vanishing, and never claims a churn risk
that was not established — so the churn-risk rate stays a meaningful number. The
rule is scoped to `dissatisfied`, because a satisfied customer is not a churn
risk at any lifetime value: there an unknown LTV decides nothing, and escalating
on it would inflate the very KPI the third option was rejected for.

Reproduced before the fix and re-run after, threshold `churnRiskLtvCents` =
250000:

```
                                        BEFORE                          AFTER
dissatisfied, ltv $5,000    escalate=true  [churn_risk]         (unchanged)
ltv = NaN, dissatisfied     escalate=false []                   escalate=true  [unknown_customer_value]
ltv = undefined             escalate=false []                   escalate=true  [unknown_customer_value]
ltv = NaN, refund denied    escalate=true  [refund_denied…]     escalate=true  [refund_denied…,unknown_customer_value]
ltv = NaN but satisfied     escalate=false []                   (unchanged — must not inflate the rate)
```

Test-first: the two tests asserting the new behaviour failed before it existed,
and disabling the guard afterwards fails exactly those two. The two guard tests
against over-firing passed from the start, which is correct — they pin a
behaviour that must survive the change rather than one being added.

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

---

## 15. A perfectly valid policy that authorised $999,999.99 — 2026-08-13

**Severity: critical.** Reachable from the SOP editor, by an operator doing
nothing wrong.

**Caught by:** the Round 4 review pass.

Entry 9 fixed this engine failing open on a *malformed* policy. This is the same
column of the same table, one cell over: a policy that is entirely well-formed.

The only bound on the refund limits was relative — `maxAutoApproveCents <=
maxRefundCents`. Set both to `99_999_999` and it is satisfied, every required
key is present, every type is right, nothing is misspelled, no extra keys, no
NaN. Every test entry 9 added still passes. `evaluateRefund` then approves
$999,999.99 with `violations: []`.

**A consistency check is not a bound.** `a <= b` says the two numbers agree with
each other, not that either one is sane, and it holds at any magnitude.

The second half was worse, because it needed no unusual number at all:

```
escalation: { escalateOnSuspectedInjection: false, ... }
```

`escalateOnSuspectedInjection` was an ordinary `z.boolean()`. So "escalate when
the ticket looks like a prompt injection" was a preference, switchable from a
text field with no code change, no review, and no failing test. Combined with
the other two toggles, a ticket with injection flagged, an unknown customer, and
a refund denied by policy returned:

```
{ escalate: false, reasons: [] }
```

Three independent reasons to involve a human, and the engine reported none of
them.

**Fix.** Three absolute ceilings, derived from the data rather than picked: the
largest invoice Beacon Analytics issues is one Scale month, **$299**
(`max(amount_cents)` = 29900 across all 54 rows), so the $5,000 hard ceiling is
~17× the largest legitimate refund and constrains no real case — while sitting
strictly below the **$10,000** the adversarial ticket demands. Demo arc step 4
must not be defeatable by editing a number.

`escalateOnSuspectedInjection` becomes `z.literal(true)` — pinned, not deleted,
because the key is already persisted in every stored `policy_config` and the
object is `.strict()`, so removing it would make every existing row unparseable
and take the engine down on read.

One existing test asserted the exact capability being removed. It was
**inverted, not deleted or worked around** — a test that encodes a behaviour you
have decided is wrong is evidence about the old design, and quietly dropping it
loses the record that it was ever believed.

**Lesson:** hardening against malformed input and hardening against *harmful*
input are different jobs. The second one is the one an attacker — or a tired
operator — actually reaches.

---

## 16. Importing the seed ran the seed — 2026-08-13

**Caught by:** running a failing test. Not by any of four review passes.

Round 4 flagged that seed ids had no workspace component. Writing the RED test
for that — a pure test, of a pure function — produced this:

```
stdout | src/db/seed.test.ts
◇ injected env (4) from .env.local
Seeding Beacon Analytics...
```

`seed()` was invoked at module scope, so `import { … } from "./seed"` *executed*
it. A unit test run read `.env.local` and started writing to Postgres.

CLAUDE.md states the rule this breaks: **`npm test` must never require a
database.** It had been true only because no test had ever imported that module.
On any CI machine with `DATABASE_URL` set, the first test that did would have
silently rewritten a database mid-suite.

**What made it invisible:** nothing was wrong with the file in isolation. It ran
correctly as a script, which is all anyone had ever asked it to do. The defect
existed only in a use case that had not happened yet — which is exactly the kind
a review reading for correctness will not find, because the code is correct for
what it currently does.

**Fix:** `src/db/seed.ts` is a library exporting `seedWorkspace(db, {slug,
expiresAt, now})`; everything with a side effect — dotenv, the pool, printing,
the exit code — moved to `scripts/seed.ts`, matching the existing
`scripts/verify-*.ts` convention.

The underlying finding was real too, and confirmed against the live database
before being fixed:

```
derived seedId("workspace:demo") = 03153a0e-1643-442f-b9c4-7186c15ffea3
select id from workspaces        = 03153a0e-1643-442f-b9c4-7186c15ffea3
```

Every workspace derived identical primary keys, so the second sandbox to be
seeded would die on `customers_pkey` — blocking Day 8's per-visitor sandboxes,
which are themselves the permanent fix for the seed's ~8-day shelf life.

The slug is **length-prefixed** into the digest rather than concatenated:
`slug + key` maps `("ab", "c")` and `("a", "bc")` to one hash, and a delimiter
only moves the problem to slugs that contain it. Both wrong fixes are pinned by
mutation tests, because both are what a reasonable person writes first.

**Lesson:** "it works when you run it" and "it is safe to import" are different
properties. A module that does work at import time has an API surface nobody
declared.

---

## 17. The obvious constraint would not have caught the thing it was for — 2026-08-13

**Caught by:** Round 4, and then by refusing to write the constraint from
memory.

No `CHECK` existed on any of the four `cost_usd` columns. The natural one to add
is `CHECK (cost_usd >= 0)`. It does not work:

```
'NaN'::numeric >= 0               -> true
CHECK (c >= 0)                    -> INSERT 'NaN' SUCCEEDS
CHECK (c >= 0 AND c <= 1000000)   -> INSERT 'NaN' rejected
```

Postgres `numeric` accepts the literal `'NaN'` and orders it **above** every
other numeric value. The lower bound admits it; the **upper** bound is the half
that does the work. (The probe above used `1000000`; the shipped ceiling is
tighter at `10000`. Any finite bound excludes NaN — $10,000 is already absurd
beside a ~$0.06 Haiku run, and this is a data-integrity guard, not a budget
control.)

One NaN turns every `SUM` over the column into NaN — so *cost per resolved
ticket*, the managed-services KPI Mission Control is built around, would display
nothing rather than something visibly wrong. The silent direction again.

**Then the fix itself was wrong, and the tests could not tell.** The first
generated migration read:

```sql
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_cost_usd_sane"
  CHECK ("agent_runs"."cost_usd" >= 0 AND "agent_runs"."cost_usd" <= $1);
```

A plain `${MAX_COST_USD}` inside drizzle's `sql` template becomes a **bind
parameter**, and drizzle-kit wrote it into the migration verbatim. `$1` is
invalid in DDL; it would have failed the moment anyone applied it. `npm run
typecheck`, `npm run lint` and all 191 tests were green with that file on disk.
It was caught by reading the generated SQL — the artifact, not the source.

**Fix:** `sql.raw`, and the migration validated in a rolled-back transaction
against the real database, proving both directions:

```
INSERT cost_usd='NaN'    -> ERROR: violates check constraint "agent_runs_cost_usd_sane"
INSERT cost_usd='0.0612' -> PASS: a real cost of 0.061200 is accepted
```

Generated and validated; **not applied**, consistent with migrations 0001 and
0002.

**Lesson:** two of them. A type's comparison semantics are part of its
behaviour — `>= 0` means something different for `numeric` than for `integer`.
And a code generator's *output* is the deliverable; a green suite says nothing
about a file no test reads.

---

## 18. A prototype chain in the safety net — 2026-08-13

**Caught by:** Round 4.

Entry 1 added `assertConsistent`, whose claim was that "one assertion catches
this whole bug class". It asked:

```ts
(name) => !(name in properties)
```

`in` walks the prototype chain. `"toString" in {}` is `true`. So a schema whose
`required` names `toString`, `constructor`, `valueOf`, `hasOwnProperty` or
`__proto__` — with no such property — passed the check whose entire purpose is
catching exactly that.

**The same family as entry 1, one level up.** There, a field named `pattern` was
destroyed because a *keyword* blocklist was applied to *author identifiers*.
Here, an orphaned field was missed because a JavaScript operator that knows
about inherited members was applied to author identifiers. Both times the bug is
treating a name chosen by a tool author as though it meant something to the
language.

`Object.hasOwn` is the operator that means what the check meant. The same idiom
was also present in a *test* asserting no required entry is orphaned — a test
carrying the bug it checks for — and was corrected too.

**Lesson:** entry 1's lesson was "a transform that can produce something
unusable should report, not return." Its own safety net then shipped with a
member of the same bug family. Writing the fix does not immunise you against the
category; the category is a habit of thought, and it recurs.

## 19. 3.2KB of schema compiled to a 330MB grammar — 2026-08-13

**Caught by:** the Day 2 end-to-end gate, on its first live run. Nothing else
could have caught it.

The nine-tool registry has been strict-legal since Day 1, and 49 registry tests
say so: closed objects at every depth, explicit `required`, every keyword
Anthropic's `strict: true` rejects stripped before the schema goes on the wire.
All of that is correct and none of it changed. The first real call still failed:

```
400 Compiled grammar size (329.9MB) exceeds maximum allowed size (300MB).
Simplify your JSON schema to reduce grammar complexity.
```

The error's own advice is a dead end. The whole tool block is **3,241 bytes**,
and the largest single schema is 658. Here is `get_customer` in full:

```json
{ "type": "object",
  "properties": { "query": { "type": "string", "description": "…" } },
  "required": ["query"],
  "additionalProperties": false }
```

There is no complexity in that to simplify. So the cost is not in the schema; it
is in the grammar compiled *from* the schema, and the interesting question is
what makes it grow.

**Probed rather than reasoned about** (`scripts/probe-grammar.ts`; each
rejection takes ~68s, because the compiler grinds before giving up):

```
each tool alone           -> all nine compile
cumulative 1..8 tools     -> compiles
cumulative 9 tools        -> FAIL 329.9MB
all nine, strict removed  -> compiles
```

Then, to separate "nine tools" from "one bad tool", two different eight-tool
subsets: dropping `search_kb` **still fails at exactly 329.9MB**, dropping
`draft_reply` passes. So it accumulates across the set, the free-text tools
dominate, and no individual schema is at fault. Note the margin — 329.9 against
300 is 10% over. This was always going to happen at some tool count; nine is
just where it landed.

**Why dropping a tool is the wrong fix.** It works today and breaks again at the
tenth, and PLAN.md's nine are all load-bearing — the safety-class demo needs
both confirm-write tools, and the eval suite keys off `resolve_ticket`.

**The fix is to stop asking for constrained decoding.** `strict` moved from a
property of the schema to a decision of the caller: `toAnthropicTools()` still
defaults to requesting it, `toAnthropicTools({ strict: false })` omits it, and
the emitted schema is byte-identical either way — asserted, because the
registry's guarantee is that the schema *is* strict-legal, not that anyone asks
for it. The agent loop defaults to off, since the only provider this project
runs on cannot do it.

**Nothing was weakened, and that is not a consolation — it is the design.**
CLAUDE.md's rule has always been "the wire schema constrains the *model*; Zod
constrains the *code*." `runAgentLoop` parses every tool call with the tool's
own Zod schema before the handler sees it and returns an `is_error` result on
failure, which is separately tested. Strict was the belt. Zod is the braces, and
it was always the load-bearing one — which is why losing strict cost nothing but
a config flag.

**Lesson:** a boot-time validator can only check the contract it was told about.
Ours proved the schemas were strict-*legal* and was right; nobody had thought to
ask whether they were strict-*affordable*, because that property does not exist
until a real provider compiles them. Two consequences worth keeping. Gates that
run the real thing find a category of defect that no amount of unit testing
reaches — this one survived four review rounds and 320 green tests. And when a
provider's error message tells you to simplify something that is already
minimal, disbelieve the message and go measure: the advice was aimed at a cause
that was not ours.

## 20. The metric was arithmetically valid and semantically false — 2026-08-15

**Caught by:** clicking the button. Not by 365 green tests, one of which was
written specifically to prevent this class of error.

Day 4 added a prompt-cache badge to the run console. The whole point of the
feature is honesty: prompt caching fails *silently* — miss the model's minimum
prefix and the request still succeeds, reports `cache_creation_input_tokens: 0`,
and a hit-rate metric reads zero forever, indistinguishable from a caching bug.
Demo mode runs Haiku 4.5, whose floor is 4096 tokens against 512 on Opus 5, so
the SOP prefix was the single most likely thing to sit under it.

So `describeCache` was built to report what *happened* rather than predict what
should have. That part worked, and the reasoning behind it still holds: the
three token classes are disjoint — the API does not double-count a cached token
as input — so when nothing caches, `input_tokens` **is** the whole prompt, and
comparing it to the floor is a measurement rather than a `count_tokens` guess.

Then the first live run rendered this:

```
cache miss — prefix was eligible but not cached
  0  model   1755ms  2618/140 tok
  3  model   2234ms  2946/232 tok
```

Both statements in that badge are wrong, and the numbers to disprove them are on
the next line. Neither prompt was ever eligible — 2618 and 2946 are both under
Haiku's 4096. But the console passed `describeCache` the run's **summed** usage,
and 2618 + 2946 = 5564 clears the floor. The badge described a prompt that never
existed, concluded the prefix was eligible, and blamed a cause that was not
there — in the confident register of a measurement, which is worse than a blank.

The defect is one line of category error:

> **Token counts sum across calls. Eligibility does not.**

Eligibility is a property of each individual prefix. Summing first produces a
number that is arithmetically impeccable and refers to nothing. The fix,
`describeRunCache`, combines *verdicts* rather than tokens — precedence
`hit > write > below_threshold > miss` — and when nothing cached it reports the
**largest** prompt, because that is the one closest to clearing the floor and so
names the smallest true shortfall. After the fix, the same run reads:

```
below cache threshold — prompt is 2,946 tokens, haiku needs 4,096
```

**Why the tests missed it.** Every one of the eight `describeCache` tests feeds
a single call, so every one of them passes under either implementation. The
aggregation was introduced at the call site, in a React component, where no test
was looking. The suite was not weak; it was aimed one layer below the mistake.

Two things worth keeping. First: a metric that is *plausible* is more dangerous
than one that is obviously broken, because nobody re-derives a number that looks
reasonable — this badge would have been screenshotted into a demo. Second: this
is the second defect this month that only running the real thing caught, after
the strict-grammar cap in #19. Both were invisible to a green suite, and both
took under a minute to find once something actually executed.

There is a smaller lesson underneath. The honest-display decision — report the
shortfall rather than pad the constitution past 4096 — is what made the bug
*visible at all*. A padded prompt would have cleared the floor, the badge would
have said "cache hit", and nobody would have looked at it again.

## 21. The SOP said fourteen days; the model asked for a refund at twenty-two — 2026-08-15

**Caught by:** the Day 4 gate, on the first end-to-end run through the new
editor. Not a code defect — the code did exactly what it was built to do.

Day 4's whole claim is that the SOP *is* the prompt: edit the refund window and
the agent is told the new rule. That half works, and is verified. What the gate
was supposed to show next is the decision changing. It didn't.

The run, in full:

```
edit window 30 -> 14 in /sop, saved as v2
re-run "Refund request for INV-2002"
  -> model -> get_customer + get_invoices -> model -> issue_refund
  -> paused for approval
```

Confirmed against the database rather than assumed, because "the model ignored
the policy" and "the wiring handed it the old policy" look identical from the
outside:

```
run.sop_version_id -> version 2, policy_config.refund.windowDays = 14
INV-2002           -> paid 22.2 days ago, $49.00
issue_refund input -> {"invoice_id": "INV-2002", "amount_cents": 4900,
                       "reason": "service_issue"}
```

So the model read a document saying the window is **14 days**, read an invoice
paid **22.2 days** ago, and requested the full refund anyway. The SOP's own
escalation section — *"Policy denies what the customer asked for"* — is right
there in the same prompt.

**This is the project's central thesis arriving as evidence rather than
assertion.** `CLAUDE.md` has said since Day 1 that refund limits are enforced
twice, "in the SOP so the model knows them, and in the `issue_refund` handler so
the code guarantees them", under the heading *Never trust the model*. That has
been an architectural belief with no live counterexample behind it. Now there is
one, from the project's own demo fixture, on the first honest attempt.

It also relocates demo arc step 2. The arc is *"edit the SOP → the decision
changes"*, and the decision does not change on prompting alone — not reliably,
and not in this instance. What makes it change is the handler rejecting an
out-of-policy call with `is_error: true` and the agent adapting. **Day 4 delivers
the input to that mechanism; Day 5 delivers the mechanism.** Claiming the arc
worked at the end of Day 4 would have been a demo that passes because the model
happened to agree, which is precisely the class of demo this project exists not
to build.

Worth stating plainly: this is one observation, not a controlled experiment. A
different sample might comply. That is the point — a guarantee you can only
confirm by sampling is not a guarantee, and the eval suite in Day 6 exists to
measure the rate rather than trust the anecdote in either direction.

**Kept:** when a gate fails, first prove *which* layer failed. Ten minutes of
SQL separated "the model disobeyed" from "I wired the wrong version", and those
two have nothing in common except how they look in a screenshot.

## 22. I built the guard and the guard never runs — 2026-08-15

**Caught by:** the live gate, again. The unit tests were green and said nothing
about this.

Day 5's first piece was the `issue_refund` revalidation that FAILURES #21 asked
for: check the requested refund against the run's pinned `policy_config`, throw
`OutOfPolicyRefundError` when policy denies it. Nine deterministic tests, all
passing, including the exact case from #21 — 22-day-old invoice, 14-day window,
rejected.

Re-ran the real ticket. Still `paused for approval`, no rejection.

The span says why, and says it in one field:

```
type: approval_wait   name: issue_refund   is_error: f
```

`approval_wait`, not `tool_exec`. `issue_refund` is **confirm-write**, and the
loop's contract is that a confirm-write call pauses the run *before* dispatching
the handler — that pause is the approval queue, and the Vercel-timeout answer,
and the pause/resume story the whole hand-rolled loop exists for. So the
handler body I had just written and tested was, on the live path, unreachable.
The 0ms duration on the span was visible in the screenshot before I went looking.

**I had even argued the opposite in the commit message**, claiming the handler is
"reachable and testable without the approval queue, because rejecting an
out-of-policy call has to happen before anything is queued for a human". The
second half of that sentence is a correct statement about how it *should* work.
The first half asserted it already did. Nothing checked which.

**The design question it surfaces is the useful part.** Where should policy
revalidation sit relative to the pause? Putting it after — inside the handler,
on resume — means an out-of-policy refund gets queued, a human is asked to
approve something the code will refuse anyway, and the rejection arrives after
someone has already said yes. That is a worse product than either failure mode
it was meant to prevent. The check belongs **before** the pause: policy denies
it, the agent is told with `is_error: true`, and no human is ever interrupted
for a decision that was never available.

So the guard is right and its position is wrong, and #21 stays open.

**Kept, and it is the same lesson as #20 and #21 from a third angle:** green
unit tests prove a function's behavior, never its reachability. All three of
this month's real defects were invisible to the suite and obvious within a
minute of running the thing — a metric that referred to nothing, a model that
ignored its instructions, and now a guard nothing calls. The suite is not weak.
It answers "is this correct", and the question that keeps biting is "is this
wired".

---

## Closing #21 and #22 — 2026-08-15, same day

Both closed by the same commit, and verified by the run that failed twice before.

Edit the window to 14 in the editor, re-run INV-2002 (paid 22 days ago):

```
0  model
1  get_customer
2  get_invoices
3  model
4  issue_refund     ✗ guardrail, is_error: true
5  model
6  escalate         ✓
7  model
8  resolve_ticket   ✓
completed · 4 iterations
```

The span, from the database rather than the screenshot:

```
guardrail | issue_refund | is_error: t
  "refund denied by policy: outside_refund_window. Invoice INV-2002 was paid
   22 days ago, the refund window is 14 days…"
run: completed · sop_version 2 · windowDays 14
```

And what the customer would have received, written by the agent after the
refusal:

> "I've reviewed your refund request for INV-2002 ($49.00). The invoice is
> outside our standard 14-day refund window (paid 22 days ago), so I'm handing
> this to our management team for consideration."

The model still asked for the refund — #21's finding is unchanged and was never
going to be fixed by prompting. What changed is that the code refused it, the
model was told why, and it escalated with an accurate explanation of a rule it
had declined to follow on its own. That last step is the part worth watching:
denial-adaptation, which PLAN.md lists as a demo moment, arrived as a
side-effect of getting the ordering right rather than as a feature.

"Refund limits are enforced twice" is now true rather than aspirational, and
demo arc step 2 works end to end.

The three defects this month — a metric that referred to nothing, a model that
ignored its instructions, a guard nothing called — cost about an hour between
them and none were reachable from the test suite. Every one surfaced within a
minute of running the product. The suite answers "is this correct". Running it
answers "is this wired", and that has been the more expensive question.

---

## 23. The pause did work, then threw the work away — 2026-08-15

**Caught by:** reading the loop in order to build `/api/agent/resume`. Not by
the 397 tests that were green at the time, and not by running the product —
the model happens to call reads and refunds in separate turns, so the demo
arc never triggered it.

A confirm-write pause returned the moment the loop reached the call needing
approval. But the loop dispatches a turn's tool calls in order, and a turn can
carry more than one. Given `[get_customer, issue_refund]`, `get_customer` ran:
its handler fired, its `tool_exec` span was written to the database. Then
`issue_refund` paused and returned — discarding the local `results` array
`get_customer` had just written into.

Two things were then true at once. The trace showed a tool that ran, and the
serialized conversation had no record of it. And the serialized array ended
with an assistant turn holding two `tool_use` blocks, one of which could never
receive a `tool_result` — a shape the Anthropic API rejects outright. Resume
would have failed on its first call, on a conversation that looked complete.

The test that found it is three lines:

```
expect(spans.filter((s) => s.type === "tool_exec")).toHaveLength(0);
```

Observed: 1.

**The fix is positional, again.** `firstCallAwaitingApproval` now walks the
turn *before* anything is dispatched; a confirm-write that clears its own
schema and its preflight pauses with zero side effects. Validation and
preflight still run before the pause — FAILURES #22 is unchanged — and both
are pure, so the dispatch loop re-runs them and every span is still emitted
from one place.

**Kept because of what it says about the fix to #22.** That fix moved the
policy check above the pause and was right. This is the same insight applied
one level up: *the pause is a commitment to interrupt a person, so nothing
should have happened yet when it fires* — not an unvalidated argument, and not
a side effect either. #22 got the check into the right place; #23 is the rest
of that sentence.

**And a counterpoint worth recording.** The last three defects all argued for
live gates over suites. This one was invisible to *both* — green tests and a
working demo — and only fell out of reading the code with a specific question
in hand: what exactly does resume receive? Running the product answers "is this
wired". It does not answer "is this wired for the case the model has not
happened to produce yet."

---

## 24. The refund was approved, and no money moved — 2026-08-15

**Caught by:** the live gate, one query after it appeared to pass.

The pause/resume round-trip worked end to end on the first real run: paused at
span 4, approved through `/api/agent/resume`, `issue_refund` dispatched at span
5, run completed with a structured outcome. The agent then wrote to the
customer:

> "We've approved a refund of $49.00 against INV-2001. You should see it back
> in your account within 3–5 business days."

```
select number, refunded_cents from invoices where number='INV-2001';
 INV-2001 |              0
```

`refunded_cents` is zero. Nothing happened.

**Correction, and the reason to run the query instead of reading the code.**
The first draft of this entry said "there is no `audit_log` row", inferred from
having found no writer. The query says otherwise, and says something worse:

```
select action, run_id is null, count(*) from audit_log group by 1,2;
 draft_reply    | t | 4
 escalate       | t | 4
 resolve_ticket | t | 7
```

The audit log is not unbuilt — it has been recording side effects all along.
Two holes, both invisible until asked directly:

1. **`issue_refund` writes nothing.** Every *auto-write* tool records itself;
   the one confirm-write that moves money does not. The audit trail is
   complete except where it matters.
2. **Every row has `run_id = NULL`** — 15 for 15. `createOpsData(db,
   workspaceId)` closes over the workspace and never receives the run, so no
   write *can* populate it. The log records that something happened and never
   which run did it, which is most of what an audit log is for.

This is the same mistake as this morning's, one level up: `approvals` was
asserted to have no writer and a grep settled it; `audit_log` was asserted to
have no row and only a query settled it. Reading code tells you what is
written. Querying tells you what is there.

`issue_refund`'s handler validates the refund against the pinned policy and
returns `{ status: "pending_approval", ... }`. Its comment explains why:

> Both `approve` and `requires_approval` land here. Confirm-write means the
> loop pauses before any money moves either way, so the handler's job ends at
> "this is allowed" — the approval queue owns what happens next.

That was accurate when it was written. Confirm-write paused *before* dispatch,
so the handler was unreachable — it was FAILURES #22's whole subject. The
deferral pointed at an approval queue that did not exist yet.

Building resume made the handler reachable and changed what it means. It now
runs **only** on the approved path: `firstCallAwaitingApproval` pauses unless a
decision exists, so if the handler executes, a human said yes. The sentence
"the approval queue owns what happens next" no longer defers to anything —
resume *is* the approval queue, and it calls the handler and takes its word.

**Partly fixed.** The status string was a lie the model reads, so it is gone:
the handler now returns `status: "authorized", recorded: false`. That is the
uncomfortable-number call from #20 again — a status claiming the money moved
would demo better and would be a falsehood the model repeats to a customer.

**The refund itself is deliberately not fixed here.** Recording it needs an
`OpsData` method that does not exist, and `run_id` on the audit rows needs
`createOpsData` to receive the run — both belong to Day 5's audit-log item.
Bundling a money-moving change into a control-flow commit would hide it.

**The lesson is about comments, not refunds.** The comment was true, and
became false without being edited, because the code it described did not
change — its *reachability* did. A stub that is unreachable and a stub that is
live look identical in a diff. What made it visible was checking the database
instead of the response: the round-trip reported success, the trace showed a
green `tool_exec`, and the customer reply was fluent and specific. Every
observable said it worked except the one that was load-bearing.

---

## Closing #24 — 2026-09-08

Four things were missing, and none of them was hard. `applyRefund` in
`src/policy/refund.ts` does the arithmetic — running total in, running total
out, `refunded` only when the total reaches the invoice amount, and a throw
rather than a clamp on an over-refund. `OpsData.recordRefund` is the seam
method that did not exist: one transaction that locks the invoice `for
update`, writes `refunded_cents` and `status`, and inserts the `issue_refund`
audit row beside them. `createOpsData` now takes `{ workspaceId, runId }`
instead of a bare workspace, so every audit row the seam writes names the run —
bound once, closed over, the same way the workspace is, because a run passed
per call is a run some future write forgets. And `issue_refund`'s handler
calls the seam instead of ending at "this is allowed."

The idempotency key is stored in the audit row's `after` payload and looked up
there, rather than in a table of its own: the audit row already is the record
that the refund happened, and a second store would be a second source of truth
about the same fact.

The live gate. Same shape as the run in #24 — the duplicate-charge ticket,
paused at span 4 on `issue_refund`, approved through `/api/agent/resume`,
dispatched at span 5:

```
tool_exec | issue_refund | INV-2005 | 4900 | duplicate_charge
  {"status":"refunded","recorded":true,"duplicate":false,
   "refunded_cents_total":4900,"invoice_status":"refunded"}
completed · refunded · 4900
```

And the query that closed it, the one #24 was found by:

```
  number  | amount_cents | refunded_cents |  status
----------+--------------+----------------+----------
 INV-2005 |         4900 |           4900 | refunded

     action     | has_run |              entity_id
----------------+---------+--------------------------------------
 issue_refund   | t       | INV-2005
 draft_reply    | t       | 40c38bd2-5e51-4178-a742-6e7faad85171
 resolve_ticket | t       | 40c38bd2-5e51-4178-a742-6e7faad85171
```

Three rows, all naming the run, and one of them for the money. Against the
same query in #24: `refunded_cents` 0, no `issue_refund` row at all, and
`run_id` null 15 times out of 15.

One bound worth stating rather than leaving implied. The idempotency key makes
a **retried** resume safe — the same key returns the first call's totals with
`duplicate: true` and writes nothing. It does not make a **concurrent** one
safe: two simultaneous resumes both find no prior row and both write. What
stops that is the `status = 'pending'` predicate on the approval decision,
which `verify-resume` proves by racing two approvals. The key is the belt to
that pair of braces. Calling the refund flatly "idempotent" would be the same
species of overclaim this file exists to record. And because the key is
written by the model rather than by us, the lookup is scoped to the invoice as
well: nothing stops a model reusing one string across two invoices, and a
match on the key alone would swallow the second refund and report the first
invoice's totals for it.

The `for update` on the invoice belongs in the same paragraph, for the same
reason. It is there so two refunds against one invoice cannot both read the
same `refunded_cents` and both write their own total, and that is a property of
the SQL rather than a hope — but nothing exercises it. Removing the clause
left all 23 gate checks and all 419 tests green when it was measured (the script has grown since), because every one of them
takes the sequential path. Reasoned, not measured, and written down as such.

**The lesson is that nothing was broken.** The column existed and had a default.
The handler was reachable and ran. The audit log had been recording side
effects for weeks. `evaluateRefund` was correct, the approval queue worked, the
trace was green and the customer reply was accurate prose about a refund that
had not happened. Every part was present and no line of code joined them, which
is the failure mode that survives review longest, because a reviewer checks
whether each piece is right and a missing edge is not a piece. The suite could
not see it — every seam was faked and every fake behaved. What saw it was one
`select` against the row the feature is supposed to change. That is now check 2
of `npm run verify:refund`, so the next time it will be a red line rather than
a hunch.
