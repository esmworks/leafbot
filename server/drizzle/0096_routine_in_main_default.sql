ALTER TABLE "routines" ALTER COLUMN "in_main" SET DEFAULT true;--> statement-breakpoint
-- A routine is the bot's own work, followed where the person talks to it. Left in its own
-- conversation: one reading WhatsApp (one customer's chat must not become another's context), one
-- reporting to Slack (a team conversation), and one that stops for the person (a run held for days
-- would keep the main conversation busy).
UPDATE "routines" SET "in_main" = true
WHERE "in_main" = false
  AND "whatsapp_group" IS NULL
  AND "whatsapp_people" = false
  AND "slack_channel" IS NULL
  AND NOT ("steps" @> '[{"kind":"approval"}]'::jsonb OR "steps" @> '[{"kind":"wait"}]'::jsonb);
