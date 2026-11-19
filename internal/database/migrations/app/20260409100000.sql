-- Rename legacy "spec_sheet_prompt" column if present on pre-existing databases
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'spec_sheet_prompt'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'execution_prompt'
  ) THEN
    ALTER TABLE "public"."jobs" RENAME COLUMN "spec_sheet_prompt" TO "execution_prompt";
  END IF;
END $$;

-- Ensure all Job columns defined in schema.go exist on clean databases
ALTER TABLE "public"."jobs"
  ADD COLUMN IF NOT EXISTS "budget" text NULL,
  ADD COLUMN IF NOT EXISTS "skills" text NULL,
  ADD COLUMN IF NOT EXISTS "proposal" text NULL,
  ADD COLUMN IF NOT EXISTS "time_estimate" text NULL,
  ADD COLUMN IF NOT EXISTS "workload_division" text NULL,
  ADD COLUMN IF NOT EXISTS "questions_for_client" text NULL,
  ADD COLUMN IF NOT EXISTS "tips_and_advice" text NULL,
  ADD COLUMN IF NOT EXISTS "execution_prompt" text NULL,
  ADD COLUMN IF NOT EXISTS "tone_analysis" text NULL;
