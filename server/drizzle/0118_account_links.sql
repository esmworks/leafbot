CREATE TABLE "account_links" (
	"account_user_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_links_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;