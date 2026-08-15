/**
 * The SOP compiler — the piece that makes "the SOP *is* the prompt" true.
 *
 * `sop_versions` stores two halves of one policy in a single row:
 * `bodyMarkdown` is what the model reads, `policyConfig` is what the
 * `issue_refund` handler revalidates against. The schema comment says they
 * "cannot drift apart across an edit" because they are versioned together —
 * true of the *row*, but not of the *figures*, because the seed interpolated
 * `DEFAULT_POLICY` into the markdown at seed time and froze them into a string.
 *
 * Flip the window 30 -> 14 in `policyConfig` and the handler enforces 14 while
 * the prose still says thirty. The refund is denied for a rule the model was
 * never told, which is the one outcome demo arc step 2 must not have: it looks
 * exactly like a working demo and demonstrates nothing.
 *
 * So the markdown carries placeholders and the figures are substituted here,
 * from the same row, at compile time. One source of truth, no drift possible.
 */
import type { PolicyConfig } from "@/policy/refund";

/**
 * Every placeholder the markdown may use, and how each renders.
 *
 * A closed vocabulary rather than arbitrary path lookup: the editor validates
 * against this list before saving, and an unknown token fails at compile time
 * instead of reaching the model. Values are pre-formatted for prose — cents
 * become dollars here, so no SOP author has to divide by 100 correctly.
 */
const RENDERERS: Readonly<
  Record<string, (policy: PolicyConfig) => string>
> = {
  "refund.windowDays": (p) => String(p.refund.windowDays),
  "refund.maxAutoApprove": (p) => usd(p.refund.maxAutoApproveCents),
  "refund.maxRefund": (p) => usd(p.refund.maxRefundCents),
  "escalation.churnRiskLtv": (p) => usd(p.escalation.churnRiskLtvCents),
};

export const SOP_PLACEHOLDERS: readonly string[] = Object.freeze(
  Object.keys(RENDERERS),
);

/**
 * Cents to `$1,234.56`.
 *
 * Pinned to `en-US` explicitly. `toLocaleString` with no locale reads the host
 * environment, which would make the compiled prompt — and therefore the prompt
 * cache key — differ between a developer's laptop and the Vercel runtime.
 */
function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export class UnknownPlaceholderError extends Error {
  readonly placeholder: string;

  constructor(placeholder: string) {
    super(
      `unknown SOP placeholder {{${placeholder}}} — known placeholders are ` +
        `${SOP_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}`,
    );
    this.name = "UnknownPlaceholderError";
    this.placeholder = placeholder;
  }
}

/** `{{ anything.without.braces }}`, tolerant of surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export interface CompileSopInput {
  bodyMarkdown: string;
  policyConfig: PolicyConfig;
}

/**
 * Render one SOP version into the system prompt the model receives.
 *
 * Pure and deterministic — no clock, no I/O. The policy engine takes `now` as
 * an argument for the same reason; here it matters twice over, because a
 * prompt that varies between two runs of the same SOP version also changes the
 * prompt-cache key and silently drops the hit rate to zero.
 */
export function compileSop({
  bodyMarkdown,
  policyConfig,
}: CompileSopInput): string {
  return bodyMarkdown.replace(PLACEHOLDER, (_match, name: string) => {
    const render = RENDERERS[name];
    if (!render) {
      throw new UnknownPlaceholderError(name);
    }
    return render(policyConfig);
  });
}

/* The cache floor, prefix marking, and hit reporting live in `./cache`. */
