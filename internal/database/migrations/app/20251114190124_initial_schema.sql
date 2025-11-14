-- Create "users" table
CREATE TABLE "public"."users" (
  "id" bigserial NOT NULL,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_users_email" to table: "users"
CREATE UNIQUE INDEX "idx_users_email" ON "public"."users" ("email");
-- Create "jobs" table
CREATE TABLE "public"."jobs" (
  "id" bigserial NOT NULL,
  "title" text NOT NULL,
  "description" text NULL,
  "url" text NULL,
  "source" text NULL,
  "status" text NULL,
  "user_id" bigint NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  "applied_at" timestamp(3) NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_jobs_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "idx_jobs_user_id" to table: "jobs"
CREATE INDEX "idx_jobs_user_id" ON "public"."jobs" ("user_id");
