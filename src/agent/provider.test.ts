import { describe, expect, it } from "vitest";

import {
  BEDROCK_RATES,
  bedrockProvider,
  anthropicProvider,
  providerFromEnv,
  type LogicalModel,
} from "./provider";
import { ANTHROPIC_RATES } from "./cost";

/**
 * OpsPilot runs Claude through **two** providers: Amazon Bedrock (the covara
 * account) and the first-party Anthropic API. This adapter is the only place
 * that knows which — nothing downstream should branch on provider.
 *
 * PLAN.md already listed a provider adapter as a stretch ("a provider adapter
 * interface with a GPT entry"); this pulls it forward, because running on
 * Bedrock is the reason it exists today rather than a later nicety.
 *
 * Two things it owns, and they are the two that differ per provider:
 *
 * 1. **Model identity.** Bedrock takes `global.anthropic.claude-haiku-4-5` —
 *    a cross-region inference profile, which is why it resolves in
 *    ap-southeast-1 at all. The first-party API takes the bare
 *    `claude-haiku-4-5`. Same model, two names.
 * 2. **The rate card, with provenance.** Bedrock is partner-operated and
 *    priced separately, and its current Claude rates could not be verified —
 *    the AWS pricing page surfaced only a retired model, at 2x the
 *    first-party rate. So the Bedrock card is marked UNVERIFIED and everything
 *    priced with it is flagged as an estimate rather than reported as fact.
 *    Cost per resolved ticket is the headline KPI; a confidently wrong number
 *    is worse than an openly approximate one.
 */
const MODELS: LogicalModel[] = ["haiku", "sonnet", "opus"];

describe("model identity is per-provider", () => {
  it.each([
    ["haiku", "global.anthropic.claude-haiku-4-5"],
    ["sonnet", "global.anthropic.claude-sonnet-5"],
    ["opus", "global.anthropic.claude-opus-5"],
  ] as const)("bedrock maps %s to its inference profile", (model, id) => {
    expect(bedrockProvider.modelId(model)).toBe(id);
  });

  it.each([
    ["haiku", "claude-haiku-4-5"],
    ["sonnet", "claude-sonnet-5"],
    ["opus", "claude-opus-5"],
  ] as const)("anthropic maps %s to the bare model id", (model, id) => {
    expect(anthropicProvider.modelId(model)).toBe(id);
  });

  /**
   * The `global.` prefix is not decoration — it selects a cross-region
   * inference profile, and it is why these models resolve from
   * ap-southeast-1, where the regional Bedrock catalogue does not list them.
   * Dropping it is a plausible "tidy-up" that would break the account this
   * project actually runs on.
   */
  it("keeps the global. prefix on every bedrock id", () => {
    for (const m of MODELS) {
      expect(bedrockProvider.modelId(m)).toMatch(/^global\.anthropic\./);
    }
  });

  it("refuses a model it has no mapping for", () => {
    expect(() => bedrockProvider.modelId("gpt-4" as LogicalModel)).toThrow(
      /gpt-4/,
    );
  });
});

describe("rate cards carry their provenance", () => {
  /**
   * The load-bearing assertion of this file. Bedrock's Claude rates are not
   * confirmed, so the card must say so — and a null `verifiedOn` is what makes
   * every cost computed from it an estimate downstream.
   */
  it.each(MODELS)("marks the bedrock %s card unverified", (model) => {
    const card = bedrockProvider.rateCard(model);
    expect(card.verifiedOn).toBeNull();
    expect(card.source).toMatch(/unverified/i);
  });

  it.each(MODELS)("marks the anthropic %s card verified", (model) => {
    const card = anthropicProvider.rateCard(model);
    expect(card.verifiedOn).not.toBeNull();
    expect(card.source).toMatch(/claude-api skill/i);
  });

  /**
   * Until someone reads covara's actual bill, the Bedrock placeholder is the
   * first-party card. Pinning that equality keeps the placeholder honest: the
   * moment real rates land, this test fails and forces `verifiedOn` to be set
   * in the same change.
   */
  it("uses first-party rates as the bedrock placeholder, for now", () => {
    expect(BEDROCK_RATES.haiku.inputNanosPerToken).toBe(
      ANTHROPIC_RATES["claude-haiku-4-5"].inputNanosPerToken,
    );
  });
});

describe("providerFromEnv", () => {
  const AWS = {
    AWS_ANTHROPIC_ACCESS_KEY_ID: "AKIAEXAMPLE0000000AA",
    AWS_ANTHROPIC_SECRET_ACCESS_KEY: "s".repeat(40),
    AWS_ANTHROPIC_REGION: "ap-southeast-1",
  };

  it("selects bedrock when AWS credentials are present", () => {
    expect(providerFromEnv(AWS).id).toBe("bedrock");
  });

  it("selects anthropic when only an API key is present", () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "sk-ant-example" }).id).toBe(
      "anthropic",
    );
  });

  /**
   * Bedrock wins a tie deliberately: it is the account this project is
   * configured to run on, and silently preferring the billable first-party
   * key because both happened to be set is the kind of surprise that shows up
   * as an unexpected invoice.
   */
  it("prefers bedrock when both are configured", () => {
    expect(
      providerFromEnv({ ...AWS, ANTHROPIC_API_KEY: "sk-ant-example" }).id,
    ).toBe("bedrock");
  });

  it("refuses to guess when nothing is configured", () => {
    expect(() => providerFromEnv({})).toThrow(/no provider/i);
  });

  /**
   * A half-configured Bedrock block is the likeliest real misconfiguration —
   * copy two of the three lines and you get a client that fails at call time
   * with an opaque SigV4 error. Naming the missing variable at startup is the
   * boot-validation principle the tool registry already applies.
   */
  it("names the missing variable rather than failing later at call time", () => {
    const { AWS_ANTHROPIC_SECRET_ACCESS_KEY: _omitted, ...partial } = AWS;
    expect(() => providerFromEnv(partial)).toThrow(
      /AWS_ANTHROPIC_SECRET_ACCESS_KEY/,
    );
  });
});
