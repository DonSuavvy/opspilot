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

/**
 * Blocks 4-6 exist because block 3 turned out to be narrower than the comment
 * above it claimed. Mutation-testing the gate itself — breaking the sanitizer
 * seven ways and checking the exit code — showed `verify:boot` caught exactly
 * one of them: the open-ended-object case block 3 was written for. Reverting
 * the fix for `FAILURES.md` entry 1 *or* entry 10 left this gate green, which
 * is precisely what block 3's comment says it prevents.
 *
 * The suite caught all seven, so this was never a coverage hole. It was a gate
 * that did not demonstrate what it claimed to demonstrate — the same defect
 * class as the documentation claims corrected in Round 3.
 */
console.log("\n\x1b[1m4. The shipped wire schemas contain no illegal keyword\x1b[0m");

/** Structural keywords Anthropic's strict tool use accepts. */
const LEGAL_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "anyOf", "allOf", "$ref", "$defs", "definitions",
  "description", "title", "format", "default",
]);
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
const LITERALS = new Set(["default", "const", "examples", "enum"]);

/**
 * Inverted on purpose. Asserting the blocklist was applied only proves the
 * blocklist was applied; walking what survived catches an illegal keyword
 * nobody thought to blocklist.
 */
const SUPPORTED_FORMAT_VALUES = new Set([
  "date-time", "time", "date", "duration", "email",
  "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

function illegalKeywordsIn(node: unknown, path: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => illegalKeywordsIn(n, `${path}[${i}]`, found));
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const obj = node as Record<string, unknown>;

  // Every object must be closed at every depth, or strict mode rejects it.
  // `additionalProperties` is itself legal, so its *absence* is invisible to
  // the keyword walk below and needs its own assertion.
  if (obj.type === "object" && obj.additionalProperties !== false) {
    found.push(`${path}: object is not closed (additionalProperties !== false)`);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (SCHEMA_MAPS.has(key)) {
      // Keys here are author identifiers, not keywords.
      for (const [name, sub] of Object.entries(value as object)) {
        illegalKeywordsIn(sub, `${path}.${key}.${name}`, found);
      }
      continue;
    }
    if (LITERALS.has(key)) continue; // literal data, not schema
    if (!LEGAL_KEYWORDS.has(key)) found.push(`${path}.${key}`);
    if (key === "format" && typeof value === "string" && !SUPPORTED_FORMAT_VALUES.has(value)) {
      found.push(`${path}.format = "${value}" (not one of the ten supported values)`);
    }
    illegalKeywordsIn(value, `${path}.${key}`, found);
  }
}

const illegal: string[] = [];
for (const spec of registry.toAnthropicTools()) {
  illegalKeywordsIn(spec.input_schema, spec.name, illegal);
}
if (illegal.length > 0) {
  fail(`illegal keywords reached the wire schema: ${illegal.join(", ")}`);
}
ok(`${registry.toAnthropicTools().length} wire schemas, every keyword legal and every object closed`);

console.log("\n\x1b[1m5. A field named like a keyword survives (entry 1)\x1b[0m");

/**
 * No shipped tool emits a `format` or an object-valued `.default()`, so block 4
 * alone cannot see the allowlist or the literal-key handling break. This probe
 * carries both deliberately.
 */
const keywordNamedFields = {
  name: "probe_keyword_named_fields",
  description:
    "A probe tool whose input fields are legitimately named after JSON Schema keywords.",
  // `pattern`/`maximum`/`minLength` are FIELD NAMES, not constraints. A
  // position-blind sanitizer deletes them from `properties` while leaving them
  // in `required` — a schema that demands a field it simultaneously forbids.
  input: z.object({
    pattern: z.string(),
    maximum: z.number(),
    minLength: z.string(),
    // Emits `format: "base64"` (not one of the ten supported) plus
    // `contentEncoding`. Both must be gone from the wire.
    blob: z.base64(),
    // Literal data. Its inner `pattern` key is a value, not a keyword, and must
    // survive untouched.
    cfg: z.object({ pattern: z.string() }).default({ pattern: "abc" }),
  }),
  safetyClass: "read",
  idempotent: true,
  handler: async () => ({}),
} as unknown as ToolDefinition;

const probed = buildRegistry([keywordNamedFields, terminal])
  .toAnthropicTools()
  .find((t) => t.name === "probe_keyword_named_fields")!;

for (const field of ["pattern", "maximum", "minLength"]) {
  if (!(field in probed.input_schema.properties)) {
    fail(`field "${field}" was deleted from properties — the sanitizer is position-blind again`);
  }
  if (!probed.input_schema.required.includes(field)) {
    fail(`field "${field}" vanished from required`);
  }
}

const probeIllegal: string[] = [];
illegalKeywordsIn(probed.input_schema, probed.name, probeIllegal);
if (probeIllegal.length > 0) {
  fail(`probe schema carries illegal keywords: ${probeIllegal.join(", ")}`);
}

const cfg = probed.input_schema.properties.cfg as Record<string, unknown>;
const cfgDefault = cfg?.default as Record<string, unknown> | undefined;
if (cfgDefault?.pattern !== "abc") {
  fail(
    `the object-valued default was altered — literal data was walked as if it were ` +
      `a schema (got ${JSON.stringify(cfgDefault)})`,
  );
}
ok("keyword-named fields survive; base64 format and contentEncoding stripped; literal default intact");

console.log("\n\x1b[1m6. An unsatisfiable schema is rejected (entry 10)\x1b[0m");

const inconsistent = {
  name: "probe_inconsistent_schema",
  description:
    "A probe tool whose raw schema requires a property that does not exist.",
  // .meta() injects raw JSON Schema the sanitizer cannot itself produce, so
  // this exercises assertConsistent rather than a property it already holds.
  input: z.object({ real: z.string() }).meta({ required: ["real", "ghost"] }),
  safetyClass: "read",
  idempotent: true,
  handler: async () => ({}),
} as unknown as ToolDefinition;

try {
  buildRegistry([inconsistent, terminal]);
  fail("registry accepted a schema requiring a property it does not define — assertConsistent is not wired into boot");
} catch (error) {
  if (!(error instanceof ToolRegistryError)) throw error;
  if (!error.issues.some((i) => i.includes("can never validate"))) {
    fail(`rejected, but not by assertConsistent: ${error.issues.join("; ")}`);
  }
  ok("rejected as unsatisfiable, rather than shipping a schema no call can match");
}

console.log("\n\x1b[32m\x1b[1mBoot validation gate: PASS\x1b[0m\n");
