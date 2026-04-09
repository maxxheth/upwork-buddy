-- Modify "jobs" table — add new contract-type-aware columns
ALTER TABLE "public"."jobs" ADD COLUMN IF NOT EXISTS "contract_type" text NULL,
  ADD COLUMN IF NOT EXISTS "rate_range" text NULL,
  ADD COLUMN IF NOT EXISTS "rate_min" text NULL,
  ADD COLUMN IF NOT EXISTS "rate_max" text NULL,
  ADD COLUMN IF NOT EXISTS "budget_amount" text NULL,
  ADD COLUMN IF NOT EXISTS "experience_level" text NULL;
-- Create "profiles" table
CREATE TABLE IF NOT EXISTS "public"."profiles" (
  "id" bigserial NOT NULL,
  "description" text NULL,
  "skills" text NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create "portfolio_items" table
CREATE TABLE IF NOT EXISTS "public"."portfolio_items" (
  "id" bigserial NOT NULL,
  "profile_id" bigint NULL,
  "title" text NULL,
  "link" text NULL,
  "description" text NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_profiles_portfolio_items" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "idx_portfolio_items_profile_id" to table: "portfolio_items"
CREATE INDEX IF NOT EXISTS "idx_portfolio_items_profile_id" ON "public"."portfolio_items" ("profile_id");