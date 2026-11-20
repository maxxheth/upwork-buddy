-- Modify "messages" table
ALTER TABLE "messages" ADD COLUMN "approval_token_expires_at" timestamp(3) NULL;
-- Modify "proposals" table
ALTER TABLE "proposals" ADD COLUMN "rate_increase" text NOT NULL DEFAULT '', ADD COLUMN "connects_required" integer NULL, ADD COLUMN "approval_token_expires_at" timestamp(3) NULL;
-- Create "policy_configs" table
CREATE TABLE "policy_configs" (
  "id" bigserial NOT NULL,
  "config_key" text NOT NULL DEFAULT 'default',
  "mode" text NOT NULL DEFAULT 'confirm_in_ui',
  "auto_submit_proposals" boolean NOT NULL DEFAULT true,
  "auto_send_messages" boolean NOT NULL DEFAULT true,
  "max_proposals_per_day" integer NOT NULL DEFAULT 5,
  "max_connects_per_day" integer NOT NULL DEFAULT 50,
  "max_messages_per_day" integer NOT NULL DEFAULT 20,
  "min_job_score" integer NOT NULL DEFAULT 0,
  "allowed_room_ids_json" jsonb NULL,
  "quiet_hours" text NOT NULL DEFAULT '',
  "kill_switch_active" boolean NOT NULL DEFAULT false,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_policy_configs_config_key" to table: "policy_configs"
CREATE UNIQUE INDEX "idx_policy_configs_config_key" ON "policy_configs" ("config_key");
