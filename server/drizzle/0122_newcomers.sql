ALTER TABLE "users" ADD COLUMN "placed_at" timestamp with time zone;--> statement-breakpoint
-- Everyone already here was placed before spaces; only someone who joins from now on waits for a card.
UPDATE "users" SET "placed_at" = "created_at";
