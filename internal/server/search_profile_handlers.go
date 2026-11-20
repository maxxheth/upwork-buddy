package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"go.yaml.in/yaml/v3"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SearchProfileConfig mirrors upwork-scraper-fs ScrapeProfileConfig for JSON/YAML validation.
type SearchProfileConfig struct {
	Name          string                      `yaml:"name" json:"name"`
	Description   string                      `yaml:"description" json:"description"`
	SelectorsFile string                      `yaml:"selectors_file" json:"selectors_file"`
	Transport     SearchTransportConfig       `yaml:"transport" json:"transport"`
	Search        SearchWorkflowConfig        `yaml:"search" json:"search"`
	Filters       SearchFilterWorkflowConfig  `yaml:"filters" json:"filters"`
	Enrichment    SearchEnrichmentConfig      `yaml:"enrichment" json:"enrichment"`
	Output        SearchOutputConfig          `yaml:"output" json:"output"`
}

type SearchTransportConfig struct {
	Adapter                  string  `yaml:"adapter" json:"adapter"`
	ProxyMode                string  `yaml:"proxy_mode" json:"proxy_mode"`
	ProxyIndex               int     `yaml:"proxy_index" json:"proxy_index"`
	ProxyURL                 *string `yaml:"proxy_url" json:"proxy_url,omitempty"`
	MaxTimeoutMs             int     `yaml:"max_timeout_ms" json:"max_timeout_ms"`
	MaxRetries               int     `yaml:"max_retries" json:"max_retries"`
	RetryBackoffSeconds      float64 `yaml:"retry_backoff_seconds" json:"retry_backoff_seconds"`
	JitterRatio              float64 `yaml:"jitter_ratio" json:"jitter_ratio"`
	RateLimitCooldownSeconds float64 `yaml:"rate_limit_cooldown_seconds" json:"rate_limit_cooldown_seconds"`
	AutoScroll               bool    `yaml:"auto_scroll" json:"auto_scroll"`
	MaxScrolls               int     `yaml:"max_scrolls" json:"max_scrolls"`
	ScrollDelayMs            int     `yaml:"scroll_delay_ms" json:"scroll_delay_ms"`
}

type SearchWorkflowConfig struct {
	Mode                     string   `yaml:"mode" json:"mode"`
	Query                    string   `yaml:"query" json:"query"`
	Queries                  []string `yaml:"queries" json:"queries"`
	Sort                     *string  `yaml:"sort" json:"sort,omitempty"`
	PerPage                  *int     `yaml:"per_page" json:"per_page,omitempty"`
	ContractorTier           []int    `yaml:"contractor_tier" json:"contractor_tier"`
	ContractType             *string  `yaml:"contract_type" json:"contract_type,omitempty"`
	ProposalTiers            []string `yaml:"proposal_tiers" json:"proposal_tiers"`
	StartPage                int      `yaml:"start_page" json:"start_page"`
	MaxPages                 int      `yaml:"max_pages" json:"max_pages"`
	TargetJobs               *int     `yaml:"target_jobs" json:"target_jobs,omitempty"`
	DelayBetweenPagesSeconds float64  `yaml:"delay_between_pages_seconds" json:"delay_between_pages_seconds"`
	DeduplicateByURL         *bool    `yaml:"deduplicate_by_url" json:"deduplicate_by_url,omitempty"`
	InputSavedFile           *string  `yaml:"input_saved_file" json:"input_saved_file,omitempty"`
}

type SearchFilterWorkflowConfig struct {
	RequiredKeywords []string `yaml:"required_keywords" json:"required_keywords"`
	ExcludeKeywords  []string `yaml:"exclude_keywords" json:"exclude_keywords"`
	MinScore         *int     `yaml:"min_score" json:"min_score,omitempty"`
	MaxPostedAgeDays *int     `yaml:"max_posted_age_days" json:"max_posted_age_days,omitempty"`
	MaxProposals     *int     `yaml:"max_proposals" json:"max_proposals,omitempty"`
	BudgetMin        *int     `yaml:"budget_min" json:"budget_min,omitempty"`
	BudgetMax        *int     `yaml:"budget_max" json:"budget_max,omitempty"`
}

