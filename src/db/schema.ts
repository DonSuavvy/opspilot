/**
 * OpsPilot data model. Authoritative reference: docs/PLAN.md.
 *
 * Conventions:
 * - Money that is a real charge is stored in integer **cents**. Never floats.
 * - LLM cost is stored as numeric(12,6) USD, because a single Haiku span can
 *   cost fractions of a cent and rounding it to cents would erase the signal
 *   Mission Control exists to show.
 * - Every tenant-scoped table carries workspace_id. Sandbox *logic* is Day 8
 *   and is cuttable; the *column* is not something to retrofit later.
 * - Timestamps are always timezone-aware.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Postgres full-text search vector. Deliberately NOT pgvector embeddings:
 * the KB is ~20 documents and queries are near-exact ("how do I rotate an API
 * key"), where FTS wins on latency, cost, and debuggability. See docs/EVALS.md.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const planEnum = pgEnum("plan", ["free", "pro", "scale"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "open",
  "paid",
  "refunded",
  "partially_refunded",
  "void",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "pending_approval",
  "resolved",
  "escalated",
]);

export const ticketChannelEnum = pgEnum("ticket_channel", [
  "email",
  "chat",
  "web",
]);

export const runStatusEnum = pgEnum("run_status", [
  "running",
  "paused_for_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const spanTypeEnum = pgEnum("span_type", [
  "llm_call",
  "tool_exec",
  "guardrail",
  "approval_wait",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

/** Ported from Cleo's three-class tool safety model. See src/agent/registry. */
export const safetyClassEnum = pgEnum("safety_class", [
  "read",
  "auto_write",
  "confirm_write",
]);

export const actorTypeEnum = pgEnum("actor_type", ["agent", "human", "system"]);

export const evalRunStatusEnum = pgEnum("eval_run_status", [
  "running",
  "completed",
  "failed",
]);

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row per demo visitor sandbox, cookie-scoped and lazily seeded, plus a
 * single well-known "demo" workspace used by evals and CI.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    isDemo: boolean("is_demo").notNull().default(false),
    seededAt: timestamp("seeded_at", { withTimezone: true }),
    /** Cron sweeps sandboxes past their TTL. Null means never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("workspaces_slug_idx").on(t.slug),
    index("workspaces_expires_at_idx").on(t.expiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Beacon Analytics business data                                             */
/* -------------------------------------------------------------------------- */

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    company: text("company").notNull(),
    /** Drives the SOP's retention-offer branch for churn-risk tickets. */
    lifetimeValueCents: integer("lifetime_value_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("customers_workspace_external_idx").on(
      t.workspaceId,
      t.externalId,
    ),
    index("customers_workspace_email_idx").on(t.workspaceId, t.email),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    plan: planEnum("plan").notNull(),
    status: subscriptionStatusEnum("status").notNull(),
    monthlyPriceCents: integer("monthly_price_cents").notNull(),
    seats: integer("seats").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("subscriptions_workspace_customer_idx").on(
      t.workspaceId,
      t.customerId,
    ),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    number: text("number").notNull(),
    status: invoiceStatusEnum("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    refundedCents: integer("refunded_cents").notNull().default(0),
    description: text("description").notNull(),
    /** The refund-window clock starts here, not at createdAt. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_workspace_number_idx").on(t.workspaceId, t.number),
    index("invoices_workspace_customer_idx").on(t.workspaceId, t.customerId),
    index("invoices_workspace_paid_at_idx").on(t.workspaceId, t.paidAt),
  ],
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull(),
    /**
     * Untrusted input. Always wrapped as delimited data in the prompt, never
     * concatenated as instructions. See docs/SECURITY.md.
     */
    body: text("body").notNull(),
    channel: ticketChannelEnum("channel").notNull().default("email"),
    status: ticketStatusEnum("status").notNull().default("open"),
    /** Set by the heuristic pre-scan before the agent ever sees the body. */
    suspectedInjection: boolean("suspected_injection").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("tickets_workspace_status_idx").on(t.workspaceId, t.status),
    index("tickets_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const kbArticles = pgTable(
  "kb_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Generated column so the index can never drift from the content. Title is
     * weighted above body so a title match outranks a passing body mention.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex("kb_articles_workspace_slug_idx").on(t.workspaceId, t.slug),
    index("kb_articles_search_idx").using("gin", t.searchVector),
  ],
);

