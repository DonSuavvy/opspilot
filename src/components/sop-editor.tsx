"use client";

/**
 * The SOP editor — demo arc step 2.
 *
 * The point of the screen is that editing *this* changes what the agent does.
 * So the policy fields and the document sit side by side and save together into
 * one new version: they are two halves of one row, and the whole Day 4 story is
 * that they cannot drift apart.
 *
 * Saving is append-only. Every save is a new version and the diff below shows
 * what moved, which is what makes "edit the SOP, re-run the ticket" legible to
 * someone watching rather than a claim they have to take on faith.
 */
import { useCallback, useState } from "react";

import { compileSop, SOP_PLACEHOLDERS, UnknownPlaceholderError } from "@/agent/sop";
import type { PolicyConfig } from "@/policy/refund";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface VersionSummary {
  versionId: string;
  version: number;
  changelog: string;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
}

interface ActiveSop {
  versionId: string;
  version: number;
  bodyMarkdown: string;
  policyConfig: PolicyConfig;
}

/** Cents in the row, dollars in the form — nobody edits a policy in cents. */
const toDollars = (cents: number) => (cents / 100).toFixed(2);
const toCents = (dollars: string) => Math.round(Number(dollars) * 100);

/**
 * Line diff, computed on the compiled prompts rather than the raw markdown.
 *
 * Diffing the source would show `{{refund.windowDays}}` on both sides and hide
 * the only thing that changed. What matters is what the *model* reads, so both
 * sides are rendered against their own policy first — a pure policy edit with
 * no prose change still shows up as a changed line, which is exactly demo arc
 * step 2.
 */
function diffLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const rows: { tone: "same" | "removed" | "added"; text: string }[] = [];
  const max = Math.max(a.length, b.length);

  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      if (left !== undefined) rows.push({ tone: "same", text: left });
      continue;
    }
    if (left !== undefined) rows.push({ tone: "removed", text: left });
    if (right !== undefined) rows.push({ tone: "added", text: right });
  }
  return rows;
}

/**
 * Initial data arrives as props from the server component — not from a
 * `useEffect` fetch. That keeps the first paint populated instead of flashing a
 * loading state, and it is what the App Router is for. After a save the client
 * updates from the POST response, which is an event handler rather than an
 * effect, so no state is ever derived from a render.
 */
export function SopEditor({
  initialActive,
  initialVersions,
}: {
  initialActive: ActiveSop;
  initialVersions: VersionSummary[];
}) {
  const [active, setActive] = useState<ActiveSop>(initialActive);
  const [versions, setVersions] = useState<VersionSummary[]>(initialVersions);
  const [markdown, setMarkdown] = useState(initialActive.bodyMarkdown);
  const [policy, setPolicy] = useState<PolicyConfig>(initialActive.policyConfig);
  const [changelog, setChangelog] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  /**
   * Compiled live, in the browser, from the same pure function the request path
   * uses. An unknown placeholder shows up as you type rather than on save —
   * and, more importantly, the preview is the actual prompt, not an
   * approximation of it.
   */
  let preview = "";
  let previewError: string | null = null;
  try {
    preview = compileSop({ bodyMarkdown: markdown, policyConfig: policy });
  } catch (caught) {
    previewError =
      caught instanceof UnknownPlaceholderError ? caught.message : String(caught);
  }

  let baseline: string;
  try {
    baseline = compileSop({
      bodyMarkdown: active.bodyMarkdown,
      policyConfig: active.policyConfig,
    });
  } catch {
    // A stored version that no longer compiles still has to render its left
    // side, or the diff that would explain the breakage is the thing that hides.
    baseline = active.bodyMarkdown;
  }

  const dirty =
    markdown !== active.bodyMarkdown ||
    JSON.stringify(policy) !== JSON.stringify(active.policyConfig);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/sop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyMarkdown: markdown,
          policyConfig: policy,
          changelog,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "save failed");
      // Rebase on what was actually stored, not on what was typed: the round
      // trip is the only thing that knows the new version number, and it is
      // what makes the diff's left-hand side the newly-active version.
      setActive(data.active);
      setVersions(data.versions);
      setMarkdown(data.active.bodyMarkdown);
      setPolicy(data.active.policyConfig);
      setSaved(data.active.version);
      setChangelog("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [markdown, policy, changelog]);

  const rows = diffLines(baseline, preview);
  const changed = rows.filter((r) => r.tone !== "same").length;

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Policy</h2>
          <Badge>v{active.version} active</Badge>
          {dirty ? (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
              unsaved
            </span>
          ) : null}
          {saved != null && !dirty ? (
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
              saved as v{saved}
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Refund window (days)
            <input
              type="number"
              className="rounded border border-zinc-300 px-2 py-1 font-mono text-sm text-zinc-900 dark:border-zinc-700"
              value={policy.refund.windowDays}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  refund: {
                    ...policy.refund,
                    windowDays: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Auto-approve up to ($)
            <input
              type="number"
              step="0.01"
              className="rounded border border-zinc-300 px-2 py-1 font-mono text-sm text-zinc-900 dark:border-zinc-700"
              value={toDollars(policy.refund.maxAutoApproveCents)}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  refund: {
                    ...policy.refund,
                    maxAutoApproveCents: toCents(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Refund ceiling ($)
            <input
              type="number"
              step="0.01"
              className="rounded border border-zinc-300 px-2 py-1 font-mono text-sm text-zinc-900 dark:border-zinc-700"
              value={toDollars(policy.refund.maxRefundCents)}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  refund: {
                    ...policy.refund,
                    maxRefundCents: toCents(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Churn-risk LTV ($)
            <input
              type="number"
              step="0.01"
              className="rounded border border-zinc-300 px-2 py-1 font-mono text-sm text-zinc-900 dark:border-zinc-700"
              value={toDollars(policy.escalation.churnRiskLtvCents)}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  escalation: {
                    ...policy.escalation,
                    churnRiskLtvCents: toCents(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Document
          <textarea
            className="h-72 rounded border border-zinc-300 p-2 font-mono text-xs leading-relaxed text-zinc-900 dark:border-zinc-700"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            spellCheck={false}
          />
        </label>

        <p className="text-xs text-zinc-500">
          Figures come from the policy above, never typed into the prose —{" "}
          {SOP_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}
        </p>

        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700"
            placeholder="What changed, and why"
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
          />
          <Button onClick={save} disabled={saving || !dirty || !!previewError}>
            {saving ? "Saving…" : "Save new version"}
          </Button>
        </div>

        {previewError ? (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-900">
            {previewError}
          </p>
        ) : null}
        {error ? (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-900">
            {error}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Compiled prompt{" "}
          <span className="font-normal text-zinc-500">
            — {changed === 0 ? "no changes" : `${changed} changed lines`}
          </span>
        </h2>
        <pre className="max-h-96 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
          {rows.map((row, i) => (
            <div
              key={i}
              className={
                row.tone === "added"
                  ? "bg-emerald-100 text-emerald-900"
                  : row.tone === "removed"
                    ? "bg-red-100 text-red-900 line-through"
                    : ""
              }
            >
              {row.tone === "added" ? "+ " : row.tone === "removed" ? "- " : "  "}
              {row.text || " "}
            </div>
          ))}
        </pre>

        <h2 className="text-sm font-medium">Versions</h2>
        <ul className="flex flex-col gap-1 text-xs">
          {versions.map((v) => (
            <li
              key={v.versionId}
              className="flex items-baseline gap-2 rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800"
            >
              <span className="font-mono">v{v.version}</span>
              {v.isActive ? <Badge>active</Badge> : null}
              <span className="text-zinc-500">{v.changelog}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
