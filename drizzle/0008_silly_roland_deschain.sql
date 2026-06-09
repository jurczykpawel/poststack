CREATE TABLE "processed_events" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
