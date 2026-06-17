CREATE TABLE IF NOT EXISTS "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_encrypted" text NOT NULL,
	"updated_at" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
