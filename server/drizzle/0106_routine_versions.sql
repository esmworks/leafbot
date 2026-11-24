ALTER TABLE "routine_revisions" ADD COLUMN "full" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD COLUMN "condition" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "revision_id" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_revision_id_routine_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;