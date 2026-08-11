/**
 * Day 1 gate evidence: boot-time tool validation.
 *
 * Proves two things in one run:
 *   1. The real production tool set passes validation.
 *   2. A deliberately misconfigured tool is rejected loudly, with every
 *      problem reported at once rather than one per boot attempt.
 *
 * Run: npm run verify:boot
 */
import { z } from "zod";

import {
  buildRegistry,
  ToolRegistryError,
  type ToolDefinition,
} from "../src/agent/registry";
import { TOOLS } from "../src/agent/tools";

function ok(message: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function fail(message: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
}

console.log("\n\x1b[1m1. Production registry boots\x1b[0m");
const registry = buildRegistry(TOOLS);
ok(`${registry.list().length} tools validated`);
ok(`terminal tool: ${registry.terminalToolName}`);
ok(
  `gated behind approval: ${registry
    .list()
    .filter((t) => t.safetyClass === "confirm_write")
    .map((t) => t.name)
    .join(", ")}`,
);

console.log("\n\x1b[1m2. A misconfigured tool is rejected\x1b[0m");

// Every field below is wrong on purpose.
const brokenTool = {
  name: "issue refund!", // spaces and punctuation are illegal
  description: "refunds", // too thin to steer tool choice
  input: z.object({ amount: z.number() }),
  safetyClass: "superuser", // not a known safety class
  idempotent: undefined, // write class with no idempotency declaration
  handler: "nope", // not callable
} as unknown as ToolDefinition;

try {
  buildRegistry([brokenTool]);
  fail("registry accepted a broken tool definition — validation is not working");
} catch (error) {
  if (!(error instanceof ToolRegistryError)) throw error;

  ok(`rejected with ${error.issues.length} issues, all reported together:`);
  for (const issue of error.issues) {
    console.log(`      \x1b[90m·\x1b[0m ${issue}`);
  }

  // The whole point is failing at boot, not at 2am in production.
  if (error.issues.length < 5) {
    fail(
      `expected every problem to be reported; only got ${error.issues.length}`,
    );
  }
}

/**
 * Block 2's broken tool has a perfectly valid *schema*, so it is rejected by
 * definition-level checks and never reaches the sanitizer. That left the part
 * of boot validation with the actual history of bugs (FAILURES.md entries 1 and
 * 10) unexercised by the gate that exists to demonstrate it.
 */
console.log("\n\x1b[1m3. A schema that cannot be expressed is rejected\x1b[0m");

const terminal: ToolDefinition = {
  name: "resolve_ticket",
  description:
    "End the run with a structured outcome, so the eval scorers have something to key off.",
  input: z.object({ action: z.enum(["answered", "escalated"]) }),
  safetyClass: "auto_write",
  idempotent: true,
  terminal: true,
  handler: async () => ({}),
};

const openMapTool = {
  // z.record() is an open-ended map. Strict tool use requires every object to
  // be closed, so this cannot be expressed at all — and forcing it closed would
  // ship a field that silently matches nothing.
  name: "search_metadata",
  description:
    "A probe tool whose input carries an open-ended record of arbitrary keys.",
  input: z.object({ meta: z.record(z.string(), z.number()) }),
  safetyClass: "read",
  idempotent: true,
  handler: async () => ({}),
} as unknown as ToolDefinition;

try {
  buildRegistry([openMapTool, terminal]);
  fail("registry accepted an inexpressible schema — the sanitizer is not wired into boot");
} catch (error) {
  if (!(error instanceof ToolRegistryError)) throw error;
  ok("rejected, rather than silently shipping a field that matches nothing:");
  for (const issue of error.issues) {
    console.log(`      \x1b[90m·\x1b[0m ${issue}`);
  }
}

console.log("\n\x1b[32m\x1b[1mBoot validation gate: PASS\x1b[0m\n");
