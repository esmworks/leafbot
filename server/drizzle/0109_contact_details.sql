CREATE TABLE "contact_details" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"label" text DEFAULT '' NOT NULL,
	"secret" text NOT NULL,
	"sites" text,
	"bot_ids" jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_details" ADD CONSTRAINT "contact_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;