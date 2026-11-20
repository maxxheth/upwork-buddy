package diagnostics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleSelectorsYAML = `# Upwork Buddy Selector Registry
version: "2.0"
site: "upwork.com"
base_url: "https://www.upwork.com"

views:
  job_detail:
    container_selectors:
      - ".job-details-content"
    fields:
      skills:
        # Existing comment to preserve
        selectors:
          - '[data-test="Skill"] a.air3-badge .air3-line-clamp'
          - '[data-test="token"]'
        extract: list
        is_fragile: true
        fragile_reason: "Vue scoped hash fallback"
        required: false
      title:
        selectors:
          - ".job-details-card h4 span.flex-1"
        extract: text
        required: true
`

func writeTempSelectorsYAML(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "upwork.yaml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write temp selectors yaml: %v", err)
	}
	return path
}

func TestPreviewPatch_PreservesCommentsPrependsReplacesAndRejectsInvalid(t *testing.T) {
	yamlPath := writeTempSelectorsYAML(t, sampleSelectorsYAML)

	// 1. Default prepend mode preserves existing fallbacks & comments and clears stale is_fragile
	prev, err := PreviewPatch(yamlPath, FieldRulePatch{
		View:      "job_detail",
		Field:     "skills",
		Selectors: []string{".new-skill-chips .air3-skill-chip span"},
	})
	if err != nil {
		t.Fatalf("PreviewPatch failed: %v", err)
	}
	if prev.OldVersion != "2.0" || prev.NewVersion != "2.0.1" {
		t.Fatalf("unexpected version bump: %q -> %q", prev.OldVersion, prev.NewVersion)
	}
	outStr := string(prev.NewYAML)
	if !strings.Contains(outStr, "# Existing comment to preserve") {
		t.Fatalf("expected existing YAML comment to be preserved:\n%s", outStr)
	}
	if !strings.Contains(outStr, ".new-skill-chips .air3-skill-chip span") ||
		(!strings.Contains(outStr, `data-test="Skill"`) && !strings.Contains(outStr, `data-test=\"Skill\"`)) {
		t.Fatalf("expected prepend mode to keep old fallback selector:\n%s", outStr)
	}
	if strings.Contains(outStr, "is_fragile") {
		t.Fatalf("expected stale is_fragile to be cleared after stable non-data-v patch:\n%s", outStr)
	}
	if !strings.Contains(prev.Diff, "+") {
		t.Fatalf("expected non-empty unified diff")
	}

	// 2. Replace mode replaces old selectors
	replaced, err := PreviewPatch(yamlPath, FieldRulePatch{
		View:      "job_detail",
		Field:     "skills",
		Selectors: []string{".only-new-skill"},
		Extract:   "list",
		Mode:      "replace",
	})
	if err != nil {
		t.Fatalf("PreviewPatch replace failed: %v", err)
	}
	if strings.Contains(string(replaced.NewYAML), `data-test="token"`) {
		t.Fatalf("expected replace mode to remove old selectors:\n%s", string(replaced.NewYAML))
	}

	// 3. Reject invalid inputs
	invalidCases := []FieldRulePatch{
		{View: "", Field: "skills", Selectors: []string{".x"}},
		{View: "job_detail", Field: "skills", Selectors: []string{}},
		{View: "job_detail", Field: "skills", Selectors: []string{".unbalanced["}},
		{View: "job_detail", Field: "skills", Selectors: []string{".x"}, Extract: "bogus_extract"},
		{View: "job_detail", Field: "skills", Selectors: []string{".x"}, Mode: "append"},
	}
	for i, tc := range invalidCases {
		if _, prevErr := PreviewPatch(yamlPath, tc); prevErr == nil {
			t.Errorf("case %d (%+v): expected validation error", i, tc)
		}
	}
}

func TestApplyPatchAndRollbackLatest(t *testing.T) {
	yamlPath := writeTempSelectorsYAML(t, sampleSelectorsYAML)
	backupDir := DefaultBackupDir(yamlPath)

	applied, err := ApplyPatch(yamlPath, backupDir, FieldRulePatch{
		View:      "job_detail",
		Field:     "skills",
		Selectors: []string{".new-skill-chips li span"},
		Extract:   "list",
		Reason:    "Patched broken skills drawer",
	})
	if err != nil {
		t.Fatalf("ApplyPatch failed: %v", err)
	}
	if applied.NewVersion != "2.0.1" {
		t.Fatalf("expected version 2.0.1, got %q", applied.NewVersion)
	}
	if _, statErr := os.Stat(applied.BackupPath); statErr != nil {
		t.Fatalf("expected backup file on disk %q: %v", applied.BackupPath, statErr)
	}
	patchedRaw, err := os.ReadFile(yamlPath)
	if err != nil || !strings.Contains(string(patchedRaw), ".new-skill-chips li span") {
		t.Fatalf("expected patched YAML on disk, got:\n%s", string(patchedRaw))
	}

	// Second patch bumps 2.0.1 -> 2.0.2
	applied2, err := ApplyPatch(yamlPath, backupDir, FieldRulePatch{
		View:      "job_detail",
		Field:     "title",
		Selectors: []string{"h1.new-title"},
	})
	if err != nil {
		t.Fatalf("second ApplyPatch failed: %v", err)
	}
	if applied2.NewVersion != "2.0.2" {
		t.Fatalf("expected version 2.0.2, got %q", applied2.NewVersion)
	}

	// Path traversal in backupFile must be rejected
	if _, travErr := RollbackLatest(yamlPath, backupDir, "../../etc/passwd.yaml"); travErr == nil {
		t.Fatal("expected path traversal backup_file to be rejected")
	}

	// Restore specific first backup -> back to 2.0 original
	rolled, err := RollbackLatest(yamlPath, backupDir, applied.BackupFile)
	if err != nil {
		t.Fatalf("RollbackLatest failed: %v", err)
	}
	if rolled.Version != "2.0" {
		t.Fatalf("expected rolled back version 2.0, got %q", rolled.Version)
	}
	restoredRaw, err := os.ReadFile(yamlPath)
	if err != nil {
		t.Fatalf("read restored yaml: %v", err)
	}
	if strings.Contains(string(restoredRaw), ".new-skill-chips li span") {
		t.Fatalf("expected restored YAML to revert patched selector:\n%s", string(restoredRaw))
	}
}
