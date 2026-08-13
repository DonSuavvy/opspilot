/**
 * The provider adapter — the only module that knows *which* Claude OpsPilot is
 * talking to.
 *
 * PLAN.md listed a provider adapter as a Day-10 stretch ("a provider adapter
 * interface with a GPT entry"). It moved forward because OpsPilot now runs on
 * **Amazon Bedrock** (the covara account) rather than the first-party API, and
 * an adapter is a better answer than swapping one hardcoded client for
 * another: the demo can move between providers as a config change, the Day-10
 * bake-off gains an axis, and nothing downstream branches on provider.
 *
 * Exactly two things differ per provider, and this module owns both.
 *
 * **Model identity.** Bedrock wants `global.anthropic.claude-haiku-4-5`; the
 * first-party API wants `claude-haiku-4-5`. Same model, two names. Everything
 * else in the codebase refers to models by the logical name — `haiku` — so a
 * provider swap never reaches the call sites.
 *
 * **The rate card.** Bedrock is partner-operated and priced separately. Its
 * current Claude rates are *unverified* (see BEDROCK_RATES), so costs computed
 * from them are flagged as estimates instead of being reported as measured.
 */
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";

import {
  ANTHROPIC_RATES,
  rateCard,
  type ModelId,
  type RateCard,
} from "./cost";

export type ProviderId = "bedrock" | "anthropic";

/**
 * How the rest of the codebase names models. Deliberately not the wire id —
 * a logical name survives both a provider swap and a model upgrade.
 */
export type LogicalModel = "haiku" | "sonnet" | "opus";

const FIRST_PARTY_ID: Readonly<Record<LogicalModel, ModelId>> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

/**
 * Bedrock's placeholder rates, and the reason they are marked unverified.
 *
 * AWS prices Claude separately from Anthropic, and the current Bedrock rates
 * for these models could not be confirmed: the pricing page surfaced only
 * Claude 3.5 Sonnet — retired — and showed it at $6/$30 against the
 * first-party $3/$15. That is a 2x gap on the one comparable data point, which
 * is precisely why guessing is not acceptable here.
 *
 * So the numbers below are the first-party card standing in as a placeholder,
 * and `verifiedOn: null` is the honest part: every cost derived from them
 * carries `estimated: true`, and the spend guard charges them at a pessimistic
 * multiple. To resolve this, read covara's actual Bedrock line items in Cost
 * Explorer — the same way the embedding rate in the vault was established —
 * then set real numbers and a `verifiedOn` date. A test pins these equal to
 * the first-party card so that change cannot be made without also updating
 * the provenance.
 */
export const BEDROCK_RATES: Readonly<Record<LogicalModel, RateCard>> = {
  haiku: rateCard(1, 5, {
    verifiedOn: null,
    source:
      "UNVERIFIED placeholder — first-party rates. AWS lists Claude " +
      "separately; confirm covara's Bedrock line items in Cost Explorer.",
  }),
  sonnet: rateCard(3, 15, {
    verifiedOn: null,
    source: "UNVERIFIED placeholder — first-party rates.",
  }),
  opus: rateCard(5, 25, {
    verifiedOn: null,
    source: "UNVERIFIED placeholder — first-party rates.",
  }),
};

export interface Provider {
  id: ProviderId;
  /** The id this provider's API expects for a logical model. */
  modelId(model: LogicalModel): string;
  rateCard(model: LogicalModel): RateCard;
}

function requireMapping<T>(
  table: Readonly<Record<string, T>>,
  model: LogicalModel,
  provider: ProviderId,
): T {
  const value = table[model];
  if (value === undefined) {
    throw new RangeError(
      `provider: ${provider} has no mapping for model "${model}" — add one ` +
        `rather than falling back, so an unknown model cannot reach the wire`,
    );
  }
  return value;
}

