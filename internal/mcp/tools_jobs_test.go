package mcp

import (
	"encoding/json"
	"testing"

	"upwork-buddy/internal/server"
)

func TestToCompactJobEntryIncludesMatchedActiveProjects(t *testing.T) {
	entry := server.JobEntry{
		ID:             56,
		JobTitle:       "Senior Go + PostgreSQL Backend Engineer",
		ScoreBreakdown: json.RawMessage(`{"matched_active_projects":["upwork-buddy","backup-utility"]}`),
	}

	compact := toCompactJobEntry(entry)
	if len(compact.MatchedActiveProjects) != 2 ||
		compact.MatchedActiveProjects[0] != "upwork-buddy" ||
		compact.MatchedActiveProjects[1] != "backup-utility" {
		t.Fatalf("expected matched_active_projects=[upwork-buddy backup-utility], got %+v", compact.MatchedActiveProjects)
	}

	empty := toCompactJobEntry(server.JobEntry{ID: 57, JobTitle: "No Matches"})
	if len(empty.MatchedActiveProjects) != 0 {
		t.Fatalf("expected empty matched_active_projects, got %+v", empty.MatchedActiveProjects)
	}
}
