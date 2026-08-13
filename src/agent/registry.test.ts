import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildRegistry,
  ToolRegistryError,
  toStrictJsonSchema,
  type ToolDefinition,
} from "./registry";

/** A minimal, always-valid tool definition. Tests corrupt one field at a time. */
function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "get_customer",
    description:
      "Look up a Beacon Analytics customer by their external id. Returns plan, status and lifetime value.",
    input: z.object({ customer_id: z.string() }),
    safetyClass: "read",
    idempotent: true,
    handler: async () => ({ ok: true }),
    ...overrides,
  } as ToolDefinition;
}

/** The forced terminal tool. Every run must end by calling it. */
function terminalTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return tool({
    name: "resolve_ticket",
    description:
      "End the run with a structured outcome: action taken, amounts, reply draft and confidence.",
    input: z.object({
      action: z.enum(["refunded", "replied", "escalated"]),
      reply: z.string(),
    }),
    safetyClass: "auto_write",
    idempotent: true,
    terminal: true,
    ...overrides,
  });
}

/** Recursively collect every JSON Schema keyword present at any depth. */
function keywordsIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywordsIn(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keywordsIn(value, found);
    }
  }
  return found;
}

describe("toStrictJsonSchema", () => {
  it("emits additionalProperties:false and a complete required list", () => {
    const schema = toStrictJsonSchema(
      z.object({ a: z.string(), b: z.number() }),
    );

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["a", "b"]);
  });

  it("omits optional keys from required but keeps them in properties", () => {
    const schema = toStrictJsonSchema(
      z.object({ a: z.string(), b: z.string().optional() }),
    );

    expect(schema.required).toEqual(["a"]);
    expect(Object.keys(schema.properties)).toEqual(["a", "b"]);
  });

  it("drops the $schema key that Anthropic's input_schema does not take", () => {
    const schema = toStrictJsonSchema(z.object({ a: z.string() }));
    expect(schema).not.toHaveProperty("$schema");
  });

  /**
   * Zod emits `exclusiveMinimum` and `maximum` for .int().positive(), and
   * minLength/maxLength for .min()/.max(). Anthropic's strict tool use rejects
   * numerical and string constraints. These must never reach the wire.
   */
  it("strips numerical constraints that strict mode rejects", () => {
    const schema = toStrictJsonSchema(
      z.object({ amount_cents: z.number().int().positive().max(100_000) }),
    );

    const keywords = keywordsIn(schema);
    expect(keywords).not.toContain("minimum");
    expect(keywords).not.toContain("maximum");
    expect(keywords).not.toContain("exclusiveMinimum");
    expect(keywords).not.toContain("exclusiveMaximum");
    expect(keywords).not.toContain("multipleOf");
  });

  it("strips string constraints that strict mode rejects", () => {
    const schema = toStrictJsonSchema(
      z.object({ note: z.string().min(1).max(500) }),
    );

    const keywords = keywordsIn(schema);
    expect(keywords).not.toContain("minLength");
    expect(keywords).not.toContain("maxLength");
    expect(keywords).not.toContain("pattern");
  });

  it("strips array constraints nested inside properties", () => {
    const schema = toStrictJsonSchema(
      z.object({ tags: z.array(z.string().min(2)).min(1).max(5) }),
    );

    const keywords = keywordsIn(schema);
    expect(keywords).not.toContain("minItems");
    expect(keywords).not.toContain("maxItems");
    expect(keywords).not.toContain("minLength");
  });

  it("keeps the keywords strict mode does support", () => {
    const schema = toStrictJsonSchema(
      z.object({
        reason: z.enum(["duplicate_charge", "other"]).describe("Why"),
        when: z.iso.datetime(),
      }),
    );

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.reason.enum).toEqual(["duplicate_charge", "other"]);
    expect(properties.reason.description).toBe("Why");
    expect(properties.when.format).toBe("date-time");
  });

  /**
   * The sanitizer walks the schema tree deleting keys that match a keyword
   * blocklist. Inside `properties`, the keys are *field names*, not keywords —
   * so a tool field named `pattern` was being deleted from `properties` while
   * surviving in `required`, producing a schema that demands a field it also
   * forbids. Nothing could ever validate against it, and boot validation could
   * not see it because the sanitizer returns quietly rather than throwing.
   */
  it.each(["pattern", "maximum", "minLength", "uniqueItems"])(
    "does not delete a tool field whose name collides with keyword %s",
    (fieldName) => {
      const schema = toStrictJsonSchema(
        z.object({ [fieldName]: z.string(), other: z.string() }),
      );

      expect(Object.keys(schema.properties)).toContain(fieldName);
      expect(schema.required).toContain(fieldName);
    },
  );

  it("never lets required reference a property that does not exist", () => {
    const schema = toStrictJsonSchema(
      z.object({
        pattern: z.string(),
        maximum: z.number(),
        nested: z.object({ minLength: z.string() }),
      }),
    );

    // `Object.hasOwn` rather than `in` for the same reason the implementation
    // uses it — a test that asks `in` would call an orphaned `toString`
    // satisfied. No current field name triggers it; the point is that this
    // assertion should not carry the bug it is checking for.
    const orphaned = schema.required.filter(
      (r) => !Object.hasOwn(schema.properties, r),
    );
    expect(orphaned).toEqual([]);
  });

  it("preserves an object-valued default verbatim", () => {
    const schema = toStrictJsonSchema(
      z.object({
        cfg: z
          .object({ pattern: z.string(), keep: z.string() })
          .default({ pattern: "abc", keep: "z" }),
      }),
    );

    const cfg = (schema.properties as Record<string, Record<string, unknown>>)
      .cfg;
    expect(cfg.default).toEqual({ pattern: "abc", keep: "z" });
  });

  /**
   * z.record() is an open-ended map. Strict mode requires every object to be
   * closed, so an open map cannot be expressed at all — forcing
   * additionalProperties:false would produce a field that silently accepts
   * nothing. Failing at boot is the honest outcome.
   */
  it("rejects an open-ended record rather than silently closing it", () => {
    expect(() =>
      toStrictJsonSchema(z.object({ meta: z.record(z.string(), z.number()) })),
    ).toThrow(ToolRegistryError);
  });

  it("closes objects nested inside unions and $defs", () => {
    const inner = z.object({ a: z.string() });
    const schema = toStrictJsonSchema(
      z.object({ choice: z.union([inner, z.object({ b: z.string() })]) }),
    );

    const found: unknown[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        const node = n as Record<string, unknown>;
        if (node.type === "object") found.push(node.additionalProperties);
        Object.values(node).forEach(walk);
      }
    };
    walk(schema);

    expect(found.length).toBeGreaterThan(1);
    expect(found.every((v) => v === false)).toBe(true);
  });

  it("preserves nested objects as strict too", () => {
    const schema = toStrictJsonSchema(
      z.object({ meta: z.object({ source: z.string().min(1) }) }),
    );

    const meta = (schema.properties as Record<string, Record<string, unknown>>)
      .meta;
    expect(meta.additionalProperties).toBe(false);
    expect(meta.required).toEqual(["source"]);
  });

  /**
   * Anthropic's strict tool use accepts exactly ten string formats. Zod emits
   * many more — `z.base64()` alone adds `format: "base64"` *and* the
   * unsupported `contentEncoding` keyword. Neither is in the blocklist, so
   * both sail through boot validation and are rejected on the wire instead:
   * exactly the 2am failure boot validation exists to prevent.
   */
  it("keeps the string formats strict mode actually supports", () => {
    const schema = toStrictJsonSchema(
      z.object({ when: z.iso.datetime(), who: z.email(), id: z.uuid() }),
    );

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.when.format).toBe("date-time");
    expect(properties.who.format).toBe("email");
    expect(properties.id.format).toBe("uuid");
  });

  it("strips a string format outside Anthropic's supported set", () => {
    const schema = toStrictJsonSchema(z.object({ blob: z.base64() }));

    const blob = (schema.properties as Record<string, Record<string, unknown>>)
      .blob;
    expect(blob.format).toBeUndefined();
    expect(blob.contentEncoding).toBeUndefined();
    expect(blob.type).toBe("string");
  });

  /**
   * `assertConsistent` is the safety net FAILURES.md entry 1 added, and its
   * claim is that "one assertion catches this whole bug class". Nothing proved
   * it: the test that looks like coverage asserts a property the fixed
   * sanitizer already guarantees on its own, so the check could be deleted
   * outright and the suite stayed green. These feed it an inconsistency the
   * sanitizer cannot produce, via `.meta()` raw-schema injection.
   */
  it("fails when required names an absent property", () => {
    const schema = z
      .object({ a: z.string() })
      .meta({ required: ["a", "ghost"] } as never);

    expect(() => toStrictJsonSchema(schema)).toThrow(ToolRegistryError);
    expect(() => toStrictJsonSchema(schema)).toThrow(/ghost/);
  });

  it("catches an orphaned required nested inside properties", () => {
    const schema = z.object({
      outer: z
        .object({ kept: z.string() })
        .meta({ required: ["kept", "phantom"] } as never),
    });

    expect(() => toStrictJsonSchema(schema)).toThrow(/phantom/);
  });

  /**
   * Round 4. The orphan check asked `name in properties`, and `in` walks the
   * prototype chain — so `"toString" in {}` is `true` and every name
   * `Object.prototype` supplies is treated as a property that exists. A schema
   * requiring `toString` with no such property passed the one assertion whose
   * stated purpose is "catches this whole bug class".
   *
   * The same family as FAILURES.md entry 1: a JSON Schema key is an *author
   * identifier*, and reasoning about it with a JavaScript operator that knows
   * about inherited members treats attacker- or author-chosen strings as
   * language builtins. `Object.hasOwn` is the operator that means what this
   * check meant.
   *
   * Reachable rather than theoretical — these are ordinary English words, and
   * `constructor`, `valueOf` and `toString` are plausible field names in a
   * billing tool. `__proto__` is the one that would be chosen deliberately.
   */
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "catches an orphaned required named %s, which Object.prototype supplies",
    (inherited) => {
      const schema = z
        .object({ a: z.string() })
        .meta({ required: ["a", inherited] } as never);

      expect(() => toStrictJsonSchema(schema)).toThrow(ToolRegistryError);
    },
  );
});

