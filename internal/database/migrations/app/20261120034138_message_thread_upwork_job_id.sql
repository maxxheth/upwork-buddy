-- Modify "message_threads" table
ALTER TABLE "message_threads" ADD COLUMN "upwork_job_id" text NOT NULL DEFAULT '';
-- Create index "idx_message_threads_upwork_job_id" to table: "message_threads"
CREATE INDEX "idx_message_threads_upwork_job_id" ON "message_threads" ("upwork_job_id");
