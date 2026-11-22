package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/gorm"
)

// SearchRunSummary is the API/MCP DTO for a persisted discovery/ingestion search run.
type SearchRunSummary struct {
	ID                  uint            `json:"id"`
	Label               string          `json:"label"`
	Source              string          `json:"source"`
	TriggeredBy         string          `json:"triggered_by"`
	ProfileID           *uint           `json:"profile_id,omitempty"`
	ProjectKeys         []string        `json:"project_keys"`
	Queries             []string        `json:"queries"`
	Criteria            json.RawMessage `json:"criteria,omitempty"`
	TotalScraped        int             `json:"total_scraped"`
	FilteredCount       int             `json:"filtered_count"`
	PersistedCount      int             `json:"persisted_count"`
	DetailEnrichedCount int             `json:"detail_enriched_count"`
	StoppedReason       string          `json:"stopped_reason"`
	CreatedAt           string          `json:"created_at"`
}

// SearchRunDetailResponse returns a single search run and its linked jobs.
type SearchRunDetailResponse struct {
	SearchRun SearchRunSummary `json:"search_run"`
	Jobs      []JobEntry       `json:"jobs"`
}

func searchRunSummaryFromModel(m dbservice.SearchRun) SearchRunSummary {
	return SearchRunSummary{
		ID:                  m.ID,
		Label:               m.Label,
		Source:              m.Source,
		TriggeredBy:         m.TriggeredBy,
		ProfileID:           m.ProfileID,
		ProjectKeys:         decodeStringSliceJSONB(m.ProjectKeysJSON),
		Queries:             decodeStringSliceJSONB(m.QueriesJSON),
		Criteria:            rawJSONFromJSONB(m.CriteriaJSON),
		TotalScraped:        m.TotalScraped,
		FilteredCount:       m.FilteredCount,
		PersistedCount:      m.PersistedCount,
		DetailEnrichedCount: m.DetailEnrichedCount,
		StoppedReason:       m.StoppedReason,
		CreatedAt:           m.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func (s *Server) buildSearchRunDashboardURL(runID uint) string {
	if s == nil || runID == 0 {
		return ""
	}
	return s.BuildDashboardURL(fmt.Sprintf("run=%d", runID))
}

// ListSearchRuns returns persisted search runs ordered newest-first alongside the total count.
func (s *Server) ListSearchRuns(ctx context.Context, limit, offset int) ([]SearchRunSummary, int, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, 0, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if limit < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid limit parameter"}
	}
	if offset < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid offset parameter"}
	}
	if limit == 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}

	gormDB := s.db.GetGorm().WithContext(ctx)

	var total64 int64
	if err := gormDB.Model(&dbservice.SearchRun{}).Count(&total64).Error; err != nil {
		log.Printf("❌ Failed to count search runs: %v", err)
		return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list search runs"}
	}

	var rows []dbservice.SearchRun
	if err := gormDB.
		Order("created_at DESC, id DESC").
		Limit(limit).
		Offset(offset).
		Find(&rows).Error; err != nil {
		log.Printf("❌ Failed to list search runs: %v", err)
		return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list search runs"}
	}

	runs := make([]SearchRunSummary, 0, len(rows))
	for _, row := range rows {
		runs = append(runs, searchRunSummaryFromModel(row))
	}
	return runs, int(total64), nil
}

// GetSearchRun fetches a single search run and all linked jobs ordered by score descending.
func (s *Server) GetSearchRun(ctx context.Context, id uint) (*SearchRunDetailResponse, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if id == 0 || uint64(id) > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid search run ID"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)

	var run dbservice.SearchRun
	if err := gormDB.First(&run, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Search run not found"}
		}
		log.Printf("❌ Failed to load search run %d: %v", id, err)
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load search run"}
	}

	var jobs []dbservice.Job
	if err := gormDB.
		Joins("JOIN search_run_jobs ON search_run_jobs.job_id = jobs.id").
		Where("search_run_jobs.search_run_id = ?", run.ID).
		Order("COALESCE(jobs.score, -1) DESC, jobs.created_at DESC, jobs.id DESC").
		Find(&jobs).Error; err != nil {
		log.Printf("❌ Failed to load jobs for search run %d: %v", id, err)
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load search run jobs"}
	}

	entries := make([]JobEntry, 0, len(jobs))
	for _, j := range jobs {
		entries = append(entries, jobEntryFromModel(j))
	}

	return &SearchRunDetailResponse{
		SearchRun: searchRunSummaryFromModel(run),
		Jobs:      entries,
	}, nil
}

func (s *Server) listSearchRunsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	limit := 0
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v <= 0 {
			respondBridgeError(w, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid limit parameter"})
			return
		}
		limit = v
	}

	offset := 0
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		v, err := strconv.Atoi(rawOffset)
		if err != nil || v < 0 {
			respondBridgeError(w, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid offset parameter"})
			return
		}
		offset = v
	}

	runs, total, err := s.ListSearchRuns(r.Context(), limit, offset)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, map[string]any{
		"search_runs": runs,
		"total":       total,
	})
}

func (s *Server) getSearchRunHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	idStr := strings.TrimSpace(r.PathValue("id"))
	if idStr == "" {
		idStr = strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/api/search-runs/"))
	}
	idVal, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil || idVal == 0 || idVal > math.MaxInt64 {
		respondBridgeError(w, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid search run ID"})
		return
	}

	res, err := s.GetSearchRun(r.Context(), uint(idVal))
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, res)
}
