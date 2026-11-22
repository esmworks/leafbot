-- What the memory review, conversation titles and meeting minutes spent on a bot's model, so they
-- show on the usage page and count toward the spending limits.
CREATE TABLE "background_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_calls" ADD CONSTRAINT "background_calls_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_calls_created_idx" ON "background_calls" USING btree ("created_at");
