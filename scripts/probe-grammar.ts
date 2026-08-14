/**
 * Which tool schema blows up Bedrock's strict-mode grammar compiler?
 *
 * The Day-2 gate failed with `400 Compiled grammar size (329.9MB) exceeds
 * maximum allowed size (300MB)` — from 3.2KB of JSON Schema across nine tools.
 * That ratio says the explosion is in how the grammar is compiled, not in how
 * large the schemas are, so the question is which shape triggers it.
 *
 * Each probe sends a one-token request: the grammar is compiled before
 * generation, so a rejection arrives without paying for output.
 *
 *   npx tsx scripts/probe-grammar.ts
 */
import { config } from "dotenv";

import { buildRegistry } from "../src/agent/registry";
import { createClient, providerFromEnv } from "../src/agent/provider";
import { TOOLS } from "../src/agent/tools";

config({ path: ".env.local", quiet: true });

const provider = providerFromEnv(process.env);
const client = createClient(provider, process.env);
const model = provider.modelId("haiku");
const registry = buildRegistry(TOOLS);
const specs = registry.toAnthropicTools();

/** Returns null when the grammar compiled, or the error message when it did not. */
async function probe(tools: unknown[]): Promise<string | null> {
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").slice(0, 120);
  }
}

async function main() {
  console.log(`model: ${model}\n`);

  console.log("— each tool alone —");
  const solo: string[] = [];
  for (const spec of specs) {
    const failure = await probe([spec]);
    console.log(`  ${failure ? "FAIL" : "ok  "}  ${spec.name}${failure ? `  ${failure}` : ""}`);
    if (!failure) solo.push(spec.name);
  }

  console.log("\n— cumulative, in registry order —");
  for (let n = 1; n <= specs.length; n++) {
    const subset = specs.slice(0, n);
    const failure = await probe(subset);
    console.log(
      `  ${failure ? "FAIL" : "ok  "}  ${String(n).padStart(2)} tools: ${subset.map((s) => s.name).join(", ")}`,
    );
    if (failure) {
      console.log(`        ${failure}`);
      break;
    }
  }

  console.log("\n— all nine without strict —");
  const relaxed = specs.map(({ ...rest }) => {
    delete (rest as { strict?: unknown }).strict;
    return rest;
  });
  const failure = await probe(relaxed);
  console.log(`  ${failure ? `FAIL  ${failure}` : "ok"}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