describe("buildRegistry — boot-time validation", () => {
  it("accepts a well-formed registry", () => {
    const registry = buildRegistry([tool(), terminalTool()]);

    expect(registry.list()).toHaveLength(2);
    expect(registry.get("get_customer")?.safetyClass).toBe("read");
    expect(registry.terminalToolName).toBe("resolve_ticket");
  });

  it("rejects duplicate tool names", () => {
    expect(() => buildRegistry([tool(), tool(), terminalTool()])).toThrow(
      ToolRegistryError,
    );
  });

  it.each([
    ["empty", ""],
    ["spaces", "get customer"],
    ["dots", "get.customer"],
    ["too long", "a".repeat(65)],
  ])("rejects a tool name with %s", (_label, name) => {
    expect(() => buildRegistry([tool({ name }), terminalTool()])).toThrow(
      ToolRegistryError,
    );
  });

  it("rejects an empty description", () => {
    expect(() =>
      buildRegistry([tool({ description: "" }), terminalTool()]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a description too thin to steer tool choice", () => {
    expect(() =>
      buildRegistry([tool({ description: "gets stuff" }), terminalTool()]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects an unknown safety class", () => {
    expect(() =>
      buildRegistry([
        tool({ safetyClass: "superuser" as never }),
        terminalTool(),
      ]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a write-class tool with no idempotent flag", () => {
    expect(() =>
      buildRegistry([
        tool({
          name: "issue_refund",
          safetyClass: "confirm_write",
          idempotent: undefined as never,
        }),
        terminalTool(),
      ]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a missing handler", () => {
    expect(() =>
      buildRegistry([tool({ handler: undefined as never }), terminalTool()]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a handler that is not callable", () => {
    expect(() =>
      buildRegistry([
        tool({ handler: "not a function" as never }),
        terminalTool(),
      ]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a non-object input schema", () => {
    expect(() =>
      buildRegistry([tool({ input: z.string() as never }), terminalTool()]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects a registry with no terminal tool", () => {
    expect(() => buildRegistry([tool()])).toThrow(ToolRegistryError);
  });

  it("rejects more than one terminal tool", () => {
    expect(() =>
      buildRegistry([
        terminalTool(),
        terminalTool({ name: "resolve_ticket_v2" }),
      ]),
    ).toThrow(ToolRegistryError);
  });

  it("rejects an empty registry", () => {
    expect(() => buildRegistry([])).toThrow(ToolRegistryError);
  });

  it("fails loudly: the error names the tool and every problem at once", () => {
    let error: ToolRegistryError | undefined;
    try {
      buildRegistry([tool({ name: "bad name", description: "x" })]);
    } catch (caught) {
      error = caught as ToolRegistryError;
    }

    expect(error).toBeInstanceOf(ToolRegistryError);
    // All three problems reported together, not one per boot attempt.
    expect(error!.issues).toHaveLength(3);
    expect(error!.message).toContain("bad name");
    expect(error!.issues.join("\n")).toMatch(/name/i);
    expect(error!.issues.join("\n")).toMatch(/description/i);
    expect(error!.issues.join("\n")).toMatch(/terminal/i);
  });
});

describe("registry.toAnthropicTools", () => {
  it("emits strict:true with a strict-legal schema", () => {
    const specs = buildRegistry([
      tool({
        name: "issue_refund",
        description:
          "Refund a paid invoice. Revalidated against the policy engine before any money moves.",
        input: z.object({
          invoice_id: z.string(),
          amount_cents: z.number().int().positive(),
        }),
        safetyClass: "confirm_write",
        idempotent: true,
      }),
      terminalTool(),
    ]).toAnthropicTools();

    const refund = specs.find((s) => s.name === "issue_refund")!;
    expect(refund.strict).toBe(true);
    expect(refund.input_schema.additionalProperties).toBe(false);
    expect(refund.input_schema.required).toEqual([
      "invoice_id",
      "amount_cents",
    ]);
    expect(keywordsIn(refund.input_schema)).not.toContain("exclusiveMinimum");
  });

  it("carries no registry-internal fields onto the wire", () => {
    const [spec] = buildRegistry([terminalTool()]).toAnthropicTools();

    expect(Object.keys(spec).sort()).toEqual([
      "description",
      "input_schema",
      "name",
      "strict",
    ]);
  });

  it("is deterministically ordered so the prompt cache prefix stays stable", () => {
    const defs = [tool(), terminalTool()];
    const forward = buildRegistry(defs).toAnthropicTools();
    const reversed = buildRegistry([...defs].reverse()).toAnthropicTools();

    expect(forward.map((s) => s.name)).toEqual(reversed.map((s) => s.name));
  });
});

describe("defense in depth", () => {
  /**
   * The constraints stripped from the wire schema are still enforced by Zod
   * when the handler parses the model's arguments. Stripping them makes the
   * schema strict-legal; it does not make the tool permissive.
   */
  it("still rejects out-of-range input at parse time after stripping", () => {
    const input = z.object({ amount_cents: z.number().int().positive() });
    const registry = buildRegistry([
      tool({ name: "issue_refund", input, safetyClass: "auto_write" }),
      terminalTool(),
    ]);

    const spec = registry.toAnthropicTools()[0];
    expect(keywordsIn(spec.input_schema)).not.toContain("exclusiveMinimum");

    // The model could still send a negative amount; Zod is the backstop.
    expect(registry.get("issue_refund")!.input.safeParse({ amount_cents: -5 })
      .success).toBe(false);
    expect(registry.get("issue_refund")!.input.safeParse({ amount_cents: 500 })
      .success).toBe(true);
  });

  it("exposes safety class so confirm_write tools can be gated", () => {
    const registry = buildRegistry([
      tool({ name: "get_invoices" }),
      tool({
        name: "issue_refund",
        safetyClass: "confirm_write",
        idempotent: true,
      }),
      terminalTool(),
    ]);

    expect(registry.requiresApproval("issue_refund")).toBe(true);
    expect(registry.requiresApproval("get_invoices")).toBe(false);
  });

  /**
   * Round 4. The test above covers `confirm_write` and `read` and nothing
   * else, so `requiresApproval` could be widened from
   * `safetyClass === "confirm_write"` to `safetyClass !== "read"` and the whole
   * suite stayed green. That mutation is not academic: it routes every
   * `auto_write` tool — `draft_reply`, `escalate`, `resolve_ticket` — into the
   * approval queue, which stalls every run behind a human on the terminal tool
   * and quietly converts the demo into a manual process.
   *
   * Three classes, two tested. The missing cell is the one in the middle.
   */
  it("does not gate auto_write tools — reversible and logged is not confirm", () => {
    const registry = buildRegistry([
      tool({ name: "get_invoices" }),
      tool({ name: "draft_reply", safetyClass: "auto_write", idempotent: true }),
      tool({ name: "escalate", safetyClass: "auto_write", idempotent: true }),
      tool({
        name: "issue_refund",
        safetyClass: "confirm_write",
        idempotent: true,
      }),
      terminalTool(),
    ]);

    expect(registry.requiresApproval("draft_reply")).toBe(false);
    expect(registry.requiresApproval("escalate")).toBe(false);
    // The terminal tool is auto_write too; gating it deadlocks every run.
    expect(registry.requiresApproval(registry.terminalToolName)).toBe(false);
    expect(registry.requiresApproval("issue_refund")).toBe(true);
  });

  /**
   * Round 4. `byName.get(name)?.safetyClass === "confirm_write"` is `false` for
   * a name the registry has never heard of, so an unknown tool was reported as
   * *not* needing approval — a security control failing open on exactly the
   * input it cannot vouch for.
   *
   * Reachable from Day 2: the agent loop reads tool names out of model output,
   * and a hallucinated or renamed name lands here. Throwing rather than
   * returning `true` because an unknown name is a bug in the caller, not a
   * risky-but-real tool call: the loop must reject it as an unknown tool, and
   * silently routing it into the approval queue would put a human in front of a
   * tool that does not exist. Same reasoning as `parsePolicyConfig` — refusing
   * to answer beats answering about nothing.
   */
  it("throws on an unknown tool rather than reporting it needs no approval", () => {
    const registry = buildRegistry([tool({ name: "get_invoices" }), terminalTool()]);

    expect(() => registry.requiresApproval("definitely_not_a_tool")).toThrow(
      ToolRegistryError,
    );
    expect(() => registry.requiresApproval("definitely_not_a_tool")).toThrow(
      /definitely_not_a_tool/,
    );
  });
});
