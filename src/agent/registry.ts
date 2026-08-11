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
const UNSUPPORTED_KEYWORDS: readonly string[] = [
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively remove strict-illegal keywords and force objects closed. */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    out[key] = sanitize(value);
  }

  // Any object node must be closed, at every depth, or strict mode rejects it.
  if (out.type === "object" && isPlainObject(out.properties)) {
    out.additionalProperties = false;
    if (!Array.isArray(out.required)) out.required = [];
  }

  return out;
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
  const cleaned = sanitize(raw) as Record<string, unknown>;

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
