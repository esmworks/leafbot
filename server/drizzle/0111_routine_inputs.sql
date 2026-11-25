ALTER TABLE "routine_runs" ADD COLUMN "inputs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "inputs" jsonb DEFAULT '{}'::jsonb NOT NULL;