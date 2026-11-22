-- Skills offered to a person from many-step tasks they asked a bot for again and again.
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
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_suggestions_user_status_idx" ON "skill_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_suggestions_fingerprint_uq" ON "skill_suggestions" USING btree ("user_id","bot_id","fingerprint");
