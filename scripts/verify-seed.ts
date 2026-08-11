/**
 * Day 1 gate evidence: the seeded database supports the demo arc.
 *
 * Unit tests prove the policy engine flips on synthetic fixtures. This proves
 * it flips on the rows the seed actually wrote — which is what the demo shows.
 *
 * Requires a database. Deliberately NOT a vitest test: `npm test` must stay
 * green in CI without provisioning Postgres.
 *
 * Run: npm run db:up && npm run db:migrate && npm run db:seed && npm run verify:seed
 */
import { config } from "dotenv";
import { and, eq, sql } from "drizzle-orm";

import { DEFAULT_POLICY, evaluateRefund } from "../src/policy/refund";
import { closeDb, getDb } from "../src/db/client";
import {
  customers,
  invoices,
  kbArticles,
  tickets,
  workspaces,
} from "../src/db/schema";

config({ path: ".env.local" });

let failures = 0;

function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${message}`);
    failures += 1;
  }
}

async function main() {
  const db = getDb();
  const now = new Date();

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, "demo"));

  if (!workspace) throw new Error("demo workspace missing — run npm run db:seed");

  console.log("\n\x1b[1m1. Row counts\x1b[0m");

  const [{ n: customerCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(eq(customers.workspaceId, workspace.id));
  const [{ n: invoiceCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.workspaceId, workspace.id));
  const [{ n: kbCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kbArticles)
    .where(eq(kbArticles.workspaceId, workspace.id));
  const [{ n: ticketCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(eq(tickets.workspaceId, workspace.id));

  check(customerCount === 30, `30 customers (got ${customerCount})`);
  check(invoiceCount > 0, `${invoiceCount} invoices`);
  check(kbCount === 20, `20 KB articles (got ${kbCount})`);
  check(ticketCount === 8, `8 tickets (got ${ticketCount})`);

  /* ---------------------------------------------------------------------- */

  console.log(
    "\n\x1b[1m2. Demo arc step 2 — the 30 -> 14 refund window flip\x1b[0m",
  );

  const fixtures = ["INV-2001", "INV-2002", "INV-2003"] as const;
  const expected = {
    "INV-2001": { at30: "approve", at14: "approve" },
    "INV-2002": { at30: "approve", at14: "deny" }, // the flip
    "INV-2003": { at30: "deny", at14: "deny" },
  } as const;

  for (const number of fixtures) {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.workspaceId, workspace.id),
          eq(invoices.number, number),
        ),
      );

    if (!invoice) {
      check(false, `${number} present in seed`);
      continue;
    }

    const evaluateAt = (windowDays: number) =>
      evaluateRefund({
        invoice: {
          id: invoice.id,
          status: invoice.status,
          amountCents: invoice.amountCents,
          refundedCents: invoice.refundedCents,
          paidAt: invoice.paidAt,
        },
        requestedCents: invoice.amountCents,
        reason: "service_issue",
        now,
        policy: {
          ...DEFAULT_POLICY,
          refund: { ...DEFAULT_POLICY.refund, windowDays },
        },
      });

    const at30 = evaluateAt(30);
    const at14 = evaluateAt(14);
    const want = expected[number];
    const age = at30.ageDays === null ? "n/a" : at30.ageDays.toFixed(1);

    check(
      at30.outcome === want.at30 && at14.outcome === want.at14,
      `${number} (paid ${age}d ago): 30d -> ${at30.outcome}, 14d -> ${at14.outcome}` +
        ` (want ${want.at30} / ${want.at14})`,
    );
  }

  const [flipInvoice] = await db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.workspaceId, workspace.id), eq(invoices.number, "INV-2002")),
    );
  const flipAge = flipInvoice
    ? (now.getTime() - flipInvoice.paidAt!.getTime()) / 86_400_000
    : 0;
  check(
    flipAge > 14 && flipAge <= 30,
    `INV-2002 sits strictly between the two windows (${flipAge.toFixed(1)}d)` +
      ` — without this the demo shows nothing`,
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m3. Duplicate charge is always refundable\x1b[0m");
  const dupes = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, workspace.id),
        sql`${invoices.number} in ('INV-2004','INV-2005')`,
      ),
    );
  check(dupes.length === 2, `two invoices for the same period (got ${dupes.length})`);
  check(
    dupes.length === 2 && dupes[0].amountCents === dupes[1].amountCents,
    "identical amounts, as a real duplicate charge would be",
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m4. Postgres full-text search (generated tsvector + GIN)\x1b[0m");

  const hits = await db
    .select({ slug: kbArticles.slug, title: kbArticles.title })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.workspaceId, workspace.id),
        sql`${kbArticles.searchVector} @@ plainto_tsquery('english', 'rotate api key')`,
      ),
    )
    .orderBy(
      sql`ts_rank(${kbArticles.searchVector}, plainto_tsquery('english','rotate api key')) desc`,
    );

  check(hits.length > 0, `"rotate api key" matched ${hits.length} article(s)`);
  check(
    hits[0]?.slug === "rotate-api-key",
    `top hit is the right article (got ${hits[0]?.slug ?? "none"})`,
  );

  const refundHits = await db
    .select({ slug: kbArticles.slug })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.workspaceId, workspace.id),
        sql`${kbArticles.searchVector} @@ plainto_tsquery('english', 'charged twice')`,
      ),
    );
  check(
    refundHits.some((h) => h.slug === "duplicate-charge"),
    `"charged twice" finds the duplicate-charge article`,
  );

  /* ---------------------------------------------------------------------- */

  console.log("\n\x1b[1m5. Adversarial ticket is present and pre-flagged\x1b[0m");
  const [adversarial] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.workspaceId, workspace.id),
        eq(tickets.suspectedInjection, true),
      ),
    );
  check(Boolean(adversarial), "one ticket flagged by the injection pre-scan");
  check(
    adversarial?.body.includes("Ignore all previous instructions") ?? false,
    "carries a real injection payload for the Day 7 guardrail test",
  );

  console.log(
    failures === 0
      ? "\n\x1b[32m\x1b[1mSeed verification: PASS\x1b[0m\n"
      : `\n\x1b[31m\x1b[1mSeed verification: ${failures} FAILURE(S)\x1b[0m\n`,
  );
  return failures;
}

main()
  .then(async (f) => {
    await closeDb();
    process.exit(f === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
