package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/gorm"
)

// ActiveProjectEntry is the API/MCP representation of a tracked active project.
type ActiveProjectEntry struct {
	ID                  uint       `json:"id"`
	ProjectKey          string     `json:"project_key"`
	Slug                string     `json:"slug"`
	Name                string     `json:"name"`
	Path                string     `json:"path"`
	GroupName           string     `json:"group_name"`
	ActivityTier        string     `json:"activity_tier"`
	Status              string     `json:"status"`
	Client              string     `json:"client"`
	ProposalVisibility  string     `json:"proposal_visibility"`
	PublicAlias         string     `json:"public_alias"`
	TechStack           []string   `json:"tech_stack"`
	Summary             string     `json:"summary"`
	ReadmeHint          string     `json:"readme_hint"`
	NextActions         []string   `json:"next_actions"`
	Blockers            []string   `json:"blockers"`
	Notes               string     `json:"notes"`
	Pinned              bool       `json:"pinned"`
	IsGitRepo           bool       `json:"is_git_repo"`
	GitBranch           string     `json:"git_branch"`
	GitHead             string     `json:"git_head"`
	GitDirtyCount       int        `json:"git_dirty_count"`
	LastCommitAt        *time.Time `json:"last_commit_at,omitempty"`
	LastCommitSubject   string     `json:"last_commit_subject"`
	Commits7d           int        `json:"commits_7d"`
	LastClaudeSessionAt *time.Time `json:"last_claude_session_at,omitempty"`
	LastAntigravityAt   *time.Time `json:"last_antigravity_at,omitempty"`
	LastActivityAt      *time.Time `json:"last_activity_at,omitempty"`
	CuratedUpdatedAt    *time.Time `json:"curated_updated_at,omitempty"`
	CuratedUpdatedBy    string     `json:"curated_updated_by"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

// SyncActiveProjectItem is a single project payload sent to POST /api/active-projects/sync.
type SyncActiveProjectItem struct {
	ProjectKey          string     `json:"project_key"`
	Slug                string     `json:"slug"`
	Name                string     `json:"name"`
	Path                string     `json:"path"`
	GroupName           string     `json:"group_name"`
	Group               string     `json:"group"`
	ActivityTier        string     `json:"activity_tier"`
	Status              string     `json:"status"`
	Client              string     `json:"client"`
	ProposalVisibility  string     `json:"proposal_visibility"`
	PublicAlias         string     `json:"public_alias"`
	TechStack           []string   `json:"tech_stack"`
	Summary             string     `json:"summary"`
	ReadmeHint          string     `json:"readme_hint"`
	NextActions         []string   `json:"next_actions"`
	Blockers            []string   `json:"blockers"`
	Notes               string     `json:"notes"`
	Pinned              *bool      `json:"pinned"`
	IsGitRepo           bool       `json:"is_git_repo"`
	GitBranch           string     `json:"git_branch"`
	GitHead             string     `json:"git_head"`
	GitDirtyCount       int        `json:"git_dirty_count"`
	LastCommitAt        *time.Time `json:"last_commit_at"`
	LastCommitSubject   string     `json:"last_commit_subject"`
	Commits7d           int        `json:"commits_7d"`
	LastClaudeSessionAt *time.Time `json:"last_claude_session_at"`
	LastAntigravityAt   *time.Time `json:"last_antigravity_at"`
	LastActivityAt      *time.Time `json:"last_activity_at"`
	CuratedUpdatedAt    *time.Time `json:"curated_updated_at"`
	CuratedUpdatedBy    string     `json:"curated_updated_by"`
}

// SyncActiveProjectsRequest wraps bulk active-project sync items.
type SyncActiveProjectsRequest struct {
	Projects []SyncActiveProjectItem `json:"projects"`
}

// SyncActiveProjectsResult summarizes a bulk sync operation.
type SyncActiveProjectsResult struct {
	Synced   int                  `json:"synced"`
	Created  int                  `json:"created"`
	Updated  int                  `json:"updated"`
	Projects []ActiveProjectEntry `json:"projects"`
}

// ListActiveProjectsFilter controls filtering and pagination for ListActiveProjects.
type ListActiveProjectsFilter struct {
	Tier       string
	Status     string
	Visibility string
	Query      string
	Limit      int
}

// UpdateActiveProjectInput carries partial curated updates for an active project.
type UpdateActiveProjectInput struct {
	Status             *string   `json:"status"`
	Client             *string   `json:"client"`
	ProposalVisibility *string   `json:"proposal_visibility"`
	PublicAlias        *string   `json:"public_alias"`
	Summary            *string   `json:"summary"`
	NextActions        *[]string `json:"next_actions"`
	Blockers           *[]string `json:"blockers"`
	Notes              *string   `json:"notes"`
	Pinned             *bool     `json:"pinned"`
	UpdatedBy          string    `json:"updated_by"`
}

// DefaultProposalVisibility returns "anonymized" for confidential client groups and "public" otherwise.
func DefaultProposalVisibility(groupName string) string {
	switch strings.ToLower(strings.TrimSpace(groupName)) {
	case "marvenio", "brandon-johnson-ventures":
		return "anonymized"
	default:
		return "public"
	}
}

func normalizeProposalVisibility(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return "", nil
	}
	switch v {
	case "public", "anonymized", "private":
		return v, nil
	default:
		return "", &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("invalid proposal_visibility %q: must be public, anonymized, or private", raw),
		}
	}
}

func encodeStringSliceJSONB(items []string) (dbservice.JSONB, error) {
	cleaned := make([]string, 0, len(items))
	for _, item := range items {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	b, err := json.Marshal(cleaned)
	if err != nil {
		return nil, err
	}
	return dbservice.JSONB(b), nil
}

func decodeStringSliceJSONB(raw dbservice.JSONB) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return []string{}
	}
	if out == nil {
		return []string{}
	}
	return out
}

func isJSONBStringSliceEmpty(raw dbservice.JSONB) bool {
	return len(decodeStringSliceJSONB(raw)) == 0
}

func activeProjectToEntry(p dbservice.ActiveProject) ActiveProjectEntry {
	return ActiveProjectEntry{
		ID:                  p.ID,
		ProjectKey:          p.ProjectKey,
		Slug:                p.Slug,
		Name:                p.Name,
		Path:                p.Path,
		GroupName:           p.GroupName,
		ActivityTier:        p.ActivityTier,
		Status:              p.Status,
		Client:              p.Client,
		ProposalVisibility:  p.ProposalVisibility,
		PublicAlias:         p.PublicAlias,
		TechStack:           decodeStringSliceJSONB(p.TechStackJSON),
		Summary:             p.Summary,
		ReadmeHint:          p.ReadmeHint,
		NextActions:         decodeStringSliceJSONB(p.NextActionsJSON),
		Blockers:            decodeStringSliceJSONB(p.BlockersJSON),
		Notes:               p.Notes,
		Pinned:              p.Pinned,
		IsGitRepo:           p.IsGitRepo,
		GitBranch:           p.GitBranch,
		GitHead:             p.GitHead,
		GitDirtyCount:       p.GitDirtyCount,
		LastCommitAt:        p.LastCommitAt,
		LastCommitSubject:   p.LastCommitSubject,
		Commits7d:           p.Commits7d,
		LastClaudeSessionAt: p.LastClaudeSessionAt,
		LastAntigravityAt:   p.LastAntigravityAt,
		LastActivityAt:      p.LastActivityAt,
		CuratedUpdatedAt:    p.CuratedUpdatedAt,
		CuratedUpdatedBy:    p.CuratedUpdatedBy,
		CreatedAt:           p.CreatedAt,
		UpdatedAt:           p.UpdatedAt,
	}
}

func stripSensitiveProjectTokens(text string, p dbservice.ActiveProject) string {
	out := strings.TrimSpace(text)
	if out == "" {
		return ""
	}
	tokens := make([]string, 0, 10)
	for _, raw := range []string{p.Path, p.ProjectKey, p.Name, p.Client, p.GroupName, p.Slug} {
		t := strings.TrimSpace(raw)
		if t == "" || strings.EqualFold(t, "standalone") {
			continue
		}
		tokens = append(tokens, t)
	}
	for _, raw := range []string{p.GroupName, p.Client, p.Name, p.Slug} {
		t := strings.TrimSpace(raw)
		if t == "" || strings.EqualFold(t, "standalone") || !strings.ContainsAny(t, "-_") {
			continue
		}
		spaceForm := strings.Join(strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(t)), " ")
		if spaceForm != "" && !strings.EqualFold(spaceForm, "standalone") {
			tokens = append(tokens, spaceForm)
		}
	}
	// Replace longest tokens first so full paths or multi-word names are stripped before substrings.
	sort.Slice(tokens, func(i, j int) bool {
		return len(tokens[i]) > len(tokens[j])
	})

	for _, tok := range tokens {
		re, err := regexp.Compile("(?i)" + regexp.QuoteMeta(tok))
		if err != nil {
			continue
		}
		out = re.ReplaceAllString(out, "")
	}

	fields := strings.Fields(out)
	out = strings.Join(fields, " ")
	out = strings.TrimSpace(strings.Trim(out, ":-,;"))
	return out
}

// SanitizedActiveProjectDisplay formats an ActiveProject safely for prompt injection according to proposal_visibility.
func SanitizedActiveProjectDisplay(p dbservice.ActiveProject) (displayName string, safeSummary string, safeRecentFocus string, ok bool) {
	vis := strings.ToLower(strings.TrimSpace(p.ProposalVisibility))
	if vis == "private" {
		return "", "", "", false
	}

	stack := decodeStringSliceJSONB(p.TechStackJSON)

	if vis == "public" {
		displayName = strings.TrimSpace(p.PublicAlias)
		if displayName == "" {
			displayName = strings.TrimSpace(p.Name)
		}
		safeSummary = strings.TrimSpace(p.Summary)
		if safeSummary == "" {
			safeSummary = strings.TrimSpace(p.ReadmeHint)
		}
		safeRecentFocus = strings.TrimSpace(p.LastCommitSubject)
		return displayName, safeSummary, safeRecentFocus, true
	}

	// Default / "anonymized": never expose Name, Client, Path, GroupName, LastCommitSubject, or ReadmeHint.
	displayName = stripSensitiveProjectTokens(p.PublicAlias, p)
	if displayName == "" {
		if len(stack) > 0 {
			top3 := stack
			if len(top3) > 3 {
				top3 = top3[:3]
			}
			displayName = "Active client project (" + strings.Join(top3, ", ") + ")"
		} else {
			displayName = "Active client project"
		}
	}

	safeSummary = stripSensitiveProjectTokens(p.Summary, p)
	if safeSummary == "" {
		if len(stack) > 0 {
			top5 := stack
			if len(top5) > 5 {
				top5 = top5[:5]
			}
			safeSummary = "Ongoing client engineering engagement using " + strings.Join(top5, ", ")
		} else {
			safeSummary = "Ongoing client engineering engagement"
		}
	}

	return displayName, safeSummary, "", true
}

// SyncActiveProjects performs a transactional bulk upsert of workspace projects keyed by project_key.
func (s *Server) SyncActiveProjects(ctx context.Context, req SyncActiveProjectsRequest) (*SyncActiveProjectsResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	for i, item := range req.Projects {
		if strings.TrimSpace(item.ProjectKey) == "" {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("projects[%d].project_key is required", i),
			}
		}
		if strings.TrimSpace(item.Name) == "" {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("projects[%d].name is required", i),
			}
		}
		if _, err := normalizeProposalVisibility(item.ProposalVisibility); err != nil {
			return nil, err
		}
	}

	res := &SyncActiveProjectsResult{
		Projects: make([]ActiveProjectEntry, 0, len(req.Projects)),
	}

	err := s.db.GetGorm().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, item := range req.Projects {
			key := strings.TrimSpace(item.ProjectKey)
			groupName := strings.TrimSpace(item.GroupName)
			if groupName == "" {
				groupName = strings.TrimSpace(item.Group)
			}
			if groupName == "" {
				groupName = "standalone"
			}
			tier := strings.ToLower(strings.TrimSpace(item.ActivityTier))
			if tier == "" {
				tier = "paused"
			}
			vis, err := normalizeProposalVisibility(item.ProposalVisibility)
			if err != nil {
				return err
			}
			techJSON, err := encodeStringSliceJSONB(item.TechStack)
			if err != nil {
				return err
			}
			nextJSON, err := encodeStringSliceJSONB(item.NextActions)
			if err != nil {
				return err
			}
			blockersJSON, err := encodeStringSliceJSONB(item.Blockers)
			if err != nil {
				return err
			}

			var existing dbservice.ActiveProject
			findErr := tx.Where("project_key = ?", key).First(&existing).Error
			if errors.Is(findErr, gorm.ErrRecordNotFound) {
				if vis == "" {
					vis = DefaultProposalVisibility(groupName)
				}
				status := strings.TrimSpace(item.Status)
				if status == "" {
					status = "active"
				}
				pinned := false
				if item.Pinned != nil {
					pinned = *item.Pinned
				}

				rec := dbservice.ActiveProject{
					ProjectKey:          key,
					Slug:                strings.TrimSpace(item.Slug),
					Name:                strings.TrimSpace(item.Name),
					Path:                strings.TrimSpace(item.Path),
					GroupName:           groupName,
					ActivityTier:        tier,
					Status:              status,
					Client:              strings.TrimSpace(item.Client),
					ProposalVisibility:  vis,
					PublicAlias:         strings.TrimSpace(item.PublicAlias),
					TechStackJSON:       techJSON,
					Summary:             strings.TrimSpace(item.Summary),
					ReadmeHint:          strings.TrimSpace(item.ReadmeHint),
					NextActionsJSON:     nextJSON,
					BlockersJSON:        blockersJSON,
					Notes:               strings.TrimSpace(item.Notes),
					Pinned:              pinned,
					IsGitRepo:           item.IsGitRepo,
					GitBranch:           strings.TrimSpace(item.GitBranch),
					GitHead:             strings.TrimSpace(item.GitHead),
					GitDirtyCount:       item.GitDirtyCount,
					LastCommitAt:        item.LastCommitAt,
					LastCommitSubject:   strings.TrimSpace(item.LastCommitSubject),
					Commits7d:           item.Commits7d,
					LastClaudeSessionAt: item.LastClaudeSessionAt,
					LastAntigravityAt:   item.LastAntigravityAt,
					LastActivityAt:      item.LastActivityAt,
					CuratedUpdatedAt:    item.CuratedUpdatedAt,
					CuratedUpdatedBy:    strings.TrimSpace(item.CuratedUpdatedBy),
				}
				if err := tx.Create(&rec).Error; err != nil {
					return err
				}
				res.Created++
				res.Synced++
				res.Projects = append(res.Projects, activeProjectToEntry(rec))
				continue
			}
			if findErr != nil {
				return findErr
			}

			// Always update telemetry fields.
			if slug := strings.TrimSpace(item.Slug); slug != "" {
				existing.Slug = slug
			}
			existing.Name = strings.TrimSpace(item.Name)
			existing.Path = strings.TrimSpace(item.Path)
			existing.GroupName = groupName
			existing.ActivityTier = tier
			existing.IsGitRepo = item.IsGitRepo
			existing.GitBranch = strings.TrimSpace(item.GitBranch)
			existing.GitHead = strings.TrimSpace(item.GitHead)
			existing.GitDirtyCount = item.GitDirtyCount
			existing.LastCommitAt = item.LastCommitAt
			existing.LastCommitSubject = strings.TrimSpace(item.LastCommitSubject)
			existing.Commits7d = item.Commits7d
			if item.TechStack != nil {
				existing.TechStackJSON = techJSON
			}
			existing.ReadmeHint = strings.TrimSpace(item.ReadmeHint)
			existing.LastClaudeSessionAt = item.LastClaudeSessionAt
			existing.LastAntigravityAt = item.LastAntigravityAt
			existing.LastActivityAt = item.LastActivityAt

			// Preserve curated fields unless incoming has strictly newer curated_updated_at
			// OR existing DB field is empty and incoming is non-empty.
			incomingNewer := item.CuratedUpdatedAt != nil &&
				(existing.CuratedUpdatedAt == nil || item.CuratedUpdatedAt.After(*existing.CuratedUpdatedAt))

			if sVal := strings.TrimSpace(item.Summary); sVal != "" && (incomingNewer || strings.TrimSpace(existing.Summary) == "") {
				existing.Summary = sVal
			}
			if vis != "" && (incomingNewer || strings.TrimSpace(existing.ProposalVisibility) == "") {
				existing.ProposalVisibility = vis
			}
			if aVal := strings.TrimSpace(item.PublicAlias); aVal != "" && (incomingNewer || strings.TrimSpace(existing.PublicAlias) == "") {
				existing.PublicAlias = aVal
			}
			if stVal := strings.TrimSpace(item.Status); stVal != "" && (incomingNewer || strings.TrimSpace(existing.Status) == "") {
				existing.Status = stVal
			}
			if cVal := strings.TrimSpace(item.Client); cVal != "" && (incomingNewer || strings.TrimSpace(existing.Client) == "") {
				existing.Client = cVal
			}
			if (incomingNewer && item.NextActions != nil) || (!isJSONBStringSliceEmpty(nextJSON) && isJSONBStringSliceEmpty(existing.NextActionsJSON)) {
				existing.NextActionsJSON = nextJSON
			}
			if (incomingNewer && item.Blockers != nil) || (!isJSONBStringSliceEmpty(blockersJSON) && isJSONBStringSliceEmpty(existing.BlockersJSON)) {
				existing.BlockersJSON = blockersJSON
			}
			if nVal := strings.TrimSpace(item.Notes); nVal != "" && (incomingNewer || strings.TrimSpace(existing.Notes) == "") {
				existing.Notes = nVal
			}
			if item.Pinned != nil && (incomingNewer || (!existing.Pinned && *item.Pinned)) {
				existing.Pinned = *item.Pinned
			}
			if incomingNewer {
				existing.CuratedUpdatedAt = item.CuratedUpdatedAt
				if by := strings.TrimSpace(item.CuratedUpdatedBy); by != "" {
					existing.CuratedUpdatedBy = by
				}
			}

			if err := tx.Save(&existing).Error; err != nil {
				return err
			}
			res.Updated++
			res.Synced++
			res.Projects = append(res.Projects, activeProjectToEntry(existing))
		}
		return nil
	})
	if err != nil {
		var se *ServiceError
		if errors.As(err, &se) {
			return nil, se
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to sync active projects"}
	}

	return res, nil
}

// ListActiveProjects queries active projects with optional filtering and canonical sorting.
func (s *Server) ListActiveProjects(ctx context.Context, filter ListActiveProjectsFilter) ([]ActiveProjectEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	q := s.db.GetGorm().WithContext(ctx).Model(&dbservice.ActiveProject{})
	if tier := strings.ToLower(strings.TrimSpace(filter.Tier)); tier != "" {
		q = q.Where("LOWER(activity_tier) = ?", tier)
	}
	if status := strings.ToLower(strings.TrimSpace(filter.Status)); status != "" {
		q = q.Where("LOWER(status) = ?", status)
	}
	if vis := strings.ToLower(strings.TrimSpace(filter.Visibility)); vis != "" {
		normVis, err := normalizeProposalVisibility(vis)
		if err != nil {
			return nil, err
		}
		q = q.Where("LOWER(proposal_visibility) = ?", normVis)
	}
	if search := strings.TrimSpace(filter.Query); search != "" {
		like := "%" + strings.ToLower(search) + "%"
		q = q.Where(
			"(LOWER(name) LIKE ? OR LOWER(public_alias) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(group_name) LIKE ? OR LOWER(COALESCE(tech_stack_json::text, '')) LIKE ?)",
			like, like, like, like, like,
		)
	}

	var rows []dbservice.ActiveProject
	if err := q.Order("pinned DESC, last_activity_at DESC NULLS LAST, name ASC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list active projects"}
	}

	entries := make([]ActiveProjectEntry, 0, len(rows))
	for _, r := range rows {
		entries = append(entries, activeProjectToEntry(r))
	}
	return entries, nil
}

// UpdateActiveProject updates curated fields on a project resolved by numeric ID, project_key, or slug.
func (s *Server) UpdateActiveProject(ctx context.Context, idOrKey string, input UpdateActiveProjectInput) (*ActiveProjectEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	ref := strings.TrimSpace(idOrKey)
	if ref == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "project id, project_key, or slug is required"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	var project dbservice.ActiveProject
	var findErr error
	if numID, parseErr := strconv.ParseUint(ref, 10, 64); parseErr == nil || errors.Is(parseErr, strconv.ErrRange) {
		if parseErr != nil || numID == 0 || numID > math.MaxInt64 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid active project ID"}
		}
		findErr = gormDB.Where("id = ?", numID).First(&project).Error
		if errors.Is(findErr, gorm.ErrRecordNotFound) {
			findErr = gormDB.Where("project_key = ? OR slug = ?", ref, ref).First(&project).Error
		}
	} else {
		findErr = gormDB.Where("project_key = ? OR slug = ?", ref, ref).First(&project).Error
	}
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Active project not found"}
	}
	if findErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load active project"}
	}

	if input.ProposalVisibility != nil {
		vis, err := normalizeProposalVisibility(*input.ProposalVisibility)
		if err != nil {
			return nil, err
		}
		if vis == "" {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "proposal_visibility cannot be empty"}
		}
		project.ProposalVisibility = vis
	}
	if input.Status != nil {
		project.Status = strings.TrimSpace(*input.Status)
	}
	if input.Client != nil {
		project.Client = strings.TrimSpace(*input.Client)
	}
	if input.PublicAlias != nil {
		project.PublicAlias = strings.TrimSpace(*input.PublicAlias)
	}
	if input.Summary != nil {
		project.Summary = strings.TrimSpace(*input.Summary)
	}
	if input.NextActions != nil {
		b, err := encodeStringSliceJSONB(*input.NextActions)
		if err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid next_actions"}
		}
		project.NextActionsJSON = b
	}
	if input.Blockers != nil {
		b, err := encodeStringSliceJSONB(*input.Blockers)
		if err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid blockers"}
		}
		project.BlockersJSON = b
	}
	if input.Notes != nil {
		project.Notes = strings.TrimSpace(*input.Notes)
	}
	if input.Pinned != nil {
		project.Pinned = *input.Pinned
	}

	now := time.Now().UTC()
	project.CuratedUpdatedAt = &now
	if by := strings.TrimSpace(input.UpdatedBy); by != "" {
		project.CuratedUpdatedBy = by
	} else {
		project.CuratedUpdatedBy = "user"
	}

	if err := gormDB.Save(&project).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to update active project"}
	}

	entry := activeProjectToEntry(project)
	return &entry, nil
}

func (s *Server) syncActiveProjectsHandler(w http.ResponseWriter, r *http.Request) {
	var req SyncActiveProjectsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	res, err := s.SyncActiveProjects(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) listActiveProjectsHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			respondWithError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}
	projects, err := s.ListActiveProjects(r.Context(), ListActiveProjectsFilter{
		Tier:       q.Get("tier"),
		Status:     q.Get("status"),
		Visibility: q.Get("visibility"),
		Query:      q.Get("q"),
		Limit:      limit,
	})
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{
		"projects": projects,
		"count":    len(projects),
	})
}

func (s *Server) updateActiveProjectHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var input UpdateActiveProjectInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	entry, err := s.UpdateActiveProject(r.Context(), id, input)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, entry)
}
