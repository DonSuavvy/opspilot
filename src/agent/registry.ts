/**
 * The tool registry.
 *
 * Every tool is a Zod schema + a handler + a safety class + an idempotency
 * flag, and the whole set is validated at boot. A misconfigured tool fails at
 * startup with every problem listed at once, rather than at 2am in production
 * with one problem per redeploy.
 *
 * Two things here are less obvious than they look:
 *
 * 1. **Zod's JSON Schema output is not strict-legal as emitted.** Anthropic's
 *    `strict: true` rejects numerical and string constraints, but Zod happily
 *    emits `exclusiveMinimum`/`maximum` for `.int().positive()` and
 *    `minLength`/`maxLength` for `.min()/.max()`. Those are stripped here
 *    before the schema goes on the wire.
 * 2. **Stripping them does not weaken validation.** The constraint still lives
 *    in the Zod schema, which the handler parses the model's arguments with.
 *    The wire schema constrains the model; Zod constrains reality. Same
 *    never-trust-the-model posture as the policy engine.
 */
import { z } from "zod";

export type SafetyClass = "read" | "auto_write" | "confirm_write";

const SAFETY_CLASSES: readonly SafetyClass[] = [
  "read",
  "auto_write",
  "confirm_write",
];

/** Anthropic's constraint on tool names. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Tool descriptions are the single biggest lever on tool-selection quality, so
 * a one-liner is treated as a configuration bug rather than a style nit.
 */
const MIN_DESCRIPTION_LENGTH = 20;

/**
 * JSON Schema keywords that Anthropic's strict tool use does not support.
 * Present in Zod's output, illegal on the wire, stripped at every depth.
 */
export const UNSUPPORTED_KEYWORDS: readonly string[] = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "$schema",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZodObject = z.ZodObject<any>;

export interface StrictJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  [key: string]: unknown;
}

/** What actually goes in the Messages API `tools` array. */
export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: StrictJsonSchema;
  strict: true;
}

export interface ToolContext {
  workspaceId: string;
  runId: string;
  /** Injected so tool handlers stay as deterministic as the policy engine. */
  now: Date;
}

export interface ToolDefinition<T extends AnyZodObject = AnyZodObject> {
  name: string;
  description: string;
  input: T;
  safetyClass: SafetyClass;
  /**
   * Whether replaying this call with the same arguments is a no-op. Required
   * for write classes: it is what makes a resumed run safe to retry after a
   * serverless invocation dies mid-tool.
   */
  idempotent: boolean;
  /** The forced terminal tool. Exactly one per registry. */
  terminal?: boolean;
  handler: (input: z.infer<T>, ctx: ToolContext) => Promise<unknown>;
}

export class ToolRegistryError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Tool registry validation failed with ${issues.length} problem(s):\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "ToolRegistryError";
    this.issues = issues;
  }
}

/**
 * Keys whose value is a map of **name → schema**. The keys inside them are
 * author-chosen identifiers, not JSON Schema keywords, so they must never be
 * matched against the blocklist — otherwise a tool field named `pattern`
 * gets deleted as though it were a constraint.
 */
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
]);

/** Keys whose value is literal data rather than a schema. Never recursed into. */
const LITERAL_KEYS = new Set(["default", "const", "examples", "enum"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively remove strict-illegal keywords and force objects closed.
 *
 * Position matters. The same string can be a constraint keyword, a field name,
 * or part of a literal default depending on where it sits, so the walk tracks
 * which of those it is rather than pattern-matching key names globally.
 */
function sanitize(node: unknown, issues: string[], path: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => sanitize(item, issues, `${path}[${i}]`));
  }
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;

    if (LITERAL_KEYS.has(key)) {
      // Literal data — a default of {pattern: "abc"} must survive intact.
      out[key] = value;
    } else if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        map[name] = sanitize(sub, issues, `${path}.${key}.${name}`);
      }
      out[key] = map;
    } else {
      out[key] = sanitize(value, issues, `${path}.${key}`);
    }
  }

  // Any object node must be closed, at every depth, or strict mode rejects it.
  if (out.type === "object") {
    if ("additionalProperties" in out && out.additionalProperties !== false) {
      // An open-ended map (z.record, .passthrough()) cannot be expressed under
      // strict tool use at all. Forcing it closed would produce a field that
      // silently accepts nothing, so fail at boot instead.
      issues.push(
        `${path}: open-ended object cannot be expressed under strict tool use — ` +
          `every object must be closed. Replace z.record()/.passthrough() with ` +
          `explicit properties.`,
      );
    }
    out.additionalProperties = false;
    if (!Array.isArray(out.required)) out.required = [];
  }

  return out;
}

/**
 * Defense in depth. Even if the walk above grows a bug, a schema whose
 * `required` names a property that does not exist can never validate, so
 * catching it here turns a silent production failure into a boot failure.
 */
