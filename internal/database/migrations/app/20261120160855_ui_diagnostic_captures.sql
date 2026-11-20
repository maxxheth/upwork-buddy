-- Create "uidiagnostic_captures" table
CREATE TABLE "uidiagnostic_captures" (
  "id" bigserial NOT NULL,
  "capture_uid" text NOT NULL,
  "view_type" text NOT NULL,
  "page_url" text NOT NULL DEFAULT '',
  "overall_status" text NOT NULL,
  "broken_count" integer NOT NULL DEFAULT 0,
  "broken_fields_json" jsonb NULL,
  "bundle_dir" text NOT NULL DEFAULT '',
  "has_screenshot" boolean NOT NULL DEFAULT false,
  "summary_json" jsonb NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);
-- Create index "idx_ui_diagnostic_captures_created_at" to table: "uidiagnostic_captures"
CREATE INDEX "idx_ui_diagnostic_captures_created_at" ON "uidiagnostic_captures" ("created_at");
-- Create index "idx_ui_diagnostic_captures_overall_status" to table: "uidiagnostic_captures"
CREATE INDEX "idx_ui_diagnostic_captures_overall_status" ON "uidiagnostic_captures" ("overall_status");
-- Create index "idx_ui_diagnostic_captures_uid" to table: "uidiagnostic_captures"
CREATE UNIQUE INDEX "idx_ui_diagnostic_captures_uid" ON "uidiagnostic_captures" ("capture_uid");
-- Create index "idx_ui_diagnostic_captures_view_type" to table: "uidiagnostic_captures"
CREATE INDEX "idx_ui_diagnostic_captures_view_type" ON "uidiagnostic_captures" ("view_type");
