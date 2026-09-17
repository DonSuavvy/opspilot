/**
 * Every string and every link on the landing page, in one typed object.
 *
 * The page itself (`src/app/page.tsx`) and its section components read this
 * and render it; none of them own copy. That split is what makes
 * `copy.test.ts` exhaustive over "every string on the page" without needing
 * to render anything, and it means a wording change never touches JSX.
 */

export interface LinkItem {
  label: string;
  href: string;
}

export interface ArcStep {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}

export interface DiagramNode {
  label: string;
  detail: string;
}

export interface HonestyCard {
  title: string;
  description: string;
}

export const landingCopy = {
  brand: "OpsPilot",

  nav: [
    { label: "Demo", href: "/inbox" },
    { label: "SOP", href: "/sop" },
    { label: "Evals", href: "/evals" },
    { label: "Approvals", href: "/approvals" },
    { label: "Mission control", href: "/ops" },
    { label: "GitHub", href: "https://github.com/DonSuavvy/opspilot" },
  ] satisfies LinkItem[],

  hero: {
    headline:
      "An AI agent that runs a fictional SaaS company's support and billing back office.",
    subhead: "The reliability engineering is the product.",
    principles: [
      "The SOP is a versioned prompt you can edit.",
      "Every run is traced span by span.",
      "Anything that moves money waits for a human.",
      "The eval suite runs in CI on every prompt change.",
    ],
    primaryCta: { label: "Run the demo", href: "/inbox" } satisfies LinkItem,
    secondaryCta: {
      label: "Read the SOP",
      href: "/sop",
    } satisfies LinkItem,
  },

  arc: {
    title: "The 3-minute arc",
    steps: [
      {
        title: "Inject a ticket",
        description:
          "Watch the agent resolve it live, with a streaming trace of every span.",
        href: "/inbox",
        linkLabel: "Open the inbox",
      },
      {
        title: "Edit the SOP",
        description:
          "Change the refund window from 30 days to 14, then re-run the same ticket. The decision changes.",
        href: "/sop",
        linkLabel: "Edit the SOP",
      },
      {
        title: "Run the eval suite",
        description:
          "One case regresses. The diff shows why. Fix it, and the suite goes green.",
        href: "/evals",
        linkLabel: "Open the eval lab",
      },
      {
        title: "Inject the adversarial ticket",
        description:
          "The injection is flagged at span 0, the money tools are withheld, and the run escalates.",
        href: "/inbox",
        linkLabel: "Open the inbox",
      },
    ] satisfies ArcStep[],
  },

  architecture: {
    title: "How it is built",
    pipeline: [
      { label: "Browser", detail: "starts a run, watches the trace" },
      {
        label: "Next.js route handlers",
        detail: "stream the trace back as SSE",
      },
      { label: "Hand-rolled tool loop", detail: "the seam under test" },
    ] satisfies DiagramNode[],
    streamLabel: "SSE",
    fanOutLabel: "fans out to",
    fanOut: [
      { label: "Policy engine", detail: "pure function, no I/O" },
      { label: "Nine tools", detail: "read, auto-write, confirm-write" },
      { label: "Postgres", detail: "via Drizzle" },
    ] satisfies DiagramNode[],
    approvalLabel: "confirm-write pauses into",
    downstream: [
      {
        label: "Approval queue",
        detail: "a human approves or denies",
      },
      {
        label: "Eval suite",
        detail: "the golden cases, pinned and scored",
      },
    ] satisfies DiagramNode[],
    ci: {
      label: "CI",
      detail: "runs on every prompt change",
    } satisfies DiagramNode,
    facts: [
      "The loop is hand-rolled, so a paused run can be serialized mid-loop and resumed in a later serverless invocation.",
      "The public demo runs Claude Haiku 4.5 on Bedrock.",
      "Scoring is deterministic, so a regression is a diff, not an opinion.",
    ],
  },

  honesty: {
    title: "What keeps it honest",
    cards: [
      {
        title: "Budget guard",
        description:
          "A global daily cap, per-sandbox and global rate limits, a kill switch, and an honest banner when intake pauses.",
      },
      {
        title: "Injection guardrail",
        description:
          "A scan at span 0 flags a ticket before any tool fires. A flagged run loses its confirm-write tools and escalates with the reason.",
      },
      {
        title: "Approval queue",
        description:
          "A confirm-write call pauses the run. A human approves or denies it. The decision is a conditional update, so two reviewers cannot both win.",
      },
    ] satisfies HonestyCard[],
  },

  sandbox: {
    title: "Your sandbox",
    paragraphs: [
      "Every visitor gets an isolated, freshly seeded workspace tied to a cookie.",
      "It expires after 24 hours, and a daily sweep removes it.",
      "The Reset button on the demo page reseeds it.",
    ],
  },

  footer: {
    docs: [
      {
        label: "Plan",
        href: "https://github.com/DonSuavvy/opspilot/blob/main/docs/PLAN.md",
      },
      {
        label: "Evals",
        href: "https://github.com/DonSuavvy/opspilot/blob/main/docs/EVALS.md",
      },
      {
        label: "Security",
        href: "https://github.com/DonSuavvy/opspilot/blob/main/docs/SECURITY.md",
      },
      {
        label: "Failures",
        href: "https://github.com/DonSuavvy/opspilot/blob/main/docs/FAILURES.md",
      },
    ] satisfies LinkItem[],
    credit: "A portfolio project by Sebastian Atencia.",
  },
};
