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
 */

export const MISSING_PROVIDER =
  "Evals need AWS_ANTHROPIC_* secrets; see docs/RUNBOOK.md";

export function hasProviderEnv(env: NodeJS.ProcessEnv): boolean {
  const bedrock =
    (env.AWS_ANTHROPIC_ACCESS_KEY_ID ?? "").length > 0 ||
    (env.AWS_ANTHROPIC_SECRET_ACCESS_KEY ?? "").length > 0 ||
    (env.AWS_ANTHROPIC_REGION ?? "").length > 0;
  return bedrock || (env.ANTHROPIC_API_KEY ?? "").length > 0;
}