/**
 * The `global.` prefix selects a **cross-region inference profile**. It is why
 * these models resolve from `ap-southeast-1`, where the regional Bedrock
 * catalogue does not list them — verified live against covara on 2026-07-20
 * (Haiku 4.5 and Sonnet 4.6, sequential and 5-way concurrent, no throttle).
 * Removing the prefix looks like tidying and breaks the only account this
 * project can currently run against.
 */
const BEDROCK_ID: Readonly<Record<LogicalModel, string>> = {
  haiku: "global.anthropic.claude-haiku-4-5",
  sonnet: "global.anthropic.claude-sonnet-5",
  opus: "global.anthropic.claude-opus-5",
};

export const bedrockProvider: Provider = {
  id: "bedrock",
  modelId: (model) => requireMapping(BEDROCK_ID, model, "bedrock"),
  rateCard: (model) => requireMapping(BEDROCK_RATES, model, "bedrock"),
};

export const anthropicProvider: Provider = {
  id: "anthropic",
  modelId: (model) => requireMapping(FIRST_PARTY_ID, model, "anthropic"),
  rateCard: (model) =>
    ANTHROPIC_RATES[requireMapping(FIRST_PARTY_ID, model, "anthropic")],
};

/** The Bedrock variables, named so a partial copy names what is missing. */
const BEDROCK_ENV = [
  "AWS_ANTHROPIC_ACCESS_KEY_ID",
  "AWS_ANTHROPIC_SECRET_ACCESS_KEY",
  "AWS_ANTHROPIC_REGION",
] as const;

/**
 * Choose a provider from the environment.
 *
 * Bedrock wins a tie on purpose. Both sets of credentials being present is a
 * developer-machine reality, and silently preferring the *billable*
 * first-party key in that case is the kind of surprise that arrives later as
 * an invoice. Configured intent beats convenience.
 *
 * A half-configured Bedrock block is the likeliest real misconfiguration —
 * copy two of the three lines and the failure lands much later as an opaque
 * SigV4 error. Naming the missing variable up front is the same principle the
 * tool registry applies at boot: fail where the problem is, not where it
 * surfaces.
 */
export function providerFromEnv(
  env: Record<string, string | undefined>,
): Provider {
  const present = BEDROCK_ENV.filter((k) => (env[k] ?? "").length > 0);

  if (present.length > 0) {
    const missing = BEDROCK_ENV.filter((k) => !present.includes(k));
    if (missing.length > 0) {
      throw new Error(
        `provider: Bedrock is partly configured — missing ${missing.join(", ")}. ` +
          `Set it, or remove the other ${present.length} to fall back to the ` +
          `Anthropic API.`,
      );
    }
    return bedrockProvider;
  }

  if ((env.ANTHROPIC_API_KEY ?? "").length > 0) return anthropicProvider;

  throw new Error(
    "provider: no provider configured — set the AWS_ANTHROPIC_* trio for " +
      "Bedrock, or ANTHROPIC_API_KEY for the Anthropic API",
  );
}

/**
 * Build the SDK client for a provider.
 *
 * Separate from `providerFromEnv` so provider *selection* stays pure and
 * testable while client construction — which reads credentials and opens
 * connections — is an explicit, separate act.
 *
 * The Mantle client is the Messages-API Bedrock endpoint, not the legacy
 * `InvokeModel` path, so the request shape matches the first-party SDK and the
 * agent loop is written once. Note `awsSecretAccessKey`: the legacy
 * `AnthropicBedrock` class spells the same field `awsSecretKey`, and mixing
 * them throws "must be provided together", which reads like a *missing*
 * variable rather than a misspelled one.
 */
export function createClient(
  provider: Provider,
  env: Record<string, string | undefined>,
): Anthropic | AnthropicBedrockMantle {
  if (provider.id === "bedrock") {
    return new AnthropicBedrockMantle({
      awsAccessKey: env.AWS_ANTHROPIC_ACCESS_KEY_ID,
      awsSecretAccessKey: env.AWS_ANTHROPIC_SECRET_ACCESS_KEY,
      awsRegion: env.AWS_ANTHROPIC_REGION,
    });
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}
