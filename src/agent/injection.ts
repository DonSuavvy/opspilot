/**
 * Deterministic prompt-injection pre-scan.
 *
 * This runs before the model sees the ticket, and it is the only layer in the
 * injection story that cannot itself be talked out of its job: no network, no
 * model call, no clock, no database. Given the same ticket it returns the same
 * answer forever, which is what lets the eval suite assert on it.
 *
 * It is a heuristic and it is meant to be one. The real guarantees live in the
 * layers behind it — the ticket is wrapped as data in `prompt.ts`, the SOP
 * tells the model to ignore instructions found in a ticket, refund limits are
 * revalidated in the handler, and confirm-write tools pause for a human. The
 * scan exists so a flagged run can be *narrowed* before any of that is tested,
 * and so the trace can say plainly what was seen.
 *
 * Precision matters more than recall here. A false positive strips a real
 * customer's refund of its tooling; a false negative still meets every control
 * downstream. That asymmetry is why one weak signal is reported but does not
 * flag.
 */

/** The signal names, in the fixed order they are reported. */
export const INJECTION_SIGNALS = [
  "ignore_instructions",
  "override_claim",
  "authority_claim",
  "approval_bypass",
  "confirm_processed",
] as const;

export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];

export interface InjectionScanInput {
  subject: string;
  body: string;
}

export interface InjectionScanResult {
  flagged: boolean;
  signals: string[];
}

/**
 * The only strong signal. A ticket that tells the agent to drop its
 * instructions is not a customer with an unusual turn of phrase, so it flags
 * on its own. Everything else needs corroboration.
 */
const STRONG_SIGNAL: InjectionSignal = "ignore_instructions";

/**
 * Patterns are matched against text that has been lowercased and had every run
 * of whitespace collapsed to a single space, so a directive split across a line
 * break ("Do not\nescalate") reads the same as one that is not. Write them
 * against that normalised form: single spaces, no anchors, no `\s`.
 */
const PATTERNS: ReadonlyArray<{
  readonly name: InjectionSignal;
  readonly patterns: readonly RegExp[];
}> = [
  {
    name: "ignore_instructions",
    patterns: [
      /ignore (all |any )?(previous|prior|your|the) instructions/,
      /disregard (your|the) (sop|instructions|policy|procedure)/,
    ],
  },
  {
    name: "override_claim",
    patterns: [
      /system override/,
      /administrator notice/,
      /admin(istrator)? override/,
      /developer mode/,
    ],
  },
  {
    name: "authority_claim",
    patterns: [
      /you are authori[sz]ed/,
      /policy has been suspended/,
      /(director|manager|ceo) has (approved|authori[sz]ed)/,
    ],
  },
  {
    name: "approval_bypass",
    patterns: [
      /without approval/,
      /do not escalate/,
      /skip (the )?approval/,
      /no approval (is )?(needed|required)/,
    ],
  },
  {
    name: "confirm_processed",
    patterns: [
      /confirm (that )?(the )?(refund|payment|credit) (has been|was|is) processed/,
    ],
  },
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Scan a ticket's subject and body for text aimed at the agent rather than at
 * a human reading the ticket.
 *
 * Returns the signals that fired, named and in a fixed order, each at most
 * once. `flagged` is true when the strong signal is present or when two or more
 * distinct signals corroborate each other.
 */
export function scanForInjection(input: InjectionScanInput): InjectionScanResult {
  // The subject is scanned too: it is model-visible and attacker-controlled,
  // and an injection there with an innocent body would otherwise sail through.
  const text = normalise(`${input.subject} ${input.body}`);

  const signals: string[] = [];
  for (const { name, patterns } of PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      signals.push(name);
    }
  }

  const flagged =
    signals.includes(STRONG_SIGNAL) || signals.length >= 2;

  return { flagged, signals };
}