/* -------------------------------------------------------------------------- */
/* SOP as code                                                                */
/* -------------------------------------------------------------------------- */

export const sops = pgTable(
  "sops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /**
     * Has no FK constraint today, unlike every other relationship column in
     * this schema — but *not* because one is impossible. An earlier version of
     * this comment claimed a deferred constraint was required; that is wrong,
     * and was disproved against this project's own Postgres.
     *
     * The mutual reference (sop_versions.sop_id → sops.id, and this pointing
     * back) is not an insert-time cycle, because this column is nullable:
     * insert the sop with NULL, insert the version, then UPDATE the pointer.
     * A *composite* FK additionally enforces the real invariant — that the
     * target version belongs to this same sop — which a single-column FK
     * cannot express:
     *
     *   CREATE UNIQUE INDEX ON sop_versions (id, sop_id);
     *   ALTER TABLE sops ADD CONSTRAINT sops_active_version_fk
     *     FOREIGN KEY (active_version_id, id) REFERENCES sop_versions (id, sop_id)
     *     ON DELETE SET NULL (active_version_id);
     *
     * Verified in a rolled-back transaction: created without deferral, the
     * three-step insert order succeeds, and a pointer at another sop's version
     * is rejected. Two traps if you add it — the PG15+ column-list form of
     * `SET NULL` is required (plain `SET NULL` also nulls `sops.id` and fails
     * the not-null constraint), and `seed.ts` sets this before inserting the
     * version, so it needs the three-step reorder. Left off until Day 4's SOP
     * editor is the thing writing here, since a drifted pointer breaks prompt
     * assembly loudly rather than silently.
     */
    activeVersionId: uuid("active_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("sops_workspace_slug_idx").on(t.workspaceId, t.slug)],
);

/**
 * Defense in depth lives here. `bodyMarkdown` is compiled into the system
 * prompt so the *model* knows the policy; `policyConfig` is the machine-
 * readable form the `issue_refund` handler revalidates against so the *code*
 * enforces it regardless of what the model decided. Both are versioned in the
 * same row, so they cannot drift apart across an edit.
 */
export const sopVersions = pgTable(
  "sop_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => sops.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    policyConfig: jsonb("policy_config").notNull(),
    changelog: text("changelog").notNull().default(""),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sop_versions_sop_version_idx").on(t.sopId, t.version),
    index("sop_versions_workspace_idx").on(t.workspaceId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Flight recorder                                                            */
/* -------------------------------------------------------------------------- */

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, {
      onDelete: "cascade",
    }),
    sopVersionId: uuid("sop_version_id").references(() => sopVersions.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    status: runStatusEnum("status").notNull().default("running"),
    /** Structured output of the forced terminal `resolve_ticket` tool. */
    outcome: jsonb("outcome"),
    /**
     * The serialized Anthropic messages array, persisted when a confirm-write
     * tool pauses the run. /api/agent/resume reconstructs the loop from this
     * across a separate serverless invocation. This field is the reason the
     * loop is hand-rolled rather than delegated to an SDK tool runner.
     *
     * **`text`, not `jsonb`, deliberately.** Postgres `jsonb` rejects a NUL
     * escape outright (`unsupported Unicode escape sequence`), and
     * `JSON.stringify` emits exactly that for a NUL anywhere in the array — a
     * ticket body pasted from a binary file is enough. The usual fix, sanitise
     * before writing, is unavailable *here*: replaying a paused turn requires
     * passing thinking blocks back byte-identical, so editing the payload is
     * precisely what the resume contract forbids. This column is a replay
     * buffer, never queried by content; `text` round-trips it exactly.
     * (`run_spans.input/output` and `audit_log.before/after` stay jsonb —
     * those are display and audit data, so stripping NULs there is fine.)
     */
    serializedMessages: text("serialized_messages"),
    iterations: integer("iterations").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    /** Populated when Anthropic returns stop_reason: "refusal". */
    refusalCategory: text("refusal_category"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_runs_workspace_started_idx").on(t.workspaceId, t.startedAt),
    index("agent_runs_ticket_idx").on(t.ticketId),
    index("agent_runs_status_idx").on(t.status),
  ],
);

export const runSpans = pgTable(
  "run_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: spanTypeEnum("type").notNull(),
    name: text("name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    isError: boolean("is_error").notNull().default(false),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("run_spans_run_seq_idx").on(t.runId, t.seq)],
);

/* -------------------------------------------------------------------------- */
/* Human in the loop                                                          */
/* -------------------------------------------------------------------------- */

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    spanId: uuid("span_id").references(() => runSpans.id, {
      onDelete: "set null",
    }),
    /**
     * Anthropic's tool_use id. Required to build the matching tool_result block
     * when the run resumes; without it the reconstructed messages array is
     * invalid and the API rejects the turn.
     */
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").notNull(),
    safetyClass: safetyClassEnum("safety_class").notNull(),
    status: approvalStatusEnum("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    /** On denial this is injected back as an is_error tool_result so the agent adapts. */
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
    index("approvals_run_idx").on(t.runId),
  ],
);

/** Append-only. Every side effect lands here, agent- or human-initiated. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id").notNull().default("system"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("audit_log_run_idx").on(t.runId),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Eval lab                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * **Deliberately workspace-independent.** This is the developer's authored
 * regression suite — one shared set of cases, not per-visitor data — so unlike
 * every other table here it carries no `workspaceId`, and
 * `eval_cases_slug_idx` is globally unique by design rather than by oversight.
 * A case is checked in alongside the prompts it guards; a demo sandbox being
 * TTL-cleaned must never take the suite with it.
 *
 * `eval_runs` and `eval_results` are the opposite: they are *executions* of
 * this suite against one workspace's SOP version, so they are workspace-scoped
 * and cascade with it.
 */
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** The ticket to inject, plus any customer/invoice fixtures it needs. */
    ticketPayload: jsonb("ticket_payload").notNull(),
    /** Deterministic assertions over the resolve_ticket outcome + audit log. */
    expectations: jsonb("expectations").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("eval_cases_slug_idx").on(t.slug)],
);

