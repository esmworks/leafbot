CREATE TABLE "room_people" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_people_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room_people" ADD CONSTRAINT "room_people_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_people" ADD CONSTRAINT "room_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_people_user_idx" ON "room_people" USING btree ("user_id");