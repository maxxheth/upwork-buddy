-- Create "notification_configs" table
CREATE TABLE "notification_configs" (
  "id" bigserial NOT NULL,
  "config_key" text NOT NULL DEFAULT 'default',
  "chrome_notifications_enabled" boolean NOT NULL DEFAULT true,
  "webhook_enabled" boolean NOT NULL DEFAULT false,
  "webhook_url" text NOT NULL DEFAULT '',
  "webhook_secret" text NOT NULL DEFAULT '',
  "telegram_enabled" boolean NOT NULL DEFAULT false,
  "telegram_bot_token" text NOT NULL DEFAULT '',
  "telegram_chat_id" text NOT NULL DEFAULT '',
  "notify_events_json" jsonb NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_notification_configs_key" to table: "notification_configs"
CREATE UNIQUE INDEX "idx_notification_configs_key" ON "notification_configs" ("config_key");
-- Create "watch_rules" table
CREATE TABLE "watch_rules" (
  "id" bigserial NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "enabled" boolean NOT NULL DEFAULT false,
  "discovery_backend" text NOT NULL DEFAULT 'chrome',
  "search_profile_id" bigint NULL,
  "discovery_config_json" jsonb NULL,
  "interval_minutes" integer NOT NULL DEFAULT 5,
  "jitter_ratio" double precision NOT NULL DEFAULT 0.35,
  "active_hours" text NOT NULL DEFAULT '',
  "min_score" integer NOT NULL DEFAULT 75,
  "max_proposals" integer NULL,
  "max_posted_age_minutes" integer NULL,
  "max_connects_per_job" integer NULL,
  "require_payment_verified" boolean NOT NULL DEFAULT true,
  "required_keywords_json" jsonb NULL,
  "exclude_keywords_json" jsonb NULL,
  "action_mode" text NOT NULL DEFAULT 'draft_and_fill',
  "llm_model" text NOT NULL DEFAULT '',
  "llm_effort" text NOT NULL DEFAULT '',
  "bid_strategy_json" jsonb NULL,
  "auto_submit_min_confidence" double precision NOT NULL DEFAULT 0.85,
  "fallback_on_screening_questions" boolean NOT NULL DEFAULT true,
  "max_reactions_per_tick" integer NOT NULL DEFAULT 2,
  "seed_baseline_on_first_run" boolean NOT NULL DEFAULT true,
  "seeded_at" timestamp(3) NULL,
  "paused_reason" text NOT NULL DEFAULT '',
  "consecutive_errors" integer NOT NULL DEFAULT 0,
  "next_run_at" timestamp(3) NULL,
  "last_run_at" timestamp(3) NULL,
  "last_success_at" timestamp(3) NULL,
  "last_error" text NOT NULL DEFAULT '',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_watch_rules_search_profile" FOREIGN KEY ("search_profile_id") REFERENCES "search_profiles" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_watch_rules_enabled" to table: "watch_rules"
CREATE INDEX "idx_watch_rules_enabled" ON "watch_rules" ("enabled");
-- Create index "idx_watch_rules_name" to table: "watch_rules"
CREATE UNIQUE INDEX "idx_watch_rules_name" ON "watch_rules" ("name");
-- Create index "idx_watch_rules_next_run_at" to table: "watch_rules"
CREATE INDEX "idx_watch_rules_next_run_at" ON "watch_rules" ("next_run_at");
-- Create index "idx_watch_rules_search_profile_id" to table: "watch_rules"
CREATE INDEX "idx_watch_rules_search_profile_id" ON "watch_rules" ("search_profile_id");
-- Create "watch_runs" table
CREATE TABLE "watch_runs" (
  "id" bigserial NOT NULL,
  "watch_rule_id" bigint NOT NULL,
  "discovery_backend" text NOT NULL DEFAULT '',
  "triggered_by" text NOT NULL DEFAULT '',
  "search_run_id" bigint NULL,
  "status" text NOT NULL DEFAULT 'running',
  "scraped_count" integer NOT NULL DEFAULT 0,
  "new_jobs_count" integer NOT NULL DEFAULT 0,
  "qualified_count" integer NOT NULL DEFAULT 0,
  "drafted_count" integer NOT NULL DEFAULT 0,
  "filled_count" integer NOT NULL DEFAULT 0,
  "submitted_count" integer NOT NULL DEFAULT 0,
  "alerted_count" integer NOT NULL DEFAULT 0,
  "error_code" text NOT NULL DEFAULT '',
  "error_message" text NOT NULL DEFAULT '',
  "started_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" timestamp(3) NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_watch_runs_search_run" FOREIGN KEY ("search_run_id") REFERENCES "search_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "fk_watch_runs_watch_rule" FOREIGN KEY ("watch_rule_id") REFERENCES "watch_rules" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_watch_runs_created_at" to table: "watch_runs"
CREATE INDEX "idx_watch_runs_created_at" ON "watch_runs" ("created_at");
-- Create index "idx_watch_runs_rule_id" to table: "watch_runs"
CREATE INDEX "idx_watch_runs_rule_id" ON "watch_runs" ("watch_rule_id");
-- Create index "idx_watch_runs_search_run_id" to table: "watch_runs"
CREATE INDEX "idx_watch_runs_search_run_id" ON "watch_runs" ("search_run_id");
-- Create index "idx_watch_runs_status" to table: "watch_runs"
CREATE INDEX "idx_watch_runs_status" ON "watch_runs" ("status");
-- Create "watch_events" table
CREATE TABLE "watch_events" (
  "id" bigserial NOT NULL,
  "watch_rule_id" bigint NOT NULL,
  "watch_run_id" bigint NULL,
  "job_id" bigint NOT NULL,
  "upwork_job_id" text NOT NULL DEFAULT '',
  "proposal_id" bigint NULL,
  "stage" text NOT NULL DEFAULT 'discovered',
  "decision_reason" text NOT NULL DEFAULT '',
  "confidence" double precision NULL,
  "error_code" text NOT NULL DEFAULT '',
  "error_message" text NOT NULL DEFAULT '',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_watch_events_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "fk_watch_events_proposal" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "fk_watch_events_watch_rule" FOREIGN KEY ("watch_rule_id") REFERENCES "watch_rules" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "fk_watch_events_watch_run" FOREIGN KEY ("watch_run_id") REFERENCES "watch_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_watch_events_created_at" to table: "watch_events"
CREATE INDEX "idx_watch_events_created_at" ON "watch_events" ("created_at");
-- Create index "idx_watch_events_job_id" to table: "watch_events"
CREATE INDEX "idx_watch_events_job_id" ON "watch_events" ("job_id");
-- Create index "idx_watch_events_proposal_id" to table: "watch_events"
CREATE INDEX "idx_watch_events_proposal_id" ON "watch_events" ("proposal_id");
-- Create index "idx_watch_events_rule_id" to table: "watch_events"
CREATE INDEX "idx_watch_events_rule_id" ON "watch_events" ("watch_rule_id");
-- Create index "idx_watch_events_rule_job" to table: "watch_events"
CREATE UNIQUE INDEX "idx_watch_events_rule_job" ON "watch_events" ("watch_rule_id", "job_id");
-- Create index "idx_watch_events_run_id" to table: "watch_events"
CREATE INDEX "idx_watch_events_run_id" ON "watch_events" ("watch_run_id");
-- Create index "idx_watch_events_stage" to table: "watch_events"
CREATE INDEX "idx_watch_events_stage" ON "watch_events" ("stage");
