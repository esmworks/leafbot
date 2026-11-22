-- A routine can start when its person fills in a row of one of the bot's tables, so a table becomes
-- a list of work the bot picks up. A table the person deletes takes the trigger with it. A row
-- remembers the one person who wrote all of it; rows from before are nobody's alone, so a routine
-- reads them as possibly holding outside text.
ALTER TABLE "bot_table_rows" ADD COLUMN "written_by" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "table_trigger" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "table_filter" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_table_trigger_bot_tables_id_fk" FOREIGN KEY ("table_trigger") REFERENCES "public"."bot_tables"("id") ON DELETE set null ON UPDATE no action;