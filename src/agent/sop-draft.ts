/**
 * Validating an edited SOP before it becomes the live prompt.
 *
 * The editor is the first untrusted writer to `sop_versions` — the row that
 * carries both what the model is told and what `issue_refund` revalidates
 * against. So this is the boot validator's equivalent for policy, and it has to
 * run *before* the insert: an activated version is the system prompt from the
 * moment it lands, and a bad one fails inside the agent loop, far from the edit
 * that caused it.
 *
 * Everything here is pure. The DB write in `src/db/sops.ts` calls it first and
 * refuses to insert if it throws.
 */
import { parsePolicyConfig, type PolicyConfig } from "@/policy/refund";

import { compileSop } from "./sop";

/** A draft that is structurally wrong. Placeholder errors keep their own type. */
export class SopDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SopDraftError";
  }
}

export interface SopDraft {
  bodyMarkdown: string;
  policyConfig: PolicyConfig;
}

/**
 * Check a draft and return it parsed, or throw.
 *
 * Order matters. The policy is parsed first because its Zod schema carries the
 * absolute caps — a window of 9,999 days or a $999,999.99 ceiling is rejected
 * here rather than by the compile, which would happily render either. Then the
 * markdown is compiled against the *parsed* policy, so an unknown placeholder
 * surfaces at save time with the same error the request path would raise.
 *
 * The compile result is discarded on purpose: this is a rehearsal, not the
 * render. The row stores the document unsubstituted, because substituting at
 * save time is precisely the drift bug this whole feature removed.
 */
export function validateSopDraft(input: {
  bodyMarkdown: string;
  policyConfig: unknown;
}): SopDraft {
  if (input.bodyMarkdown.trim().length === 0) {
    throw new SopDraftError(
      "the SOP document is empty — an active version with no body would ship a blank system prompt",
    );
  }

  let policyConfig: PolicyConfig;
  try {
    policyConfig = parsePolicyConfig(input.policyConfig);
  } catch (error) {
    // Zod's message names the offending path, which is the useful half for
    // someone staring at a form. Rewrapped so callers catch one type.
    throw new SopDraftError(
      `policy is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Rehearse the render. Throws UnknownPlaceholderError, which the API surfaces
  // verbatim — it already names the bad token and the known vocabulary.
  compileSop({ bodyMarkdown: input.bodyMarkdown, policyConfig });

  return { bodyMarkdown: input.bodyMarkdown, policyConfig };
}