/** Pinned to (SOP version, model, git SHA) so any two runs are comparable. */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Stays `set null`: a SOP version can be deleted independently of its
     * workspace, and a run record with a null pointer is still worth keeping.
     * The workspace-delete path is covered by `workspaceId`'s cascade above —
     * without it, dropping a workspace left these rows alive and attributable
     * to nothing.
     */
    sopVersionId: uuid("sop_version_id").references(() => sopVersions.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    gitSha: text("git_sha"),
    promptVersion: text("prompt_version"),
    status: evalRunStatusEnum("status").notNull().default("running"),
    totalCases: integer("total_cases").notNull().default(0),
    passedCases: integer("passed_cases").notNull().default(0),
    failedCases: integer("failed_cases").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("eval_runs_workspace_started_idx").on(t.workspaceId, t.startedAt),
    /**
     * Kept alongside the composite above, which cannot serve a workspace-less
     * scan: the composite's leading column is `workspace_id`, so a global
     * "runs since <date>" sweep (cross-workspace analytics, CI history) would
     * fall back to a seq scan without this.
     */
    index("eval_runs_started_idx").on(t.startedAt),
  ],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    evalRunId: uuid("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    evalCaseId: uuid("eval_case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    passed: boolean("passed").notNull(),
    /** One entry per assertion, so the diff view can show exactly what moved. */
    assertions: jsonb("assertions").notNull(),
    failureReason: text("failure_reason"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("eval_results_run_case_idx").on(t.evalRunId, t.evalCaseId),
    /**
     * Plain `(workspaceId)` rather than a composite, deliberately: every read
     * of this table goes through `evalRunId`, which already leads the unique
     * index above, so there is no second column worth pairing. This exists to
     * scope a query without joining `eval_runs`, and to back the workspace
     * cascade with an index instead of a seq scan on every TTL cleanup.
     */
    index("eval_results_workspace_idx").on(t.workspaceId),
  ],
);
