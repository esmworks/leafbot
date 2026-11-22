-- When the weekly tidy-up last read the page a note came from, to see whether it still says so.
ALTER TABLE "memories" ADD COLUMN "source_checked_at" timestamp with time zone;
