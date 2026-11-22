CREATE TABLE "memory_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text,
	"place" text,
	"memory_id" text,
	"skill_id" text,
	"about" text NOT NULL,
	"seen" text,
	"source_url" text,
	"outside" text,
	"thread_id" text,
	"turn_id" text,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"change_id" text,
	"checked_at" timestamp with time zone,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_flags" ADD CONSTRAINT "memory_flags_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_flags" ADD CONSTRAINT "memory_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_flags" ADD CONSTRAINT "memory_flags_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_flags" ADD CONSTRAINT "memory_flags_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_flags_bot_idx" ON "memory_flags" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "memory_flags_memory_idx" ON "memory_flags" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_flags_turn_idx" ON "memory_flags" USING btree ("turn_id");