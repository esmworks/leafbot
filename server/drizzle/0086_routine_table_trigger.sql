-- A routine can start when its person adds a row to one of the bot's tables, so a table becomes a
-- list of work the bot picks up. A table the person deletes takes the trigger with it.
ALTER TABLE "routines" ADD COLUMN "table_trigger" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "table_filter" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_table_trigger_bot_tables_id_fk" FOREIGN KEY ("table_trigger") REFERENCES "public"."bot_tables"("id") ON DELETE set null ON UPDATE no action;