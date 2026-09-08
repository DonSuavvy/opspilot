/**
 * The regression diff — demo arc step 3's payoff.
 *
 * `/evals/diff?base=<older>&head=<newer>`. A server component over the pure
 * `diffEvalRuns`: this page decides nothing, it only loads two runs and renders
 * five buckets.
 *
 * A static segment beats a dynamic one in the App Router, so this route wins
 * over `/evals/[id]` and "diff" is never read as a run id.
 *
 * Bucket order is regressed, fixed, added, removed, unchanged. Regressed is
 * first because it is the only bucket that blocks a merge, and unchanged is
 * last and collapsed because on a healthy suite it is seven of the eight rows
 * and would push the finding off the screen.
 */
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { getEvalRun, type EvalRunDetail } from "@/db/evals";
import { diffEvalRuns } from "@/evals/diff";
import type { CaseDiff } from "@/evals/types";
import { compactJson, shortSha, sopLabel } from "@/lib/eval-labels";

export const dynamic = "force-dynamic";

/**
 * Null for absent, repeated or malformed. A query string can carry the same
 * key twice, and `?base=a&base=b` arrives as an array — comparing against
 * whichever half happened to be first would render a diff the URL did not ask
 * for.
 */
function one(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  return null;
}

/** Same catch as the detail page: a uuid column throws on a malformed id. */
async function loadRun(id: string): Promise<EvalRunDetail | null> {
  try {
    return await getEvalRun(getDb(), id);
  } catch {
    return null;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">{children}</main>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <Shell>
      <h1 className="text-2xl font-semibold tracking-tight">Eval diff</h1>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">{message}</p>
      <p className="mt-4 text-sm">
        <Link href="/evals" className="text-zinc-500 underline">
          back to the eval lab
        </Link>
      </p>
    </Shell>
  );
}

/**
 * The before/after table for one case's flips.
 *
 * `actual` and the verdict, not `expected`: the expectation is the same on
 * both sides of a diff by construction — it is what the case asserts — so a
 * column for it would repeat one value down the page and crowd out the two
 * that moved.
 */
function Flips({ flips }: { flips: CaseDiff["flips"] }) {
  if (flips.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        The verdict moved with no assertion-level change recorded.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-zinc-500">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="py-1 pr-4 font-medium">Assertion</th>
            <th className="py-1 pr-4 font-medium">Before</th>
            <th className="py-1 pr-4 font-medium">After</th>
            <th className="py-1 pr-4 font-medium">Was</th>
            <th className="py-1 font-medium">Now</th>
          </tr>
        </thead>
        <tbody>
          {flips.map((flip) => (
            <tr
              key={flip.name}
              className="border-b border-zinc-100 dark:border-zinc-900"
            >
              <td className="py-1 pr-4 font-mono whitespace-nowrap">
                {flip.name}
              </td>
              <td className="py-1 pr-4 font-mono">
                {compactJson(flip.before?.actual)}
              </td>
              <td className="py-1 pr-4 font-mono">
                {compactJson(flip.after?.actual)}
              </td>
              <td className="py-1 pr-4">
                {flip.before === null ? "—" : flip.before.passed ? "pass" : "fail"}
              </td>
              <td className="py-1">
                {flip.after === null ? "—" : flip.after.passed ? "pass" : "fail"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseCard({ diff, withFlips }: { diff: CaseDiff; withFlips: boolean }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{diff.title}</span>
        <span className="font-mono text-xs text-zinc-400">{diff.slug}</span>
      </div>
      {diff.after?.failureReason ? (
        <p className="text-sm text-red-700 dark:text-red-300">
          {diff.after.failureReason}
        </p>
      ) : null}
      {withFlips ? <Flips flips={diff.flips} /> : null}
    </li>
  );
}

function Bucket({
  title,
  cases,
  withFlips,
  collapsed,
}: {
  title: string;
  cases: CaseDiff[];
  withFlips: boolean;
  collapsed: boolean;
}) {
  const heading = `${title} (${cases.length})`;

  const body =
    cases.length === 0 ? (
      <p className="text-sm text-zinc-500">Nothing in this bucket.</p>
    ) : (
      <ol className="flex flex-col gap-3">
        {cases.map((diff) => (
          <CaseCard key={diff.slug} diff={diff} withFlips={withFlips} />
        ))}
      </ol>
    );

  if (collapsed) {
    return (
      <details className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <summary className="cursor-pointer text-sm font-semibold tracking-tight">
          {heading}
        </summary>
        <div className="mt-3">{body}</div>
      </details>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-tight">{heading}</h2>
      {body}
    </section>
  );
}

function runName(detail: EvalRunDetail): string {
  return `${sopLabel(detail.run)} · ${shortSha(detail.run.gitSha)}`;
}

export default async function EvalDiffPage(props: PageProps<"/evals/diff">) {
  const params = await props.searchParams;
  const baseId = one(params.base);
  const headId = one(params.head);

  if (!baseId || !headId) {
    return (
      <Problem message="This page needs two runs: base and head. Open it from the run history, where the link carries both ids." />
    );
  }

  const [base, head] = await Promise.all([loadRun(baseId), loadRun(headId)]);

  if (!base || !head) {
    const missing = !base && !head ? "Neither run" : !base ? "The base run" : "The head run";
    return (
      <Problem
        message={`${missing} could be found. The id may be wrong, or the run may have been deleted with its workspace.`}
      />
    );
  }

  const diff = diffEvalRuns(base.results, head.results);

  return (
    <Shell>
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Eval diff</h1>
          <Link href="/evals" className="text-sm text-zinc-500 underline">
            back to the eval lab
          </Link>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={`/evals/${base.run.id}`}
            className="font-mono text-zinc-500 underline"
          >
            {runName(base)}
          </Link>
          <span className="text-zinc-400">to</span>
          <Link
            href={`/evals/${head.run.id}`}
            className="font-mono text-zinc-500 underline"
          >
            {runName(head)}
          </Link>
          <Badge variant="outline">
            {base.run.passedCases}/{base.run.totalCases} to{" "}
            {head.run.passedCases}/{head.run.totalCases}
          </Badge>
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <Bucket
          title="Regressed"
          cases={diff.regressed}
          withFlips
          collapsed={false}
        />
        <Bucket title="Fixed" cases={diff.fixed} withFlips collapsed={false} />
        <Bucket
          title="Added"
          cases={diff.added}
          withFlips={false}
          collapsed={false}
        />
        <Bucket
          title="Removed"
          cases={diff.removed}
          withFlips={false}
          collapsed={false}
        />
        <Bucket
          title="Unchanged"
          cases={diff.unchanged}
          withFlips={false}
          collapsed
        />
      </div>
    </Shell>
  );
}
