-- Modify "jobs" table
ALTER TABLE "jobs" ADD COLUMN "upwork_job_id" text NULL, ADD COLUMN "canonical_url" text NULL, ADD COLUMN "source_feed" text NULL, ADD COLUMN "source_query" text NULL, ADD COLUMN "duration" text NULL, ADD COLUMN "hours_per_week" text NULL, ADD COLUMN "posted_text" text NULL, ADD COLUMN "posted_at_est" timestamp(3) NULL, ADD COLUMN "proposals_tier" text NULL, ADD COLUMN "proposals_count" integer NULL, ADD COLUMN "connects_required" integer NULL, ADD COLUMN "screening_questions" jsonb NULL, ADD COLUMN "attachments" jsonb NULL, ADD COLUMN "qualifications" jsonb NULL, ADD COLUMN "last_enriched_at" timestamp(3) NULL, ADD COLUMN "client_country" text NULL, ADD COLUMN "client_rating" double precision NULL, ADD COLUMN "client_reviews" integer NULL, ADD COLUMN "client_spent" text NULL, ADD COLUMN "client_spent_usd" double precision NULL, ADD COLUMN "client_hires" integer NULL, ADD COLUMN "client_hire_rate" double precision NULL, ADD COLUMN "payment_verified" boolean NULL, ADD COLUMN "client_activity" jsonb NULL, ADD COLUMN "score" integer NULL, ADD COLUMN "score_breakdown" jsonb NULL, ADD COLUMN "score_reasoning" text NULL, ADD COLUMN "fit_label" text NULL, ADD COLUMN "fit_assessment" text NULL, ADD COLUMN "proposal_subject" text NULL, ADD COLUMN "proposal_tone" text NULL, ADD COLUMN "proposal_json" jsonb NULL, ADD COLUMN "portfolio_references" jsonb NULL;
-- Create index "idx_jobs_canonical_url" to table: "jobs"
CREATE INDEX "idx_jobs_canonical_url" ON "jobs" ("canonical_url");
-- Create index "idx_jobs_fit_label" to table: "jobs"
CREATE INDEX "idx_jobs_fit_label" ON "jobs" ("fit_label");
-- Create index "idx_jobs_posted_at_est" to table: "jobs"
CREATE INDEX "idx_jobs_posted_at_est" ON "jobs" ("posted_at_est");
-- Create index "idx_jobs_score" to table: "jobs"
CREATE INDEX "idx_jobs_score" ON "jobs" ("score");
-- Create index "idx_jobs_status" to table: "jobs"
CREATE INDEX "idx_jobs_status" ON "jobs" ("status");
-- Create index "idx_jobs_upwork_job_id" to table: "jobs"
CREATE UNIQUE INDEX "idx_jobs_upwork_job_id" ON "jobs" ("upwork_job_id") WHERE ((upwork_job_id IS NOT NULL) AND (upwork_job_id <> ''::text));
-- Create "action_audit_logs" table
CREATE TABLE "action_audit_logs" (
  "id" bigserial NOT NULL,
  "action_type" text NOT NULL,
  "actor" text NOT NULL DEFAULT 'system',
  "target_id" text NOT NULL DEFAULT '',
  "policy_mode" text NOT NULL DEFAULT '',
  "outcome" text NOT NULL,
  "details_json" jsonb NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);
