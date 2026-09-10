/**
 * Is a model provider configured well enough for the eval gate to start?
 *
 * Lives here rather than in `scripts/ci-evals.ts` so it can be tested. The
 * script around it writes bytes and sets an exit code, which is exactly the
 * set of things a test cannot check; this is the one decision in it that a
 * test can, and it is the decision a fork PR meets first.
 *
 * Checked ahead of `providerFromEnv` rather than caught from its throw so the
 * reader of a red CI job gets one sentence saying where the secrets come from.
 * No value is echoed: this text lands in a public log.
 *
 * A partly configured Bedrock block no longer falls through to
 * `providerFromEnv` — it is refused here, by a message that names both ways
 * in. That trades a slightly more specific error for one that is correct: the
 * old fall-through only happened when the check accidentally passed on one
 * variable, which is the bug rather than the feature.
 */

/**
 * The three Bedrock variables, which are only useful as a set.
 *
 * Any one of them alone used to satisfy this check, and the region is the one
 * of the three that is not a secret — so it is the one most likely to be set
 * without the other two, and the one that produced a gate that passed and an
 * SDK that then failed.
 */
const BEDROCK = [
  "AWS_ANTHROPIC_ACCESS_KEY_ID",
  "AWS_ANTHROPIC_SECRET_ACCESS_KEY",
  "AWS_ANTHROPIC_REGION",
] as const;

/** The first-party fallback, which needs nothing else beside it. */
const ANTHROPIC = "ANTHROPIC_API_KEY";

/**
 * Both ways in, named, because a red job is read by someone who does not know
 * which one this repository uses.
 */
export const MISSING_PROVIDER =
  `Evals need a provider: either all of ${BEDROCK.join(", ")} ` +
  `for Bedrock, or ${ANTHROPIC} for the first-party API. ` +
  `See docs/RUNBOOK.md.`;

/** Set, and not just whitespace. A quoted empty secret is an absent secret. */
function present(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

/** `Record`, not `NodeJS.ProcessEnv`, matching `providerFromEnv` next door. */
export function hasProviderEnv(env: Record<string, string | undefined>): boolean {
  if (BEDROCK.every((name) => present(env[name]))) return true;
  return present(env[ANTHROPIC]);
}
