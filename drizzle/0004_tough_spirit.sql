ALTER TABLE "agent_runs" ADD COLUMN "charged_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfill, not the column default. `DEFAULT now()` would stamp every historical
-- run as charged at migration time, moving the whole table's spend onto today
-- and exhausting the daily cap on a database that has simply been used before.
-- A run that predates this column was charged when it started.
UPDATE "agent_runs" SET "charged_at" = "started_at";--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_charged_idx" ON "agent_runs" USING btree ("workspace_id","charged_at");
