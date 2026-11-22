-- Create "enrichment_batches" table
CREATE TABLE "enrichment_batches" (
  "id" bigserial NOT NULL,
  "mode" text NOT NULL DEFAULT 'full',
  "triggered_by" text NOT NULL DEFAULT '',
  "model" text NOT NULL DEFAULT '',
  "effort" text NOT NULL DEFAULT '',
  "force" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'queued',
  "total_count" integer NOT NULL DEFAULT 0,
  "queued_count" integer NOT NULL DEFAULT 0,
  "running_count" integer NOT NULL DEFAULT 0,
  "completed_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "canceled_count" integer NOT NULL DEFAULT 0,
  "total_tokens_used" integer NOT NULL DEFAULT 0,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" timestamp(3) NULL,
  "completed_at" timestamp(3) NULL,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_enrichment_batches_created_at" to table: "enrichment_batches"
CREATE INDEX "idx_enrichment_batches_created_at" ON "enrichment_batches" ("created_at");
-- Create index "idx_enrichment_batches_status" to table: "enrichment_batches"
CREATE INDEX "idx_enrichment_batches_status" ON "enrichment_batches" ("status");
-- Create "search_runs" table
CREATE TABLE "search_runs" (
  "id" bigserial NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "source" text NOT NULL DEFAULT '',
  "triggered_by" text NOT NULL DEFAULT '',
  "profile_id" bigint NULL,
  "project_keys_json" jsonb NULL,
  "queries_json" jsonb NULL,
  "criteria_json" jsonb NULL,
  "total_scraped" integer NOT NULL DEFAULT 0,
  "filtered_count" integer NOT NULL DEFAULT 0,
  "persisted_count" integer NOT NULL DEFAULT 0,
  "detail_enriched_count" integer NOT NULL DEFAULT 0,
  "stopped_reason" text NOT NULL DEFAULT '',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);
-- Create index "idx_search_runs_created_at" to table: "search_runs"
CREATE INDEX "idx_search_runs_created_at" ON "search_runs" ("created_at");
-- Create index "idx_search_runs_profile_id" to table: "search_runs"
CREATE INDEX "idx_search_runs_profile_id" ON "search_runs" ("profile_id");
-- Modify "jobs" table
ALTER TABLE "jobs" ADD COLUMN "ai_enrichment_status" text NOT NULL DEFAULT 'none', ADD COLUMN "ai_enriched_at" timestamp(3) NULL, ADD COLUMN "ai_enrichment_error" text NOT NULL DEFAULT '', ADD COLUMN "ai_model" text NOT NULL DEFAULT '', ADD COLUMN "ai_effort" text NOT NULL DEFAULT '', ADD COLUMN "ai_tokens_used" integer NULL, ADD COLUMN "last_search_run_id" bigint NULL, ADD CONSTRAINT "fk_jobs_last_search_run" FOREIGN KEY ("last_search_run_id") REFERENCES "search_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
-- Create index "idx_jobs_ai_enriched_at" to table: "jobs"
CREATE INDEX "idx_jobs_ai_enriched_at" ON "jobs" ("ai_enriched_at");
-- Create index "idx_jobs_ai_enrichment_status" to table: "jobs"
CREATE INDEX "idx_jobs_ai_enrichment_status" ON "jobs" ("ai_enrichment_status");
-- Create index "idx_jobs_last_search_run_id" to table: "jobs"
CREATE INDEX "idx_jobs_last_search_run_id" ON "jobs" ("last_search_run_id");
-- Create "enrichment_batch_items" table
CREATE TABLE "enrichment_batch_items" (
  "id" bigserial NOT NULL,
  "batch_id" bigint NOT NULL,
  "job_id" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "detail_fetched" boolean NOT NULL DEFAULT false,
  "llm_invoked" boolean NOT NULL DEFAULT false,
  "model" text NOT NULL DEFAULT '',
  "effort" text NOT NULL DEFAULT '',
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "thought_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "error_code" text NOT NULL DEFAULT '',
  "error_message" text NOT NULL DEFAULT '',
  "started_at" timestamp(3) NULL,
  "completed_at" timestamp(3) NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_enrichment_batch_items_batch" FOREIGN KEY ("batch_id") REFERENCES "enrichment_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "fk_enrichment_batch_items_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_enrichment_batch_items_batch_id" to table: "enrichment_batch_items"
CREATE INDEX "idx_enrichment_batch_items_batch_id" ON "enrichment_batch_items" ("batch_id");
-- Create index "idx_enrichment_batch_items_job_id" to table: "enrichment_batch_items"
CREATE INDEX "idx_enrichment_batch_items_job_id" ON "enrichment_batch_items" ("job_id");
-- Create index "idx_enrichment_batch_items_status" to table: "enrichment_batch_items"
CREATE INDEX "idx_enrichment_batch_items_status" ON "enrichment_batch_items" ("status");
-- Create "search_run_jobs" table
CREATE TABLE "search_run_jobs" (
  "search_run_id" bigint NOT NULL,
  "job_id" bigint NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("search_run_id", "job_id"),
  CONSTRAINT "fk_search_run_jobs_job" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "fk_search_run_jobs_search_run" FOREIGN KEY ("search_run_id") REFERENCES "search_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_search_run_jobs_job_id" to table: "search_run_jobs"
CREATE INDEX "idx_search_run_jobs_job_id" ON "search_run_jobs" ("job_id");

-- Backfill existing AI-analyzed jobs idempotently
UPDATE "jobs"
SET "ai_enrichment_status" = 'completed',
    "ai_enriched_at" = COALESCE("ai_enriched_at", "updated_at")
WHERE COALESCE("proposal", '') ~ '\S'
  AND "ai_enrichment_status" = 'none';
