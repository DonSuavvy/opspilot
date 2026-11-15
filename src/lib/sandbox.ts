/**
 * Per-visitor sandboxes: the slug, the cookie, and the header they arrive in.
 *
 * Every visitor to the public demo gets their own copy of Beacon Analytics.
 * Nobody can spend a stranger's budget, refund a stranger's invoice, or read a
 * stranger's trace, and the seed stops decaying because it is re-planted on
 * arrival rather than aged in place since the last deploy.
 *
 * This file is pure. Randomness is injected, the clock is injected, and
 * nothing here reads `process.env`, so the identity rules can be tested
 * without a browser, a request, or Postgres. `src/proxy.ts` supplies the
 * randomness, `src/db/sandbox.ts` turns a slug into rows, and
 * `src/lib/workspace.ts` is what a page or a route handler calls.
 */

/** Where the visitor's slug lives between requests. */
export const SANDBOX_COOKIE = "opspilot_sandbox";

/**
 * How the slug reaches a page or a route handler.
 *
 * Server code reads the header, never the cookie. The proxy is the one place
 * that validates the value, so a single `headers.set` in one file decides what
 * every read below it is scoped to.
 */
export const SANDBOX_HEADER = "x-opspilot-sandbox";

/** How long a seeded sandbox lives before the cron sweep may delete it. */
export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the cookie lives, which is deliberately much longer than the rows.
 *
 * A visitor returning on day three keeps their slug and gets fresh rows under
 * it. The alternative, expiring both together, hands them a new slug and no
 * way to find the run they came back to look at.
 */
export const SANDBOX_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

/** 128 bits, which is the whole of the secret protecting one sandbox. */
const SLUG_BYTES = 16;

/**
 * Anchored, lower case, and exact.
 *
 * The slug reaches SQL as a parameter and reaches `seedIdsFor` as a hash
 * input, so its alphabet is the boundary that keeps both boring. A newline or
 * a slash sneaking through would not be an injection here, but it would make
 * log lines and ids that nobody can reason about.
 */
const SLUG_PATTERN = /^sb_[0-9a-f]{32}$/;

/**
 * Mint a slug from bytes the caller supplies.
 *
 * The randomness is an argument because this module has no business choosing a
 * source. The proxy passes `crypto.getRandomValues`, and a test passes bytes
 * it picked, which is what makes the padding rule below assertable.
 *
 * `padStart` is load-bearing. `toString(16)` renders 0x0a as "a", so a run of
 * small bytes would otherwise produce a slug shorter than 32 characters that
 * fails {@link isSandboxSlug} and locks the visitor out of their own sandbox.
 */
export function newSandboxSlug(randomBytes: Uint8Array): string {
  if (randomBytes.length < SLUG_BYTES) {
    throw new Error(
      `a sandbox slug needs 16 bytes of randomness, got ${randomBytes.length}`,
    );
  }

  const hex = Array.from(randomBytes.subarray(0, SLUG_BYTES))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `sb_${hex}`;
}

/**
 * Is this a sandbox slug?
 *
 * Takes `unknown` because every caller is handling visitor input: a cookie, a
 * header, a query parameter. The narrowing is the point, and `demo` failing it
 * is what stops the durable tenant from being swept or reset by anyone who
 * types its name into a cookie.
 */
export function isSandboxSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_PATTERN.test(v);
}

/** How much of a slug's tail survives {@link displaySlug}. */
const VISIBLE_TAIL = 4;

/**
 * A slug that can be printed, which is not the same thing as a slug.
 *
 * The slug *is* the capability. There is no password behind it: whoever sends
 * `opspilot_sandbox=<slug>` is that visitor, may approve their paused refunds
 * and may wipe their fixtures. So it belongs in a `Set-Cookie` and in a `where`
 * clause, and nowhere else — least of all in Mission Control, which is an
 * unauthenticated page that lists every sandbox that has run recently.
 *
 * Four hex characters are kept because the operator's question is "is this
 * burst one visitor or twenty", and that needs rows to be *distinguishable*,
 * not identifiable. Sixteen bits of tail collide often enough to be useless
 * for guessing the other 112 and rarely enough to tell a page of runs apart.
 *
 * Total over its argument, and non-sandbox slugs come back unchanged. `demo`
 * is the durable tenant, it is named in the README and the runbook, and
 * masking a public name would cost the badge its meaning while protecting
 * nothing. A throw here would be a 500 on an operator page.
 */