type SearchEnrichmentConfig struct {
	Enabled                    bool    `yaml:"enabled" json:"enabled"`
	MaxJobsToEnrich            *int    `yaml:"max_jobs_to_enrich" json:"max_jobs_to_enrich,omitempty"`
	DetailRetries              int     `yaml:"detail_retries" json:"detail_retries"`
	DelayBetweenDetailsSeconds float64 `yaml:"delay_between_details_seconds" json:"delay_between_details_seconds"`
	ComputeProposalScores      bool    `yaml:"compute_proposal_scores" json:"compute_proposal_scores"`
}

type SearchOutputConfig struct {
	Directory      string `yaml:"directory" json:"directory"`
	FilenamePrefix string `yaml:"filename_prefix" json:"filename_prefix"`
	SavePerPage    bool   `yaml:"save_per_page" json:"save_per_page"`
	SaveCombined   *bool  `yaml:"save_combined" json:"save_combined,omitempty"`
}

func defaultSearchProfileConfig() SearchProfileConfig {
	perPage := 50
	dedup := true
	saveCombined := true
	return SearchProfileConfig{
		SelectorsFile: "configs/selectors/upwork.yaml",
		Transport: SearchTransportConfig{
			Adapter:                  "flaresolverr",
			ProxyMode:                "rotation",
			MaxTimeoutMs:             60000,
			MaxRetries:               3,
			RetryBackoffSeconds:      2.0,
			JitterRatio:              0.5,
			RateLimitCooldownSeconds: 15.0,
			MaxScrolls:               4,
			ScrollDelayMs:            1200,
		},
		Search: SearchWorkflowConfig{
			Mode:                     "live_search",
			PerPage:                  &perPage,
			Queries:                  []string{},
			ContractorTier:           []int{},
			ProposalTiers:            []string{},
			StartPage:                1,
			MaxPages:                 1,
			DelayBetweenPagesSeconds: 5.0,
			DeduplicateByURL:         &dedup,
		},
		Filters: SearchFilterWorkflowConfig{
			RequiredKeywords: []string{},
			ExcludeKeywords:  []string{},
		},
		Enrichment: SearchEnrichmentConfig{
			DetailRetries:              2,
			DelayBetweenDetailsSeconds: 4.5,
		},
		Output: SearchOutputConfig{
			Directory:      "output",
			FilenamePrefix: "upwork_jobs",
			SaveCombined:   &saveCombined,
		},
	}
}

func normalizeAndValidateSearchProfileConfig(cfg *SearchProfileConfig) error {
	cfg.Name = strings.TrimSpace(cfg.Name)
	if cfg.Name == "" {
		return errors.New("profile name is required")
	}
	if cfg.Search.Queries == nil {
		cfg.Search.Queries = []string{}
	}
	if cfg.Search.ContractorTier == nil {
		cfg.Search.ContractorTier = []int{}
	}
	if cfg.Search.ProposalTiers == nil {
		cfg.Search.ProposalTiers = []string{}
	}
	if cfg.Filters.RequiredKeywords == nil {
		cfg.Filters.RequiredKeywords = []string{}
	}
	if cfg.Filters.ExcludeKeywords == nil {
		cfg.Filters.ExcludeKeywords = []string{}
	}
	if cfg.Transport.JitterRatio < 0.0 || cfg.Transport.JitterRatio > 0.9 {
		return fmt.Errorf("transport.jitter_ratio must be between 0.0 and 0.9, got %v", cfg.Transport.JitterRatio)
	}
	if cfg.Search.Mode != "" {
		switch cfg.Search.Mode {
		case "live_search", "from_saved_output", "best_matches", "most_recent", "saved_jobs":
		default:
			return fmt.Errorf("invalid search.mode %q", cfg.Search.Mode)
		}
	}
	if cfg.Search.Sort != nil && *cfg.Search.Sort != "" {
		switch *cfg.Search.Sort {
		case "recency", "relevance":
		default:
			return fmt.Errorf("invalid search.sort %q", *cfg.Search.Sort)
		}
	}
	if cfg.Search.PerPage != nil {
		switch *cfg.Search.PerPage {
		case 10, 20, 50:
		default:
			return fmt.Errorf("search.per_page must be 10, 20, or 50, got %d", *cfg.Search.PerPage)
		}
	}
	for _, tier := range cfg.Search.ContractorTier {
		if tier < 1 || tier > 3 {
			return fmt.Errorf("search.contractor_tier values must be 1, 2, or 3, got %d", tier)
		}
	}
	if cfg.Search.ContractType != nil && *cfg.Search.ContractType != "" {
		switch *cfg.Search.ContractType {
		case "hourly", "fixed":
		default:
			return fmt.Errorf("invalid search.contract_type %q", *cfg.Search.ContractType)
		}
	}
	if cfg.Search.StartPage < 1 {
		return fmt.Errorf("search.start_page must be >= 1, got %d", cfg.Search.StartPage)
	}
	if cfg.Search.MaxPages < 1 {
		return fmt.Errorf("search.max_pages must be >= 1, got %d", cfg.Search.MaxPages)
	}
	return nil
}

