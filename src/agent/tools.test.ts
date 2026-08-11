import { describe, expect, it } from "vitest";

import { buildRegistry, UNSUPPORTED_KEYWORDS } from "./registry";
import { NotImplementedError, TOOLS } from "./tools";

const registry = buildRegistry(TOOLS);

/** Maps of name → schema. Their keys are author identifiers, not keywords. */
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
]);

/** Keys whose value is literal data rather than a schema. */
const LITERAL_KEYS = new Set(["default", "const", "examples", "enum"]);

/**
 * Every JSON Schema keyword present at any depth — in *keyword position*.
 *
 * This walker has to mirror `sanitize`, because a position-blind version is
 * the same bug the sanitizer was fixed for (FAILURES.md entry 1), just moved
 * into the regression net. Collecting field names as though they were keywords
 * made this test fail the moment a tool declared an ordinary field called
 * `pattern` — while registry.test.ts asserts that exact field must survive.
 * Two files demanding opposite things is worse than either being wrong alone.
 */
function keywordsIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywordsIn(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;

  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    if (LITERAL_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object") {
      // Recurse into the sub-schemas, never over the field names.
      for (const sub of Object.values(value)) keywordsIn(sub, found);
      continue;
    }
    keywordsIn(value, found);
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
    // Imported rather than re-listed: a hand-copied subset drifts from the
    // real blocklist, and this test is the regression net for the whole thing.
    const illegal = UNSUPPORTED_KEYWORDS;

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
