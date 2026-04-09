-- Rename "spec_sheet_prompt" column to "execution_prompt" on "jobs" table
ALTER TABLE "public"."jobs" RENAME COLUMN "spec_sheet_prompt" TO "execution_prompt";