type searchProfileEntry = SearchProfileEntry

// SearchProfileEntry is the API/MCP DTO for a persisted search profile.
type SearchProfileEntry struct {
	ID          uint                `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Config      SearchProfileConfig `json:"config"`
	IsActive    bool                `json:"is_active"`
	LastRunAt   *string             `json:"last_run_at,omitempty"`
	CreatedAt   string              `json:"created_at"`
	UpdatedAt   string              `json:"updated_at"`
}

func searchProfileFromModel(m dbservice.SearchProfile) searchProfileEntry {
	cfg := defaultSearchProfileConfig()
	if len(m.ConfigJSON) > 0 {
		_ = json.Unmarshal(m.ConfigJSON, &cfg)
	}
	if cfg.Name == "" {
		cfg.Name = m.Name
	}
	if cfg.Description == "" {
		cfg.Description = m.Description
	}
	var lastRun *string
	if m.LastRunAt != nil && !m.LastRunAt.IsZero() {
		s := m.LastRunAt.UTC().Format(time.RFC3339)
		lastRun = &s
	}
	return searchProfileEntry{
		ID:          m.ID,
		Name:        m.Name,
		Description: m.Description,
		Config:      cfg,
		IsActive:    m.IsActive,
		LastRunAt:   lastRun,
		CreatedAt:   m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:   m.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func upsertSearchProfileRecord(db *gorm.DB, cfg SearchProfileConfig, isActive bool) (dbservice.SearchProfile, bool, error) {
	configBytes, err := json.Marshal(cfg)
	if err != nil {
		return dbservice.SearchProfile{}, false, err
	}
	now := time.Now().UTC()

	var existing dbservice.SearchProfile
	findErr := db.Where("name = ?", cfg.Name).First(&existing).Error
	created := errors.Is(findErr, gorm.ErrRecordNotFound)
	if findErr != nil && !created {
		return dbservice.SearchProfile{}, false, findErr
	}

	model := dbservice.SearchProfile{
		Name:        cfg.Name,
		Description: cfg.Description,
		ConfigJSON:  dbservice.JSONB(configBytes),
		IsActive:    isActive,
		UpdatedAt:   now,
	}

	if err := db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "name"}},
		DoUpdates: clause.Assignments(map[string]any{
			"description": model.Description,
			"config_json": model.ConfigJSON,
			"is_active":   model.IsActive,
			"updated_at":  now,
		}),
	}).Create(&model).Error; err != nil {
		return dbservice.SearchProfile{}, false, err
	}

	var saved dbservice.SearchProfile
	if err := db.Where("name = ?", cfg.Name).First(&saved).Error; err != nil {
		return model, created, nil
	}
	return saved, created, nil
}

// ListSearchProfiles returns persisted search profiles optionally filtered by is_active.
func (s *Server) ListSearchProfiles(ctx context.Context, active *bool) ([]SearchProfileEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.SearchProfile{})
	if active != nil {
		db = db.Where("is_active = ?", *active)
	}

	var rows []dbservice.SearchProfile
	if err := db.Order("is_active DESC, updated_at DESC, id DESC").Find(&rows).Error; err != nil {
		log.Printf("❌ Failed to list search profiles: %v", err)
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list search profiles"}
	}

	entries := make([]SearchProfileEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, searchProfileFromModel(row))
	}
	return entries, nil
}

// SaveSearchProfile validates and upserts a search profile from JSON bytes.
func (s *Server) SaveSearchProfile(ctx context.Context, raw []byte) (*SearchProfileEntry, bool, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, false, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	cfg, isActive, err := parseSaveSearchProfileRequest(raw)
	if err != nil {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: err.Error()}
	}

	saved, created, err := upsertSearchProfileRecord(s.db.GetGorm().WithContext(ctx), cfg, isActive)
	if err != nil {
		log.Printf("❌ Failed to save search profile %q: %v", cfg.Name, err)
		return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to save search profile"}
	}
	entry := searchProfileFromModel(saved)
	return &entry, created, nil
}

// ImportSearchProfilesYAML decodes single- or multi-document YAML search profiles and persists them.
func (s *Server) ImportSearchProfilesYAML(ctx context.Context, yamlText string, isActive bool, nameOverride string) ([]SearchProfileEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if strings.TrimSpace(yamlText) == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Empty YAML import payload"}
	}

	nameOverride = strings.TrimSpace(nameOverride)
	decoder := yaml.NewDecoder(bytes.NewReader([]byte(yamlText)))
	parsedConfigs := make([]SearchProfileConfig, 0, 1)
	for {
		cfg := defaultSearchProfileConfig()
		err := decoder.Decode(&cfg)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("Invalid YAML profile: %v", err)}
		}
		if nameOverride != "" && len(parsedConfigs) == 0 {
			cfg.Name = nameOverride
		}
		if err := normalizeAndValidateSearchProfileConfig(&cfg); err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: err.Error()}
		}
		parsedConfigs = append(parsedConfigs, cfg)
	}

	if len(parsedConfigs) == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "No search profiles found in YAML payload"}
	}

	imported := make([]SearchProfileEntry, 0, len(parsedConfigs))
	if err := s.db.GetGorm().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		imported = imported[:0]
		for _, cfg := range parsedConfigs {
			saved, _, txErr := upsertSearchProfileRecord(tx, cfg, isActive)
			if txErr != nil {
				return txErr
			}
			imported = append(imported, searchProfileFromModel(saved))
		}
		return nil
	}); err != nil {
		log.Printf("❌ Failed to import search profiles: %v", err)
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to import search profile"}
	}
	return imported, nil
}

// DeleteSearchProfile removes a search profile by numeric id or name.
func (s *Server) DeleteSearchProfile(ctx context.Context, id uint64, name string) error {
	if s.db == nil || s.db.GetGorm() == nil {
		return &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	var res *gorm.DB
	if id > 0 {
		res = gormDB.Delete(&dbservice.SearchProfile{}, id)
	} else if trimmedName := strings.TrimSpace(name); trimmedName != "" {
		res = gormDB.Where("name = ?", trimmedName).Delete(&dbservice.SearchProfile{})
	} else {
		return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "search profile id or name is required"}
	}
	if res.Error != nil {
		return &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to delete search profile"}
	}
	if res.RowsAffected == 0 {
		return &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Search profile not found"}
	}
	return nil
}

// RunSearchProfile executes a persisted search profile by numeric ID or profile name.
func (s *Server) RunSearchProfile(ctx context.Context, id *uint, name string) (*SearchJobsResponse, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	var resolvedID uint
	if id != nil && *id > 0 {
		resolvedID = *id
	} else if trimmedName := strings.TrimSpace(name); trimmedName != "" {
		var row dbservice.SearchProfile
		if err := s.db.GetGorm().WithContext(ctx).Where("name = ?", trimmedName).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, errSearchProfileNotFound
			}
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load search profile"}
		}
		resolvedID = row.ID
	} else {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "search profile id or name is required"}
	}
	return s.ExecuteSearchPipeline(ctx, SearchJobsRequest{
		ProfileID: &resolvedID,
	})
}

func (s *Server) listSearchProfilesHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var activeFilter *bool
	if activeRaw := strings.TrimSpace(r.URL.Query().Get("active")); activeRaw != "" {
		activeBool, err := strconv.ParseBool(activeRaw)
		if err != nil {
			respondWithError(w, http.StatusBadRequest, "Invalid active query parameter")
			return
		}
		activeFilter = &activeBool
	}

	entries, err := s.ListSearchProfiles(r.Context(), activeFilter)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, map[string]any{
		"profiles": entries,
	})
}

type saveSearchProfileRequest struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	IsActive    *bool           `json:"is_active"`
	Config      json.RawMessage `json:"config"`
}

func parseSaveSearchProfileRequest(raw []byte) (SearchProfileConfig, bool, error) {
	var wrapper saveSearchProfileRequest
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return SearchProfileConfig{}, false, errors.New("invalid request body")
	}

	cfg := defaultSearchProfileConfig()
	trimmedConfig := bytes.TrimSpace(wrapper.Config)
	if len(trimmedConfig) > 0 && !bytes.Equal(trimmedConfig, []byte("null")) {
		if err := json.Unmarshal(trimmedConfig, &cfg); err != nil {
			return SearchProfileConfig{}, false, errors.New("invalid search profile configuration")
		}
	} else {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return SearchProfileConfig{}, false, errors.New("invalid search profile configuration")
		}
	}

	if strings.TrimSpace(wrapper.Name) != "" {
		cfg.Name = wrapper.Name
	}
	if strings.TrimSpace(wrapper.Description) != "" {
		cfg.Description = wrapper.Description
	}

	if err := normalizeAndValidateSearchProfileConfig(&cfg); err != nil {
		return SearchProfileConfig{}, false, err
	}

	isActive := true
	if wrapper.IsActive != nil {
		isActive = *wrapper.IsActive
	}
	return cfg, isActive, nil
}

func (s *Server) saveSearchProfileHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	raw, err := io.ReadAll(r.Body)
	if err != nil {
		respondWithError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}

	saved, created, err := s.SaveSearchProfile(r.Context(), raw)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	statusCode := http.StatusOK
	if created {
		statusCode = http.StatusCreated
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(map[string]any{
		"profile": saved,
	}); err != nil {
		log.Printf("⚠️ Failed to encode search profile response: %v", err)
	}
}

func (s *Server) deleteSearchProfileHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	idStr := r.PathValue("id")
	if idStr == "" {
		idStr = strings.TrimPrefix(r.URL.Path, "/api/search-profiles/")
	}
	id, err := strconv.ParseUint(strings.TrimSpace(idStr), 10, 64)
	if err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid search profile ID")
		return
	}

	if err := s.DeleteSearchProfile(r.Context(), id, ""); err != nil {
		respondBridgeError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type importSearchProfilesJSONRequest struct {
	YAML         string `json:"yaml"`
	IsActive     *bool  `json:"is_active"`
	NameOverride string `json:"name_override"`
}

func (s *Server) importSearchProfilesHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		respondWithError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}
	if len(bytes.TrimSpace(rawBody)) == 0 {
		respondWithError(w, http.StatusBadRequest, "Empty YAML import payload")
		return
	}

	yamlSource := string(rawBody)
	isActive := true
	nameOverride := ""

	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.Contains(contentType, "application/json") {
		var req importSearchProfilesJSONRequest
		if err := json.Unmarshal(rawBody, &req); err != nil {
			respondWithError(w, http.StatusBadRequest, "Invalid JSON request body")
			return
		}
		if strings.TrimSpace(req.YAML) == "" {
			respondWithError(w, http.StatusBadRequest, "yaml field is required")
			return
		}
		yamlSource = req.YAML
		if req.IsActive != nil {
			isActive = *req.IsActive
		}
		nameOverride = strings.TrimSpace(req.NameOverride)
	}

	imported, err := s.ImportSearchProfilesYAML(r.Context(), yamlSource, isActive, nameOverride)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, map[string]any{
		"profiles": imported,
		"imported": len(imported),
	})
}
