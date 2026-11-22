-- Create "active_projects" table
CREATE TABLE "active_projects" (
  "id" bigserial NOT NULL,
  "project_key" text NOT NULL,
  "slug" text NOT NULL DEFAULT '',
  "name" text NOT NULL,
  "path" text NOT NULL DEFAULT '',
  "group_name" text NOT NULL DEFAULT 'standalone',
  "activity_tier" text NOT NULL DEFAULT 'paused',
  "status" text NOT NULL DEFAULT 'active',
  "client" text NOT NULL DEFAULT '',
  "proposal_visibility" text NOT NULL DEFAULT 'anonymized',
  "public_alias" text NOT NULL DEFAULT '',
  "tech_stack_json" jsonb NULL,
  "summary" text NOT NULL DEFAULT '',
  "readme_hint" text NOT NULL DEFAULT '',
  "next_actions_json" jsonb NULL,
  "blockers_json" jsonb NULL,
  "notes" text NOT NULL DEFAULT '',
  "pinned" boolean NOT NULL DEFAULT false,
  "is_git_repo" boolean NOT NULL DEFAULT false,
  "git_branch" text NOT NULL DEFAULT '',
  "git_head" text NOT NULL DEFAULT '',
  "git_dirty_count" integer NOT NULL DEFAULT 0,
  "last_commit_at" timestamp(3) NULL,
  "last_commit_subject" text NOT NULL DEFAULT '',
  "commits7d" integer NOT NULL DEFAULT 0,
  "last_claude_session_at" timestamp(3) NULL,
  "last_antigravity_at" timestamp(3) NULL,
  "last_activity_at" timestamp(3) NULL,
  "curated_updated_at" timestamp(3) NULL,
  "curated_updated_by" text NOT NULL DEFAULT '',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "idx_active_projects_group_name" to table: "active_projects"
CREATE INDEX "idx_active_projects_group_name" ON "active_projects" ("group_name");
-- Create index "idx_active_projects_key" to table: "active_projects"
CREATE UNIQUE INDEX "idx_active_projects_key" ON "active_projects" ("project_key");
-- Create index "idx_active_projects_last_activity" to table: "active_projects"
CREATE INDEX "idx_active_projects_last_activity" ON "active_projects" ("last_activity_at");
-- Create index "idx_active_projects_slug" to table: "active_projects"
CREATE INDEX "idx_active_projects_slug" ON "active_projects" ("slug");
-- Create index "idx_active_projects_status" to table: "active_projects"
CREATE INDEX "idx_active_projects_status" ON "active_projects" ("status");
-- Create index "idx_active_projects_tier" to table: "active_projects"
CREATE INDEX "idx_active_projects_tier" ON "active_projects" ("activity_tier");
-- Create index "idx_active_projects_visibility" to table: "active_projects"
CREATE INDEX "idx_active_projects_visibility" ON "active_projects" ("proposal_visibility");
