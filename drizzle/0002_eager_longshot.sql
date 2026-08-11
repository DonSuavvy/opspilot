ALTER TABLE "eval_results" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_results_workspace_idx" ON "eval_results" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "eval_runs_workspace_started_idx" ON "eval_runs" USING btree ("workspace_id","started_at");