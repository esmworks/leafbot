-- What a bot's page keeps for itself, each person's own.
CREATE TABLE "page_state" (
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"path" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_state_user_id_bot_id_path_key_pk" PRIMARY KEY("user_id","bot_id","path","key")
);
--> statement-breakpoint
ALTER TABLE "page_state" ADD CONSTRAINT "page_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_state" ADD CONSTRAINT "page_state_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;