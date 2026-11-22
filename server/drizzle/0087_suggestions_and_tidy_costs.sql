-- Skills offered from many-step tasks asked for again and again, when a note was last read against its
-- page, and what the skill suggestions and the memory tidy-up spent on their calls.
CREATE TABLE "memory_tidy_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"cost_usd" real,
	"changed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_suggestion_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"cost_usd" real,
	"found" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"requests" integer NOT NULL,
	"days" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"skill_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_tidy_checks" ADD CONSTRAINT "memory_tidy_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestion_checks" ADD CONSTRAINT "skill_suggestion_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_tidy_checks_created_idx" ON "memory_tidy_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "skill_suggestion_checks_created_idx" ON "skill_suggestion_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "skill_suggestions_user_status_idx" ON "skill_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_suggestions_fingerprint_uq" ON "skill_suggestions" USING btree ("user_id","bot_id","fingerprint");