export function displaySlug(slug: string): string {
  if (!isSandboxSlug(slug)) return slug;
  return `sb_\u2026${slug.slice(-VISIBLE_TAIL)}`;
}

/** When a sandbox seeded at `now` becomes eligible for the sweep. */
export function sandboxExpiry(now: Date): Date {
  return new Date(now.getTime() + SANDBOX_TTL_MS);
}

/**
 * How long a freshly planted sandbox is left alone before it may be reset.
 *
 * Thirty seconds, which is long enough that a click and a double click land on
 * one reset and short enough that nobody demonstrating this notices. It is not
 * a security boundary: the slug is already the capability, and a visitor
 * resetting their own fixtures harms nobody. It bounds the *work*, because
 * `/api/sandbox/reset` is unauthenticated and each call deletes and re-seeds a
 * whole tenant under an advisory lock.
 */
export const SANDBOX_RESET_COOLDOWN_MS = 30_000;

export interface ResetVerdict {
  allowed: boolean;
  /** Whole seconds until a refused reset would be accepted. Zero when allowed. */
  retryAfterSeconds: number;
}

/**
 * May this sandbox be thrown away and planted again yet?
 *
 * `seededAt` is null when there is no row, which is allowed: the visitor is
 * about to get their first seed, and that is the same work their first page
 * load would have done.
 *
 * A seed instant in the future is clock skew between Postgres and the server
 * rather than an attack, and the conservative reading costs a visitor at most
 * one wait. The countdown is bounded at the cooldown either way, so a badly
 * skewed clock cannot produce a `Retry-After` measured in hours.
 *
 * The consequence worth naming: a visitor whose sandbox was planted by the
 * page load they are looking at cannot reset for thirty seconds. That is the
 * right answer rather than an edge case, because what they would be asking
 * for is a fresh copy of the fresh copy they already have.
 */
export function resetAllowed(seededAt: Date | null, now: Date): ResetVerdict {
  if (seededAt === null) return { allowed: true, retryAfterSeconds: 0 };

  const elapsedMs = Math.max(0, now.getTime() - seededAt.getTime());
  if (elapsedMs >= SANDBOX_RESET_COOLDOWN_MS) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    // Ceiling, never floor: a `Retry-After: 0` on a 429 invites the retry it
    // just refused.
    retryAfterSeconds: Math.ceil(
      (SANDBOX_RESET_COOLDOWN_MS - elapsedMs) / 1000,
    ),
  };
}

export interface ResolveSandboxInput {
  /** The cookie value as it arrived, if it arrived at all. */
  cookie: string | undefined;
  /** 16 or more random bytes, called only when a slug has to be minted. */
  random: () => Uint8Array;
}

export interface ResolvedSandbox {
  slug: string;
  /** True when this request minted the slug, so the caller must set a cookie. */
  fresh: boolean;
}

/**
 * Decide which sandbox this request belongs to.
 *
 * `fresh` says the cookie has to be written, and it says nothing about whether
 * rows exist. Those two diverge on purpose: a visitor returning after 30 hours
 * has a valid cookie, `fresh: false`, and an expired workspace that
 * `ensureSandbox` re-seeds. Only the proxy cares about `fresh`; only the
 * database layer cares about seeding.
 */
export function resolveSandbox({
  cookie,
  random,
}: ResolveSandboxInput): ResolvedSandbox {
  if (isSandboxSlug(cookie)) return { slug: cookie, fresh: false };
  return { slug: newSandboxSlug(random()), fresh: true };
}
