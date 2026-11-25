CREATE TABLE "bot_table_shares" (
	"table_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"write" boolean DEFAULT false NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_table_shares_table_id_bot_id_pk" PRIMARY KEY("table_id","bot_id")
);
--> statement-breakpoint
ALTER TABLE "bot_table_shares" ADD CONSTRAINT "bot_table_shares_table_id_bot_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."bot_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_table_shares" ADD CONSTRAINT "bot_table_shares_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_table_shares_bot_idx" ON "bot_table_shares" USING btree ("bot_id");