function assertConsistent(node: unknown, issues: string[], path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertConsistent(item, issues, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(node)) return;

  if (node.type === "object" && Array.isArray(node.required)) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const orphaned = (node.required as string[]).filter(
      (name) => !(name in properties),
    );
    if (orphaned.length > 0) {
      issues.push(
        `${path}: required names ${orphaned.map((o) => `"${o}"`).join(", ")} ` +
          `but the property is absent — this schema can never validate`,
      );
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (LITERAL_KEYS.has(key)) continue;
    assertConsistent(value, issues, `${path}.${key}`);
  }
}

/**
 * Convert a Zod object schema to JSON Schema that satisfies `strict: true`.
 * Throws if the root is not an object — Anthropic tool inputs must be objects.
 */
export function toStrictJsonSchema(schema: AnyZodObject): StrictJsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;

  const issues: string[] = [];
  const cleaned = sanitize(raw, issues, "schema") as Record<string, unknown>;
  assertConsistent(cleaned, issues, "schema");

  if (issues.length > 0) throw new ToolRegistryError(issues);

  if (cleaned.type !== "object") {
    throw new ToolRegistryError([
      `input schema must be a JSON Schema object, got "${String(cleaned.type)}"`,
    ]);
  }

  return {
    ...cleaned,
    type: "object",
    properties: (cleaned.properties ?? {}) as Record<string, unknown>,
    required: (cleaned.required ?? []) as string[],
    additionalProperties: false,
  };
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  /** Deterministically ordered — the tools block is the head of the cache prefix. */
  toAnthropicTools(): AnthropicToolSpec[];
  requiresApproval(name: string): boolean;
  terminalToolName: string;
}

function validate(definitions: ToolDefinition[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  if (definitions.length === 0) {
    issues.push("registry: at least one tool must be registered");
  }

  for (const def of definitions) {
    const label = def?.name ?? "<unnamed tool>";

    if (typeof def?.name !== "string" || !TOOL_NAME_PATTERN.test(def.name)) {
      issues.push(
        `${label}: name must match ${TOOL_NAME_PATTERN.source} (got ${JSON.stringify(def?.name)})`,
      );
    } else if (seen.has(def.name)) {
      issues.push(`${label}: duplicate tool name`);
    } else {
      seen.add(def.name);
    }

    if (
      typeof def?.description !== "string" ||
      def.description.trim().length < MIN_DESCRIPTION_LENGTH
    ) {
      issues.push(
        `${label}: description must be at least ${MIN_DESCRIPTION_LENGTH} characters ` +
          `so the model can tell when to call it (got ${def?.description?.length ?? 0})`,
      );
    }

    if (!SAFETY_CLASSES.includes(def?.safetyClass)) {
      issues.push(
        `${label}: safetyClass must be one of ${SAFETY_CLASSES.join(" | ")} ` +
          `(got ${JSON.stringify(def?.safetyClass)})`,
      );
    }

    // Checked unconditionally rather than only for write classes: an invalid
    // safetyClass would otherwise short-circuit this and hide a second bug.
    if (typeof def?.idempotent !== "boolean") {
      issues.push(
        `${label}: idempotent must be an explicit boolean — a resumed or retried ` +
          `run may replay this call, and write-class tools must say whether that is safe`,
      );
    }

    if (typeof def?.handler !== "function") {
      issues.push(`${label}: handler must be a function`);
    }

    try {
      toStrictJsonSchema(def.input);
    } catch (error) {
      const detail =
        error instanceof ToolRegistryError
          ? error.issues.join("; ")
          : String(error);
      issues.push(`${label}: ${detail}`);
    }
  }

  const terminals = definitions.filter((d) => d?.terminal === true);
  if (terminals.length !== 1) {
    issues.push(
      `registry: exactly one terminal tool is required so every run ends with a ` +
        `structured outcome (found ${terminals.length})`,
    );
  }

  return issues;
}

/**
 * Validate and freeze a tool set. Throws `ToolRegistryError` listing every
 * problem found, so a misconfiguration is fixed in one pass rather than
 * discovered one boot at a time.
 */
export function buildRegistry(definitions: ToolDefinition[]): ToolRegistry {
  const issues = validate(definitions);
  if (issues.length > 0) throw new ToolRegistryError(issues);

  const byName = new Map(definitions.map((d) => [d.name, d]));
  const sorted = [...definitions].sort((a, b) => a.name.localeCompare(b.name));
  const terminal = definitions.find((d) => d.terminal === true)!;

  const specs: AnthropicToolSpec[] = sorted.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: toStrictJsonSchema(d.input),
    strict: true,
  }));

  return {
    list: () => [...definitions],
    get: (name) => byName.get(name),
    toAnthropicTools: () => specs,
    requiresApproval: (name) =>
      byName.get(name)?.safetyClass === "confirm_write",
    terminalToolName: terminal.name,
  };
}
