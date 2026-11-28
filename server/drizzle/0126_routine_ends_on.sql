-- A routine may have a last day; once it went by, the routine switches itself off.
ALTER TABLE "routines" ADD COLUMN "ends_on" text;