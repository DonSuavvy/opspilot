import { describe, expect, it } from "vitest";

import { buildRegistry } from "./registry";
import { NotImplementedError, TOOLS } from "./tools";

const registry = buildRegistry(TOOLS);

/** Every JSON Schema keyword present at any depth of the emitted specs. */
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

describe("production tool set", () => {
  it("passes boot validation", () => {
    expect(() => buildRegistry(TOOLS)).not.toThrow();
  });

  it("registers the nine tools the plan calls for", () => {
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      "draft_reply",
      "escalate",
      "get_customer",
      "get_invoices",
      "get_subscription",
      "issue_refund",
      "resolve_ticket",
      "search_kb",
      "update_subscription",
    ]);
  });

  it("forces every run to end at resolve_ticket", () => {
    expect(registry.terminalToolName).toBe("resolve_ticket");
  });

  it("gates exactly the two tools that move money or change billing", () => {
    const gated = registry
      .list()
      .filter((t) => t.safetyClass === "confirm_write")
      .map((t) => t.name)
      .sort();

    expect(gated).toEqual(["issue_refund", "update_subscription"]);
  });

  it("keeps every read tool free of side effects", () => {
    const reads = registry
      .list()
      .filter((t) => t.safetyClass === "read")
      .map((t) => t.name)
      .sort();

    expect(reads).toEqual([
      "get_customer",
      "get_invoices",
      "get_subscription",
      "search_kb",
    ]);
  });

  it("declares every write tool idempotent so a resumed run cannot double-apply", () => {
    const writes = registry
      .list()
      .filter((t) => t.safetyClass !== "read");

    expect(writes.length).toBeGreaterThan(0);
    for (const tool of writes) {
      expect(tool.idempotent, `${tool.name} must declare idempotency`).toBe(
        true,
      );
    }
  });

  it("gives issue_refund an idempotency key so a retry cannot double-refund", () => {
    const shape = registry.get("issue_refund")!.input.shape;
    expect(Object.keys(shape)).toContain("idempotency_key");
  });

  /**
   * Regression guard. Adding `.min(1)` or `.positive()` to any tool schema
   * emits keywords that strict mode rejects; the registry strips them, and
   * this asserts the stripping actually covered the whole production set.
   */
  it("emits strict-legal JSON Schema for every tool", () => {
    const illegal = [
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
      "$schema",
    ];

    for (const spec of registry.toAnthropicTools()) {
      const keywords = keywordsIn(spec.input_schema);
      for (const keyword of illegal) {
        expect(
          keywords.has(keyword),
          `${spec.name} leaked "${keyword}" into its wire schema`,
        ).toBe(false);
      }
      expect(spec.strict).toBe(true);
      expect(spec.input_schema.additionalProperties).toBe(false);
    }
  });

  it("stubs handlers loudly rather than silently succeeding", async () => {
    await expect(
      registry.get("issue_refund")!.handler({}, {
        workspaceId: "w",
        runId: "r",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
