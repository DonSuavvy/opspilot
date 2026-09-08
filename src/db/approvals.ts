/**
 * The approvals queue — the human's half of the confirm-write loop.
 *
 * A run that pauses writes a `pending` row here; a reviewer decides it; and
 * `/api/agent/resume` reads the decision back into `runAgentLoop`. Until Day 5
 * this table existed in `schema.ts` with nothing reading or writing it — the
 * same shape of defect as `sop_version_id` (Day 4) and the revalidation guard
 * (FAILURES #22): a column with an FK and no writer.
 */
import { and, eq, sql } from "drizzle-orm";

import type { ResumeDecision } from "../agent/loop";
import type { Db } from "./client";
import { agentRuns, approvals, runSpans } from "./schema";

/** The columns the resume path actually reads. */
export interface ApprovalRow {
  id: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  decisionReason: string | null;
}

/**
 * Turn decided approval rows into the answers the loop consumes.
 *
 * Undecided rows are dropped rather than passed through. The loop treats this
 * list as "these calls have been answered" — `firstCallAwaitingApproval` skips
 * any id it finds here — so a `pending` row would stop the run pausing for a
 * call nobody has decided and send it into dispatch with no answer to apply.
 * `expired` is dropped for the same reason: a lapsed request is not a yes.
 */
export function toResumeDecisions(rows: ApprovalRow[]): ResumeDecision[] {
  return rows
    .filter((r) => r.status === "approved" || r.status === "denied")
    .map((r) => ({
      toolUseId: r.toolUseId,
      approved: r.status === "approved",
      reason: r.decisionReason,
    }));
}

/**
 * Record a pause as a pending approval.
 *
 * Idempotent on `(runId, toolUseId)`: a resume that pauses again on the *same*
 * call — a second confirm-write in one turn is decided one at a time — must
 * not stack duplicate rows for a question already asked.
 */
export async function recordPendingApproval(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    safetyClass: "read" | "auto_write" | "confirm_write";
  },
): Promise<void> {
  const existing = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.runId, input.runId),
        eq(approvals.toolUseId, input.toolUseId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return;

  await db.insert(approvals).values({
    workspaceId: input.workspaceId,
    runId: input.runId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    safetyClass: input.safetyClass,
    status: "pending",
  });
}

export async function listApprovals(
  db: Db,
  runId: string,
): Promise<ApprovalRow[]> {
  return db
    .select({
      id: approvals.id,
      toolUseId: approvals.toolUseId,
      toolName: approvals.toolName,
      toolInput: approvals.toolInput,
      status: approvals.status,
      decisionReason: approvals.decisionReason,
    })
    .from(approvals)
    .where(eq(approvals.runId, runId));
}

export class ApprovalNotPendingError extends Error {
  constructor(runId: string) {
    super(
      `no pending approval for run ${runId} — it was already decided, or the ` +
        `run never paused`,
    );
    this.name = "ApprovalNotPendingError";
  }
}

/**
 * Decide the run's pending approval, and refuse to decide it twice.
 *
 * The `status = 'pending'` predicate is the concurrency guard, not a
 * convenience: two POSTs to `/api/agent/resume` race, and without it both would
 * read `pending`, both would write a decision, and the tool would be dispatched
 * twice. Postgres serialises the UPDATE, so exactly one of them matches a row
 * and the other gets zero — which is the signal to reject rather than replay.
 */
export async function decidePendingApproval(
  db: Db,
  input: {
    runId: string;
    approved: boolean;
    reason: string | null;
    decidedBy: string;
    now: Date;
  },
): Promise<ApprovalRow> {
  const decided = await db
    .update(approvals)
    .set({
      status: input.approved ? "approved" : "denied",
      decisionReason: input.reason,
      decidedBy: input.decidedBy,
      decidedAt: input.now,
    })
    .where(
      and(eq(approvals.runId, input.runId), eq(approvals.status, "pending")),
    )
    .returning({
      id: approvals.id,
      toolUseId: approvals.toolUseId,
      toolName: approvals.toolName,
      toolInput: approvals.toolInput,
      status: approvals.status,
      decisionReason: approvals.decisionReason,
    });

  const row = decided[0];
  if (!row) throw new ApprovalNotPendingError(input.runId);
  return row;
}

/**
 * Where a resumed invocation should start numbering its spans.
 *
 * `run_spans` is unique on `(run_id, seq)` and a resumed run keeps its original
 * row so the trace renders as one waterfall. Reading the high-water mark from
 * the persisted spans — rather than from the paused result's `iterations` — is
 * what makes this correct after any number of resumes.
 */
export async function nextSpanSeq(db: Db, runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${runSpans.seq})` })
    .from(runSpans)
    .where(eq(runSpans.runId, runId));

  const max = row?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

export interface PausedRun {
  id: string;
  workspaceId: string;
  /** Nullable in the schema — an eval run has no inbox ticket behind it. */
  ticketId: string | null;
  sopVersionId: string | null;
  serializedMessages: string | null;
  status: string;
}

export async function loadPausedRun(
  db: Db,
  runId: string,
): Promise<PausedRun | null> {
  const [row] = await db
    .select({
      id: agentRuns.id,
      workspaceId: agentRuns.workspaceId,
      ticketId: agentRuns.ticketId,
      sopVersionId: agentRuns.sopVersionId,
      serializedMessages: agentRuns.serializedMessages,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  return row ?? null;
}

/** Reopen a paused run before a resumed invocation writes to it. */
export async function markRunning(db: Db, runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "running" })
    .where(eq(agentRuns.id, runId));
}

/**
 * Fail a resumed run without touching `serialized_messages`.
 *
 * `finishRun` would overwrite the replay buffer with the loop result's — null
 * on anything but a pause — and a resume that died on a transient provider
 * error would take the conversation with it. Leaving the buffer intact is what
 * makes the failure retryable rather than terminal for the ticket.
 */
export async function failRun(
  db: Db,
  runId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "failed", error, endedAt: new Date() })
    .where(eq(agentRuns.id, runId));
}
