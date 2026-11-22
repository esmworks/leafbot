-- Reminders a bot keeps for itself, apart from the routines: no card before one is set, and no line in
-- the list of routines. A promise points at the one that brings it up. A bot can also check in by
-- itself after hours of quiet.
CREATE TABLE "follow_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text,
	"text" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"event_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'bot' NOT NULL,
	"outside" text,
	"status" text DEFAULT 'open' NOT NULL,
	"turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "check_in_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "follow_up_id" text;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "follow_ups_user_idx" ON "follow_ups" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_follow_up_id_follow_ups_id_fk" FOREIGN KEY ("follow_up_id") REFERENCES "public"."follow_ups"("id") ON DELETE set null ON UPDATE no action;
