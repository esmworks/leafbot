CREATE TABLE "routine_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"key" text NOT NULL,
	"occurrence" text NOT NULL,
	"value" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_readings" ADD CONSTRAINT "routine_readings_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_readings_slot_uq" ON "routine_readings" USING btree ("routine_id","key","occurrence");--> statement-breakpoint
CREATE INDEX "routine_readings_routine_idx" ON "routine_readings" USING btree ("routine_id","key","at");