-- Create index "idx_action_audit_logs_action_type" to table: "action_audit_logs"
CREATE INDEX "idx_action_audit_logs_action_type" ON "action_audit_logs" ("action_type");
-- Create index "idx_action_audit_logs_created_at" to table: "action_audit_logs"
CREATE INDEX "idx_action_audit_logs_created_at" ON "action_audit_logs" ("created_at");
-- Create index "idx_action_audit_logs_outcome" to table: "action_audit_logs"
CREATE INDEX "idx_action_audit_logs_outcome" ON "action_audit_logs" ("outcome");
-- Create index "idx_action_audit_logs_target_id" to table: "action_audit_logs"
CREATE INDEX "idx_action_audit_logs_target_id" ON "action_audit_logs" ("target_id");
-- Create "search_profiles" table
CREATE TABLE "search_profiles" (
  "id" bigserial NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "config_json" jsonb NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_run_at" timestamp(3) NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_search_profiles_is_active" to table: "search_profiles"
CREATE INDEX "idx_search_profiles_is_active" ON "search_profiles" ("is_active");
-- Create index "idx_search_profiles_name" to table: "search_profiles"
CREATE UNIQUE INDEX "idx_search_profiles_name" ON "search_profiles" ("name");
-- Create "selector_audits" table
CREATE TABLE "selector_audits" (
  "id" bigserial NOT NULL,
  "view_type" text NOT NULL,
  "overall_status" text NOT NULL,
  "report_json" jsonb NOT NULL,
  "baseline_json" jsonb NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);
-- Create index "idx_selector_audits_created_at" to table: "selector_audits"
CREATE INDEX "idx_selector_audits_created_at" ON "selector_audits" ("created_at");
-- Create index "idx_selector_audits_overall_status" to table: "selector_audits"
CREATE INDEX "idx_selector_audits_overall_status" ON "selector_audits" ("overall_status");
-- Create index "idx_selector_audits_view_type" to table: "selector_audits"
CREATE INDEX "idx_selector_audits_view_type" ON "selector_audits" ("view_type");
-- Create "generated_agents" table
CREATE TABLE "generated_agents" (
  "id" bigserial NOT NULL,
  "template_name" text NOT NULL,
  "blueprint_name" text NOT NULL,
  "format" text NOT NULL,
  "file_name" text NOT NULL,
  "job_id" bigint NULL,
  "content" text NOT NULL DEFAULT '',
  "files_json" jsonb NULL,
  "generated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_generated_agents_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_generated_agents_composite" to table: "generated_agents"
CREATE UNIQUE INDEX "idx_generated_agents_composite" ON "generated_agents" ("template_name", "blueprint_name", "format");
-- Create index "idx_generated_agents_job_id" to table: "generated_agents"
CREATE INDEX "idx_generated_agents_job_id" ON "generated_agents" ("job_id");
-- Create "proposals" table
CREATE TABLE "proposals" (
  "id" bigserial NOT NULL,
  "job_id" bigint NULL,
  "upwork_job_id" text NULL,
  "cover_letter" text NOT NULL DEFAULT '',
  "bid_type" text NOT NULL DEFAULT '',
  "bid_amount" double precision NULL,
  "milestones_json" jsonb NULL,
  "screening_answers_json" jsonb NULL,
  "boost_connects" integer NULL,
  "portfolio_refs_json" jsonb NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "approval_token" text NULL,
  "approved_at" timestamp(3) NULL,
  "submitted_at" timestamp(3) NULL,
  "upwork_proposal_url" text NOT NULL DEFAULT '',
  "verification_snapshot_json" jsonb NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_proposals_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_proposals_approval_token" to table: "proposals"
CREATE UNIQUE INDEX "idx_proposals_approval_token" ON "proposals" ("approval_token") WHERE ((approval_token IS NOT NULL) AND (approval_token <> ''::text));
-- Create index "idx_proposals_job_id" to table: "proposals"
CREATE INDEX "idx_proposals_job_id" ON "proposals" ("job_id");
-- Create index "idx_proposals_status" to table: "proposals"
CREATE INDEX "idx_proposals_status" ON "proposals" ("status");
-- Create index "idx_proposals_submitted_at" to table: "proposals"
CREATE INDEX "idx_proposals_submitted_at" ON "proposals" ("submitted_at");
-- Create index "idx_proposals_upwork_job_id" to table: "proposals"
CREATE INDEX "idx_proposals_upwork_job_id" ON "proposals" ("upwork_job_id");
-- Create "message_threads" table
CREATE TABLE "message_threads" (
  "id" bigserial NOT NULL,
  "upwork_room_id" text NOT NULL,
  "client_name" text NOT NULL DEFAULT '',
  "client_company" text NOT NULL DEFAULT '',
  "job_title" text NOT NULL DEFAULT '',
  "job_id" bigint NULL,
  "proposal_id" bigint NULL,
  "unread_count" integer NOT NULL DEFAULT 0,
  "last_message_snippet" text NOT NULL DEFAULT '',
  "last_message_at" timestamp(3) NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_message_threads_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "fk_message_threads_proposal" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
-- Create index "idx_message_threads_job_id" to table: "message_threads"
CREATE INDEX "idx_message_threads_job_id" ON "message_threads" ("job_id");
-- Create index "idx_message_threads_last_message_at" to table: "message_threads"
CREATE INDEX "idx_message_threads_last_message_at" ON "message_threads" ("last_message_at");
-- Create index "idx_message_threads_proposal_id" to table: "message_threads"
CREATE INDEX "idx_message_threads_proposal_id" ON "message_threads" ("proposal_id");
-- Create index "idx_message_threads_upwork_room_id" to table: "message_threads"
CREATE UNIQUE INDEX "idx_message_threads_upwork_room_id" ON "message_threads" ("upwork_room_id");
-- Create "messages" table
CREATE TABLE "messages" (
  "id" bigserial NOT NULL,
  "thread_id" bigint NOT NULL,
  "upwork_message_id" text NULL,
  "sender" text NOT NULL DEFAULT '',
  "sender_role" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "sent_at" timestamp(3) NULL,
  "attachments_json" jsonb NULL,
  "card_json" jsonb NULL,
  "is_draft" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'received',
  "approval_token" text NULL,
  "approved_at" timestamp(3) NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_messages_thread" FOREIGN KEY ("thread_id") REFERENCES "message_threads" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_messages_approval_token" to table: "messages"
CREATE UNIQUE INDEX "idx_messages_approval_token" ON "messages" ("approval_token") WHERE ((approval_token IS NOT NULL) AND (approval_token <> ''::text));
-- Create index "idx_messages_sent_at" to table: "messages"
CREATE INDEX "idx_messages_sent_at" ON "messages" ("sent_at");
-- Create index "idx_messages_status" to table: "messages"
CREATE INDEX "idx_messages_status" ON "messages" ("status");
-- Create index "idx_messages_thread_id" to table: "messages"
CREATE INDEX "idx_messages_thread_id" ON "messages" ("thread_id");
-- Create index "idx_messages_upwork_message_id" to table: "messages"
CREATE UNIQUE INDEX "idx_messages_upwork_message_id" ON "messages" ("upwork_message_id") WHERE ((upwork_message_id IS NOT NULL) AND (upwork_message_id <> ''::text));
