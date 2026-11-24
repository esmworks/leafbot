CREATE TABLE "routine_health_dismissals" (
	"routine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"finding" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_health_dismissals_routine_id_user_id_finding_pk" PRIMARY KEY("routine_id","user_id","finding")
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "routine_health_dismissals" ADD CONSTRAINT "routine_health_dismissals_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_health_dismissals" ADD CONSTRAINT "routine_health_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;