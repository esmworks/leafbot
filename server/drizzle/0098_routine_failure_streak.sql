ALTER TABLE "routines" ADD COLUMN "failure_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "paused_reason" text;