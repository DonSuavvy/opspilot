import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "@/policy/refund";

import { ESCALATION_REASONS } from "../policy/refund";
import {
  buildRegistry,
  UNSUPPORTED_KEYWORDS,
  type ToolContext,
} from "./registry";
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

  /**
   * Repointed from `issue_refund` to `update_subscription`: the refund handler
   * is implemented as of Day 5, so asserting it still throws would have been a
   * test pinning the absence of the feature it was meant to guard.
   * `update_subscription` is the remaining confirm-write stub.
   */
  it("stubs handlers loudly rather than silently succeeding", async () => {
    await expect(
      registry.get("update_subscription")!.handler({}, {
        workspaceId: "w",
        runId: "r",
        ticketId: "t",
        now: new Date(),
        // Never reached: the stub throws before touching the repository, and
        // the loop pauses before the handler at all.
        data: {} as ToolContext["data"],
        policyConfig: DEFAULT_POLICY,
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

/**
 * Round 4. The policy engine decides *that* a ticket escalates and *why*; the
 * `escalate` tool is how the agent says so. If the engine can reach a
 * conclusion the tool cannot express, the agent is forced to either drop the
 * real reason or substitute a different one — and escalation reasons are what
 * Mission Control's escalation-rate breakdown is built from, so a substituted
 * reason is a wrong number on a dashboard rather than a caught error.
 *
 * The divergence was real and had two shapes. `evaluateEscalation` can return
 * `unknown_customer`, and (since Round 3 added it) `unknown_customer_value`;
 * the tool enum offered neither. And the engine's `refund_denied_by_policy`
 * appeared in the enum under the different name `policy_denied` — the same
 * concept spelled two ways across a module boundary, which is how the next
 * reader concludes they are different things.
 *
 * Asserted as a set difference rather than a pinned list on purpose: a pinned
 * list has to be remembered, and this one was not. The test names the
 * *invariant* — the tool's vocabulary is a superset of the engine's — so the
 * next reason added to the policy fails here until it is expressible.
 */
describe("the escalate tool can express every reason the policy engine emits", () => {
  // Read off the wire spec rather than the Zod definition: what the model is
  // actually offered is what determines whether a reason is expressible.
  const escalateReasons = new Set(
    (
      registry.toAnthropicTools().find((t) => t.name === "escalate")!
        .input_schema.properties as { reason: { enum: string[] } }
    ).reason.enum,
  );

  it("offers a value for every EscalationReason", () => {
    const missing = ESCALATION_REASONS.filter((r) => !escalateReasons.has(r));
    expect(missing).toEqual([]);
  });

  /**
   * The converse is deliberately *not* asserted. The tool may legitimately
   * offer more than the engine emits — `missing_information` and
   * `out_of_scope` are conclusions the model reaches from the ticket text,
   * which no policy rule computes. Superset, not equality.
   */
  it("also keeps the model-observed reasons the engine cannot compute", () => {
    expect(escalateReasons).toContain("missing_information");
    expect(escalateReasons).toContain("out_of_scope");
  });
});


/* -------------------------------------------------------------------------- */
/* Stripped constraints have to survive somewhere the model reads              */
/* -------------------------------------------------------------------------- */

/**
 * FAILURES 19 turned `strict` off by default, and the follow-up logged at the
 * time claimed the constraint stripping had become gratuitous — that the model
 * was now told `amount_cents` is a bare `number`. Measuring it says otherwise,
 * and the measurement is the interesting part.
 *
 * `type` was never on the strip list, so the model is told `integer`. Across
 * all nine tools exactly eight keywords are stripped, and seven of them are
 * Zod's MAX_SAFE_INTEGER boilerplate — `maximum: 9007199254740991` and its
 * negative twin on every `z.number().int()`. Restoring those would add noise to
 * the cached prompt prefix and tell the model nothing it can use.
 *
 * Exactly **one** carries real signal: `exclusiveMinimum: 0` on
 * `issue_refund.amount_cents`. So the fix is not a conditional-stripping
 * mechanism — that would trade one piece of signal for seven of noise. It is
 * that a constraint worth keeping must be restated where the model actually
 * reads it, which is the description. Descriptions are the single biggest lever
 * on tool-call quality; a keyword the wire format drops is not.
 */
describe("a stripped constraint is restated in the description", () => {
  const registry = buildRegistry(TOOLS);

  it("tells the model the refund amount must be positive", () => {
    const spec = registry
      .toAnthropicTools()
      .find((s) => s.name === "issue_refund")!;
    const amount = spec.input_schema.properties.amount_cents as {
      description: string;
    };

    // Confirms the premise rather than assuming it: the keyword really is gone.
    expect(amount).not.toHaveProperty("exclusiveMinimum");
    expect(amount.description).toMatch(/positive|greater than zero/i);
  });

  /**
   * The other seven strips are noise, and this fails if someone "restores the
   * constraints" wholesale — which was the tempting and wrong version of this
   * fix, and the one the original follow-up note called for.
   */
  it("does not carry Zod's MAX_SAFE_INTEGER bounds into the prompt prefix", () => {
    const json = JSON.stringify(registry.toAnthropicTools());
    expect(json).not.toContain("9007199254740991");
  });
});
