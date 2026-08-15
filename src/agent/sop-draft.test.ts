import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  MAX_REFUND_CEILING_CENTS,
  MAX_REFUND_WINDOW_DAYS,
} from "@/policy/refund";

import { UnknownPlaceholderError } from "./sop";
import { SopDraftError, validateSopDraft } from "./sop-draft";

/**
 * The editor is the first thing that writes to `sop_versions`, which makes it
 * the first untrusted writer to the column `issue_refund` revalidates against.
 * Everything the boot validator does for tools, this does for policy — and it
 * has to happen *before* the row is written, because an activated version is
 * the live system prompt the moment it lands.
 *
 * Two failure modes, both silent without this:
 *
 * A typo'd placeholder (`{{refund.windowDay}}`) survives into the prompt as a
 * literal, which the model reads as an instruction nobody wrote.
 *
 * A well-formed policy with absurd figures parses fine — a $999,999.99 ceiling
 * is valid JSON and valid types. Round 4 caught exactly that, which is why the
 * absolute caps exist; the editor must enforce them at the door rather than
 * trusting whoever is typing.
 */

const goodMarkdown = "Window is {{refund.windowDays}} days, cap {{refund.maxRefund}}.";

describe("validateSopDraft", () => {
  it("returns the parsed draft when markdown and policy are both sound", () => {
    const draft = validateSopDraft({
      bodyMarkdown: goodMarkdown,
      policyConfig: DEFAULT_POLICY,
    });

    expect(draft.policyConfig.refund.windowDays).toBe(30);
    expect(draft.bodyMarkdown).toBe(goodMarkdown);
  });

  it("accepts the window flip that demo arc step 2 depends on", () => {
    const draft = validateSopDraft({
      bodyMarkdown: goodMarkdown,
      policyConfig: {
        ...DEFAULT_POLICY,
        refund: { ...DEFAULT_POLICY.refund, windowDays: 14 },
      },
    });

    expect(draft.policyConfig.refund.windowDays).toBe(14);
  });

  /**
   * The compile has to run at save time, not at request time. Deferring it
   * means the bad version is already active and every run fails until someone
   * edits it back — with the failure surfacing in the agent loop, far from the
   * edit that caused it.
   */
  it("rejects an unknown placeholder before the version is written", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: "window is {{refund.windowDay}} days",
        policyConfig: DEFAULT_POLICY,
      }),
    ).toThrow(UnknownPlaceholderError);
  });

  it("rejects a refund ceiling above the absolute cap", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: goodMarkdown,
        policyConfig: {
          ...DEFAULT_POLICY,
          refund: {
            ...DEFAULT_POLICY.refund,
            maxRefundCents: MAX_REFUND_CEILING_CENTS + 1,
            maxAutoApproveCents: 1_000,
          },
        },
      }),
    ).toThrow(SopDraftError);
  });

  it("rejects a refund window beyond a year", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: goodMarkdown,
        policyConfig: {
          ...DEFAULT_POLICY,
          refund: {
            ...DEFAULT_POLICY.refund,
            windowDays: MAX_REFUND_WINDOW_DAYS + 1,
          },
        },
      }),
    ).toThrow(SopDraftError);
  });

  /**
   * The injection guardrail is pinned to the literal `true` in the type, so the
   * compiler refuses `false` at every call site. The editor is the one place
   * where the value arrives as untyped JSON from a form, so the check has to be
   * a runtime one too — demo arc step 4 rests on it.
   */
  it("rejects a policy that switches off the injection guardrail", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: goodMarkdown,
        policyConfig: {
          ...DEFAULT_POLICY,
          escalation: {
            ...DEFAULT_POLICY.escalation,
            escalateOnSuspectedInjection: false as unknown as true,
          },
        },
      }),
    ).toThrow(SopDraftError);
  });

  it("rejects an auto-approve ceiling above the refund ceiling", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: goodMarkdown,
        policyConfig: {
          ...DEFAULT_POLICY,
          refund: {
            ...DEFAULT_POLICY.refund,
            maxAutoApproveCents: 40_000,
            maxRefundCents: 20_000,
          },
        },
      }),
    ).toThrow(SopDraftError);
  });

  it("rejects an empty document rather than activating a blank prompt", () => {
    expect(() =>
      validateSopDraft({ bodyMarkdown: "   \n  ", policyConfig: DEFAULT_POLICY }),
    ).toThrow(SopDraftError);
  });

  it("carries a message naming what to fix", () => {
    expect(() =>
      validateSopDraft({
        bodyMarkdown: goodMarkdown,
        policyConfig: {
          ...DEFAULT_POLICY,
          refund: { ...DEFAULT_POLICY.refund, windowDays: 9_999 },
        },
      }),
    ).toThrow(/windowDays/);
  });
});
