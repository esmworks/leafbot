-- The steps a bot took in a turn, kept so that how it goes about a kind of task can be read later.
ALTER TABLE "turns" ADD COLUMN "steps" jsonb;
