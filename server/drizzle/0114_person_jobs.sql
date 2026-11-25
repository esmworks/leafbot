CREATE TABLE "person_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text,
	"device" text NOT NULL,
	"command" text NOT NULL,
	"cwd" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"tail" text DEFAULT '' NOT NULL,
	"wake" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "person_jobs" ADD CONSTRAINT "person_jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_jobs" ADD CONSTRAINT "person_jobs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_jobs_user_idx" ON "person_jobs" USING btree ("user_id","status");