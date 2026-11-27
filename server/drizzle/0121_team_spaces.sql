CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "members_edit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Groups made before team spaces become the server owner's Private folders: nobody reaches a bot
-- through one, as before. The owner's row is made first when it is not there yet.
INSERT INTO "users" ("id", "role") SELECT 'owner', 'owner' WHERE EXISTS (SELECT 1 FROM "groups") ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "groups" SET "owner_user_id" = 'owner';--> statement-breakpoint
-- A folder holds only its owner's bots; anyone else's goes back to their own Private.
UPDATE "bots" SET "group_id" = NULL WHERE "group_id" IS NOT NULL AND "owner_user_id" <> 'owner';
