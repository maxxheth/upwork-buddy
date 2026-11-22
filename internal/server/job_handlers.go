package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// FlexibleString unmarshals JSON strings, objects, arrays, numbers, booleans, or null into a Go string.
type FlexibleString string

func (f *FlexibleString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*f = ""
		return nil
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return err
		}
		*f = FlexibleString(s)
		return nil
	}
	if !json.Valid(trimmed) {
		return fmt.Errorf("invalid JSON value for FlexibleString")
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, trimmed); err != nil {
		return err
	}
	*f = FlexibleString(buf.String())
	return nil
}

func (f FlexibleString) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(f))
}

// FlexibleSkills accepts both a comma-separated string ("Python, FastAPI") and a JSON array (["Python", "FastAPI"]).
type FlexibleSkills struct {
	Text  string
	Slice []string
	Set   bool `json:"-"`
}

func (f *FlexibleSkills) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		f.Text = ""
		f.Slice = nil
		f.Set = false
		return nil
	}
	if trimmed[0] == '[' {
		var arr []string
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return err
		}
		cleaned := make([]string, 0, len(arr))
		for _, item := range arr {
			if s := strings.TrimSpace(item); s != "" {
				cleaned = append(cleaned, s)
			}
		}
		f.Slice = cleaned
		f.Text = strings.Join(cleaned, ", ")
		f.Set = true
		return nil
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return err
		}
		f.Text = strings.TrimSpace(s)
		f.Slice = nil
		if f.Text != "" {
			for _, part := range strings.Split(f.Text, ",") {
				if p := strings.TrimSpace(part); p != "" {
					f.Slice = append(f.Slice, p)
				}
			}
		}
		f.Set = true
		return nil
	}
	return fmt.Errorf("invalid JSON value for FlexibleSkills")
}

func (f FlexibleSkills) MarshalJSON() ([]byte, error) {
	return json.Marshal(f.Text)
}

func parseFlexibleJSONB(raw json.RawMessage) (dbservice.JSONB, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	if trimmed[0] == '"' {
		var str string
		if err := json.Unmarshal(trimmed, &str); err != nil {
			return nil, err
		}
		inner := bytes.TrimSpace([]byte(str))
		if len(inner) == 0 || bytes.Equal(inner, []byte("null")) {
			return nil, nil
		}
		if !json.Valid(inner) {
			return nil, fmt.Errorf("invalid stringified JSON value")
		}
		var buf bytes.Buffer
		if err := json.Compact(&buf, inner); err != nil {
			return nil, err
		}
		return dbservice.JSONB(buf.Bytes()), nil
	}
	if !json.Valid(trimmed) {
		return nil, fmt.Errorf("invalid JSONB value")
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, trimmed); err != nil {
		return nil, err
	}
	return dbservice.JSONB(buf.Bytes()), nil
}

type saveJobRequest struct {
	// v1.0 fields
	JobTitle           string         `json:"job_title"`
	JobDescription     string         `json:"job_description"`
	URL                string         `json:"url"`
	JobURL             string         `json:"job_url"`
	Source             string         `json:"source"`
	Status             string         `json:"status"`
	ContractType       string         `json:"contract_type"`
	Budget             string         `json:"budget"`
	RateRange          string         `json:"rate_range"`
	RateMin            string         `json:"rate_min"`
	RateMax            string         `json:"rate_max"`
	BudgetAmount       string         `json:"budget_amount"`
	ExperienceLevel    string         `json:"experience_level"`
	Skills             FlexibleSkills `json:"skills"`
	Proposal           string         `json:"proposal"`
	ProposalSubject    string         `json:"proposal_subject"`
	ProposalTone       string         `json:"proposal_tone"`
	ProposalJSON       json.RawMessage `json:"proposal_json"`
	Score              *int           `json:"score"`
	ScoreReasoning     string         `json:"score_reasoning"`
	FitAssessment      string         `json:"fit_assessment"`
	PortfolioReferences json.RawMessage `json:"portfolio_references"`
	TimeEstimate       FlexibleString `json:"time_estimate"`
	WorkloadDivision   FlexibleString `json:"workload_division"`
	QuestionsForClient FlexibleString `json:"questions_for_client"`
	TipsAndAdvice      FlexibleString `json:"tips_and_advice"`
	ExecutionPrompt    string         `json:"execution_prompt"`
	ToneAnalysis       string         `json:"tone_analysis"`

	// v2 enrichment fields + aliases
	UpworkJobID        string          `json:"upwork_job_id"`
	CanonicalURL       string          `json:"canonical_url"`
	SourceFeed         string          `json:"source_feed"`
	SourceQuery        string          `json:"source_query"`
	PostedText         string          `json:"posted_text"`
	Posted             string          `json:"posted"`
	PostedAtEst        *time.Time      `json:"posted_at_est"`
	Duration           string          `json:"duration"`
	HoursPerWeek       string          `json:"hours_per_week"`
	ProposalsTier      string          `json:"proposals_tier"`
	Proposals          string          `json:"proposals"`
	ProposalsCount     *int            `json:"proposals_count"`
	ConnectsRequired   *int            `json:"connects_required"`
	ScreeningQuestions json.RawMessage `json:"screening_questions"`
	Attachments        json.RawMessage `json:"attachments"`
	Qualifications     json.RawMessage `json:"qualifications"`
	ClientCountry      string          `json:"client_country"`
	Country            string          `json:"country"`
	ClientRating       *float64        `json:"client_rating"`
	ClientReviews      *int            `json:"client_reviews"`
	ClientSpent        string          `json:"client_spent"`
	ClientSpentUSD     *float64        `json:"client_spent_usd"`
	ClientHires        *int            `json:"client_hires"`
	ClientHireRate     *float64        `json:"client_hire_rate"`
	PaymentVerified    *bool           `json:"payment_verified"`
	ClientActivity     json.RawMessage `json:"client_activity"`
	ScoreBreakdown     json.RawMessage `json:"score_breakdown"`
	FitLabel           string          `json:"fit_label"`
	LastEnrichedAt     *time.Time      `json:"last_enriched_at"`
}

type saveJobResponse struct {
	ID           uint   `json:"id"`
	UpworkJobID  string `json:"upwork_job_id,omitempty"`
	CanonicalURL string `json:"canonical_url,omitempty"`
	JobTitle     string `json:"job_title"`
	URL          string `json:"url,omitempty"`
	Source       string `json:"source,omitempty"`
	Status       string `json:"status,omitempty"`
	Score        *int   `json:"score,omitempty"`
	FitLabel     string `json:"fit_label,omitempty"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at,omitempty"`
	Upserted     bool   `json:"upserted"`
}

type listJobsResponse struct {
	Jobs  []JobEntry `json:"jobs"`
	Total int        `json:"total"`
}

type jobEntry = JobEntry

// JobEntry is the API/MCP DTO for a persisted job row.
type JobEntry struct {
	ID                  uint            `json:"id"`
	UpworkJobID         string          `json:"upwork_job_id,omitempty"`
	CanonicalURL        string          `json:"canonical_url,omitempty"`
	JobTitle            string          `json:"job_title"`
	JobDescription      string          `json:"job_description"`
	URL                 string          `json:"url,omitempty"`
	Source              string          `json:"source,omitempty"`
	SourceFeed          string          `json:"source_feed,omitempty"`
	SourceQuery         string          `json:"source_query,omitempty"`
	Status              string          `json:"status,omitempty"`
	ContractType        string          `json:"contract_type"`
	Budget              string          `json:"budget"`
	RateRange           string          `json:"rate_range"`
	RateMin             string          `json:"rate_min"`
	RateMax             string          `json:"rate_max"`
	BudgetAmount        string          `json:"budget_amount"`
	ExperienceLevel     string          `json:"experience_level"`
	Duration            string          `json:"duration,omitempty"`
	HoursPerWeek        string          `json:"hours_per_week,omitempty"`
	Skills              string          `json:"skills"`
	PostedText          string          `json:"posted_text,omitempty"`
	PostedAtEst         *string         `json:"posted_at_est,omitempty"`
	ProposalsTier       string          `json:"proposals_tier,omitempty"`
	ProposalsCount      *int            `json:"proposals_count,omitempty"`
	ConnectsRequired    *int            `json:"connects_required,omitempty"`
	ScreeningQuestions  json.RawMessage `json:"screening_questions,omitempty"`
	Attachments         json.RawMessage `json:"attachments,omitempty"`
	Qualifications      json.RawMessage `json:"qualifications,omitempty"`
	ClientCountry       string          `json:"client_country,omitempty"`
	ClientRating        *float64        `json:"client_rating,omitempty"`
	ClientReviews       *int            `json:"client_reviews,omitempty"`
	ClientSpent         string          `json:"client_spent,omitempty"`
	ClientSpentUSD      *float64        `json:"client_spent_usd,omitempty"`
	ClientHires         *int            `json:"client_hires,omitempty"`
	ClientHireRate      *float64        `json:"client_hire_rate,omitempty"`
	PaymentVerified     *bool           `json:"payment_verified,omitempty"`
	ClientActivity      json.RawMessage `json:"client_activity,omitempty"`
	Score               *int            `json:"score,omitempty"`
	ScoreBreakdown      json.RawMessage `json:"score_breakdown,omitempty"`
	ScoreReasoning      string          `json:"score_reasoning,omitempty"`
	FitLabel            string          `json:"fit_label,omitempty"`
	FitAssessment       string          `json:"fit_assessment,omitempty"`
	Proposal            string          `json:"proposal"`
	ProposalSubject     string          `json:"proposal_subject,omitempty"`
	ProposalTone        string          `json:"proposal_tone,omitempty"`
	ProposalJSON        json.RawMessage `json:"proposal_json,omitempty"`
	PortfolioReferences json.RawMessage `json:"portfolio_references,omitempty"`
	TimeEstimate        string          `json:"time_estimate"`
	WorkloadDivision    string          `json:"workload_division"`
	QuestionsForClient  string          `json:"questions_for_client"`
	TipsAndAdvice       string          `json:"tips_and_advice"`
	ExecutionPrompt     string          `json:"execution_prompt"`
	ToneAnalysis        string          `json:"tone_analysis"`
	LastEnrichedAt      *string         `json:"last_enriched_at,omitempty"`
	AIEnrichmentStatus  string          `json:"ai_enrichment_status"`
	AIEnrichedAt        *string         `json:"ai_enriched_at,omitempty"`
	AIEnrichmentError   string          `json:"ai_enrichment_error,omitempty"`
	AIModel             string          `json:"ai_model,omitempty"`
	AIEffort            string          `json:"ai_effort,omitempty"`
	AITokensUsed        *int            `json:"ai_tokens_used,omitempty"`
	LastSearchRunID     *uint           `json:"last_search_run_id,omitempty"`
	CreatedAt           string          `json:"created_at"`
	UpdatedAt           string          `json:"updated_at,omitempty"`
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func formatOptTime(t *time.Time) *string {
	if t == nil || t.IsZero() {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05Z07:00")
	return &s
}

func rawJSONFromJSONB(j dbservice.JSONB) json.RawMessage {
	if len(j) == 0 {
		return nil
	}
	return json.RawMessage(j)
}

func jobEntryFromModel(j dbservice.Job) jobEntry {
	upworkID := ""
	if j.UpworkJobID != nil {
		upworkID = *j.UpworkJobID
	}
	aiStatus := strings.TrimSpace(j.AIEnrichmentStatus)
	if aiStatus == "" {
		aiStatus = "none"
	}
	return jobEntry{
		ID:                  j.ID,
		UpworkJobID:         upworkID,
		CanonicalURL:        j.CanonicalURL,
		JobTitle:            j.Title,
		JobDescription:      j.Description,
		URL:                 j.URL,
		Source:              j.Source,
		SourceFeed:          j.SourceFeed,
		SourceQuery:         j.SourceQuery,
		Status:              j.Status,
		ContractType:        j.ContractType,
		Budget:              j.Budget,
		RateRange:           j.RateRange,
		RateMin:             j.RateMin,
		RateMax:             j.RateMax,
		BudgetAmount:        j.BudgetAmount,
		ExperienceLevel:     j.ExperienceLevel,
		Duration:            j.Duration,
		HoursPerWeek:        j.HoursPerWeek,
		Skills:              j.Skills,
		PostedText:          j.PostedText,
		PostedAtEst:         formatOptTime(j.PostedAtEst),
		ProposalsTier:       j.ProposalsTier,
		ProposalsCount:      j.ProposalsCount,
		ConnectsRequired:    j.ConnectsRequired,
		ScreeningQuestions:  rawJSONFromJSONB(j.ScreeningQuestions),
		Attachments:         rawJSONFromJSONB(j.Attachments),
		Qualifications:      rawJSONFromJSONB(j.Qualifications),
		ClientCountry:       j.ClientCountry,
		ClientRating:        j.ClientRating,
		ClientReviews:       j.ClientReviews,
		ClientSpent:         j.ClientSpent,
		ClientSpentUSD:      j.ClientSpentUSD,
		ClientHires:         j.ClientHires,
		ClientHireRate:      j.ClientHireRate,
		PaymentVerified:     j.PaymentVerified,
		ClientActivity:      rawJSONFromJSONB(j.ClientActivity),
		Score:               j.Score,
		ScoreBreakdown:      rawJSONFromJSONB(j.ScoreBreakdown),
		ScoreReasoning:      j.ScoreReasoning,
		FitLabel:            j.FitLabel,
		FitAssessment:       j.FitAssessment,
		Proposal:            j.Proposal,
		ProposalSubject:     j.ProposalSubject,
		ProposalTone:        j.ProposalTone,
		ProposalJSON:        rawJSONFromJSONB(j.ProposalJSON),
		PortfolioReferences: rawJSONFromJSONB(j.PortfolioReferences),
		TimeEstimate:        j.TimeEstimate,
		WorkloadDivision:    j.WorkloadDivision,
		QuestionsForClient:  j.QuestionsForClient,
		TipsAndAdvice:       j.TipsAndAdvice,
		ExecutionPrompt:     j.ExecutionPrompt,
		ToneAnalysis:        j.ToneAnalysis,
		LastEnrichedAt:      formatOptTime(j.LastEnrichedAt),
		AIEnrichmentStatus:  aiStatus,
		AIEnrichedAt:        formatOptTime(j.AIEnrichedAt),
		AIEnrichmentError:   j.AIEnrichmentError,
		AIModel:             j.AIModel,
		AIEffort:            j.AIEffort,
		AITokensUsed:        j.AITokensUsed,
		LastSearchRunID:     j.LastSearchRunID,
		CreatedAt:           j.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt:           j.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}

func loadScoringProfile(db *gorm.DB) *scoring.ScoringProfile {
	if db == nil {
		return nil
	}
	var profile dbservice.Profile
	if err := db.Preload("PortfolioItems").Order("id asc").First(&profile).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	var skills []string
	for _, s := range strings.Split(profile.Skills, ",") {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			skills = append(skills, trimmed)
		}
	}
	items := make([]scoring.PortfolioRef, 0, len(profile.PortfolioItems))
	for _, p := range profile.PortfolioItems {
		items = append(items, scoring.PortfolioRef{
			Title:       p.Title,
			Link:        p.Link,
			Description: p.Description,
		})
	}
	var activeProjects []scoring.ActiveProjectRef
	var dbProjects []dbservice.ActiveProject
	if err := db.Where("(activity_tier IN ? OR pinned = ?) AND LOWER(activity_tier) <> ? AND LOWER(status) <> ? AND LOWER(proposal_visibility) <> ?",
		[]string{"active", "recent"}, true, "archived", "archived", "private").
		Order("pinned desc, last_activity_at desc, id asc").
		Find(&dbProjects).Error; err != nil {
		log.Printf("loadScoringProfile: skipping active projects query: %v", err)
	} else if len(dbProjects) > 0 {
		activeProjects = make([]scoring.ActiveProjectRef, 0, len(dbProjects))
		for _, p := range dbProjects {
			displayName, safeSummary, _, ok := SanitizedActiveProjectDisplay(p)
			if !ok {
				continue
			}
			vis := strings.ToLower(strings.TrimSpace(p.ProposalVisibility))
			safeName := ""
			safeKey := ""
			if vis == "public" {
				safeName = p.Name
				safeKey = p.ProjectKey
			} else {
				vis = "anonymized"
			}
			activeProjects = append(activeProjects, scoring.ActiveProjectRef{
				Key:                safeKey,
				Name:               safeName,
				PublicAlias:        displayName,
				ProposalVisibility: vis,
				ActivityTier:       p.ActivityTier,
				Summary:            safeSummary,
				TechStack:          decodeStringSliceJSONB(p.TechStackJSON),
			})
		}
	}
	if profile.ID == 0 && len(activeProjects) == 0 {
		return nil
	}
	return &scoring.ScoringProfile{
		Description:    profile.Description,
		Skills:         skills,
		PortfolioItems: items,
		ActiveProjects: activeProjects,
	}
}

func mergeIncomingJob(existing *dbservice.Job, incoming dbservice.Job) {
	if strings.TrimSpace(incoming.Title) != "" {
		existing.Title = incoming.Title
	}
	if len(strings.TrimSpace(incoming.Description)) > len(strings.TrimSpace(existing.Description)) ||
		(strings.TrimSpace(existing.Description) == "" && strings.TrimSpace(incoming.Description) != "") {
		existing.Description = incoming.Description
	}
	if incoming.URL != "" {
		existing.URL = incoming.URL
	}
	if incoming.CanonicalURL != "" {
		existing.CanonicalURL = incoming.CanonicalURL
	}
	if incoming.Source != "" {
		existing.Source = incoming.Source
	}
	if incoming.SourceFeed != "" {
		existing.SourceFeed = incoming.SourceFeed
	}
	if incoming.SourceQuery != "" {
		existing.SourceQuery = incoming.SourceQuery
	}
	if incoming.ContractType != "" {
		existing.ContractType = incoming.ContractType
	}
	if incoming.Budget != "" {
		existing.Budget = incoming.Budget
	}
	if incoming.RateRange != "" {
		existing.RateRange = incoming.RateRange
	}
	if incoming.RateMin != "" {
		existing.RateMin = incoming.RateMin
	}
	if incoming.RateMax != "" {
		existing.RateMax = incoming.RateMax
	}
	if incoming.BudgetAmount != "" {
		existing.BudgetAmount = incoming.BudgetAmount
	}
	if incoming.ExperienceLevel != "" {
		existing.ExperienceLevel = incoming.ExperienceLevel
	}
	if incoming.Duration != "" {
		existing.Duration = incoming.Duration
	}
	if incoming.HoursPerWeek != "" {
		existing.HoursPerWeek = incoming.HoursPerWeek
	}
	if incoming.Skills != "" {
		existing.Skills = incoming.Skills
	}
	if incoming.PostedText != "" {
		existing.PostedText = incoming.PostedText
	}
	if incoming.PostedAtEst != nil {
		existing.PostedAtEst = incoming.PostedAtEst
	}
	if incoming.ProposalsTier != "" {
		existing.ProposalsTier = incoming.ProposalsTier
	}
	if incoming.ProposalsCount != nil {
		existing.ProposalsCount = incoming.ProposalsCount
	}
	if incoming.ConnectsRequired != nil {
		existing.ConnectsRequired = incoming.ConnectsRequired
	}
	if len(incoming.ScreeningQuestions) > 0 {
		existing.ScreeningQuestions = incoming.ScreeningQuestions
	}
	if len(incoming.Attachments) > 0 {
		existing.Attachments = incoming.Attachments
	}
	if len(incoming.Qualifications) > 0 {
		existing.Qualifications = incoming.Qualifications
	}
	if incoming.LastEnrichedAt != nil {
		existing.LastEnrichedAt = incoming.LastEnrichedAt
	}
	if incoming.ClientCountry != "" {
		existing.ClientCountry = incoming.ClientCountry
	}
	if incoming.ClientRating != nil {
		existing.ClientRating = incoming.ClientRating
	}
	if incoming.ClientReviews != nil {
		existing.ClientReviews = incoming.ClientReviews
	}
	if incoming.ClientSpent != "" {
		existing.ClientSpent = incoming.ClientSpent
	}
	if incoming.ClientSpentUSD != nil {
		existing.ClientSpentUSD = incoming.ClientSpentUSD
	}
	if incoming.ClientHires != nil {
		existing.ClientHires = incoming.ClientHires
	}
	if incoming.ClientHireRate != nil {
		existing.ClientHireRate = incoming.ClientHireRate
	}
	if incoming.PaymentVerified != nil {
		existing.PaymentVerified = incoming.PaymentVerified
	}
	if len(incoming.ClientActivity) > 0 {
		existing.ClientActivity = incoming.ClientActivity
	}
	if incoming.Score != nil {
		existing.Score = incoming.Score
	}
	if len(incoming.ScoreBreakdown) > 0 {
		existing.ScoreBreakdown = incoming.ScoreBreakdown
	}
	if incoming.ScoreReasoning != "" {
		existing.ScoreReasoning = incoming.ScoreReasoning
	}
	if incoming.FitLabel != "" {
		existing.FitLabel = incoming.FitLabel
	}
	if incoming.FitAssessment != "" {
		existing.FitAssessment = incoming.FitAssessment
	}
	existingAIStatus := strings.ToLower(strings.TrimSpace(existing.AIEnrichmentStatus))
	hasActiveOrDoneAI := (existingAIStatus != "" && existingAIStatus != "none") ||
		existing.AIEnrichedAt != nil ||
		strings.TrimSpace(existing.Proposal) != ""

	if !hasActiveOrDoneAI {
		if incoming.Proposal != "" && strings.TrimSpace(existing.Proposal) == "" {
			existing.Proposal = incoming.Proposal
		}
		if incoming.ProposalSubject != "" && strings.TrimSpace(existing.ProposalSubject) == "" {
			existing.ProposalSubject = incoming.ProposalSubject
		}
		if incoming.ProposalTone != "" && strings.TrimSpace(existing.ProposalTone) == "" {
			existing.ProposalTone = incoming.ProposalTone
		}
		if len(incoming.ProposalJSON) > 0 && len(existing.ProposalJSON) == 0 {
			existing.ProposalJSON = incoming.ProposalJSON
		}
		if len(incoming.PortfolioReferences) > 0 && len(existing.PortfolioReferences) == 0 {
			existing.PortfolioReferences = incoming.PortfolioReferences
		}
		if incoming.TimeEstimate != "" && strings.TrimSpace(existing.TimeEstimate) == "" {
			existing.TimeEstimate = incoming.TimeEstimate
		}
		if incoming.WorkloadDivision != "" && strings.TrimSpace(existing.WorkloadDivision) == "" {
			existing.WorkloadDivision = incoming.WorkloadDivision
		}
		if incoming.QuestionsForClient != "" && strings.TrimSpace(existing.QuestionsForClient) == "" {
			existing.QuestionsForClient = incoming.QuestionsForClient
		}
		if incoming.TipsAndAdvice != "" && strings.TrimSpace(existing.TipsAndAdvice) == "" {
			existing.TipsAndAdvice = incoming.TipsAndAdvice
		}
		if incoming.ExecutionPrompt != "" && strings.TrimSpace(existing.ExecutionPrompt) == "" {
			existing.ExecutionPrompt = incoming.ExecutionPrompt
		}
		if incoming.ToneAnalysis != "" && strings.TrimSpace(existing.ToneAnalysis) == "" {
			existing.ToneAnalysis = incoming.ToneAnalysis
		}
	}

	incomingAIStatus := strings.TrimSpace(incoming.AIEnrichmentStatus)
	if (existingAIStatus == "" || existingAIStatus == "none") &&
		incomingAIStatus != "" &&
		!strings.EqualFold(incomingAIStatus, "none") {
		existing.AIEnrichmentStatus = incomingAIStatus
	}
	if !hasActiveOrDoneAI && existing.AIEnrichedAt == nil && incoming.AIEnrichedAt != nil {
		existing.AIEnrichedAt = incoming.AIEnrichedAt
	}
	if (existingAIStatus == "" || existingAIStatus == "none") &&
		existing.AIEnrichmentError == "" &&
		incoming.AIEnrichmentError != "" {
		existing.AIEnrichmentError = incoming.AIEnrichmentError
	}
	if !hasActiveOrDoneAI && existing.AIModel == "" && incoming.AIModel != "" {
		existing.AIModel = incoming.AIModel
	}
	if !hasActiveOrDoneAI && existing.AIEffort == "" && incoming.AIEffort != "" {
		existing.AIEffort = incoming.AIEffort
	}
	if !hasActiveOrDoneAI && existing.AITokensUsed == nil && incoming.AITokensUsed != nil {
		existing.AITokensUsed = incoming.AITokensUsed
	}
	if incoming.LastSearchRunID != nil && *incoming.LastSearchRunID > 0 {
		existing.LastSearchRunID = incoming.LastSearchRunID
	}
	if incoming.Status != "" && existing.Status != "applied" && existing.Status != "rejected" && existing.Status != "archived" {
		existing.Status = incoming.Status
	}
}

func effectiveHourlyRate(rateRange, contractType, budget, rateMin, rateMax string) string {
	hourlyRate := strings.TrimSpace(rateRange)
	if hourlyRate == "" && strings.EqualFold(strings.TrimSpace(contractType), "hourly") {
		hourlyRate = strings.TrimSpace(budget)
	}
	if minRate, maxRate := scoring.ParseHourlyRateRange(hourlyRate); minRate != nil && maxRate != nil {
		return hourlyRate
	}
	if !strings.EqualFold(strings.TrimSpace(contractType), "fixed") {
		minParsed := parseNumericOrDollar(rateMin)
		maxParsed := parseNumericOrDollar(rateMax)
		if minParsed != nil || maxParsed != nil {
			if minParsed == nil {
				minParsed = maxParsed
			}
			if maxParsed == nil {
				maxParsed = minParsed
			}
			if *minParsed > *maxParsed {
				minParsed, maxParsed = maxParsed, minParsed
			}
			minStr := strconv.FormatFloat(*minParsed, 'f', -1, 64)
			maxStr := strconv.FormatFloat(*maxParsed, 'f', -1, 64)
			if *minParsed == *maxParsed {
				return "$" + minStr + "/hr"
			}
			return "$" + minStr + " - $" + maxStr + "/hr"
		}
	}
	return hourlyRate
}

func applyDeterministicScore(job *dbservice.Job, profile *scoring.ScoringProfile, explicitScore bool) {
	if job == nil {
		return
	}
	if !explicitScore || len(job.ScoreBreakdown) == 0 {
		hourlyRate := effectiveHourlyRate(job.RateRange, job.ContractType, job.Budget, job.RateMin, job.RateMax)
		budgetStr := job.BudgetAmount
		if budgetStr == "" && !strings.EqualFold(job.ContractType, "hourly") {
			budgetStr = job.Budget
		}
		var skillSlice []string
		for _, part := range strings.Split(job.Skills, ",") {
			if s := strings.TrimSpace(part); s != "" {
				skillSlice = append(skillSlice, s)
			}
		}
		res := scoring.ScoreJob(scoring.JobInput{
			Title:            job.Title,
			URL:              job.CanonicalURL,
			Description:      job.Description,
			Budget:           budgetStr,
			HourlyRate:       hourlyRate,
			ExperienceLevel:  job.ExperienceLevel,
			Duration:         job.Duration,
			HoursPerWeek:     job.HoursPerWeek,
			Skills:           skillSlice,
			Posted:           job.PostedText,
			Country:          job.ClientCountry,
			Proposals:        job.ProposalsTier,
			ProposalsCount:   job.ProposalsCount,
			ClientRating:     job.ClientRating,
			ClientReviews:    job.ClientReviews,
			ClientHires:      job.ClientHires,
			ClientSpent:      job.ClientSpent,
			ClientHireRate:   job.ClientHireRate,
			PaymentVerified:  job.PaymentVerified,
			ConnectsRequired: job.ConnectsRequired,
		}, profile)

		if !explicitScore || job.Score == nil {
			sc := res.Score
			job.Score = &sc
			job.FitLabel = res.FitLabel
			if job.FitAssessment == "" {
				job.FitAssessment = res.FitLabel
			}
			job.ScoreReasoning = strings.Join(res.Reasons, "\n")
		} else if job.FitLabel == "" {
			job.FitLabel = scoring.FitLabelForScore(*job.Score)
		}
		if len(job.ScoreBreakdown) == 0 || !explicitScore {
			if encoded, err := json.Marshal(res.Breakdown); err == nil {
				job.ScoreBreakdown = dbservice.JSONB(encoded)
			}
		}
	} else if job.FitLabel == "" && job.Score != nil {
		job.FitLabel = scoring.FitLabelForScore(*job.Score)
	}
	if job.FitAssessment == "" {
		job.FitAssessment = job.FitLabel
	}
}

func buildJobModelFromRequest(req saveJobRequest) (dbservice.Job, string, bool, error) {
	rawURL := firstNonEmpty(req.CanonicalURL, req.URL, req.JobURL)
	jobURL := firstNonEmpty(req.URL, req.JobURL, req.CanonicalURL)
	canonicalURL := scoring.NormalizeJobURL(rawURL)

	upworkJobID := firstNonEmpty(
		scoring.NormalizeUpworkJobID(req.UpworkJobID),
		scoring.ExtractUpworkJobID(canonicalURL),
		scoring.ExtractUpworkJobID(rawURL),
	)
	if strings.TrimSpace(req.JobTitle) == "" && rawURL == "" && upworkJobID == "" {
		return dbservice.Job{}, "", false, errors.New("at least one of job_title, url, or upwork_job_id is required")
	}
	var upworkJobIDPtr *string
	if upworkJobID != "" {
		upworkJobIDPtr = &upworkJobID
	}

	postedText := firstNonEmpty(req.PostedText, req.Posted)
	postedAtEst := req.PostedAtEst
	if postedAtEst == nil && postedText != "" {
		if ageDays := scoring.ParsePostedAge(postedText); ageDays != nil {
			est := time.Now().UTC().Add(-time.Duration(*ageDays) * 24 * time.Hour)
			postedAtEst = &est
		}
	}

	proposalsTier := firstNonEmpty(req.ProposalsTier, req.Proposals)
	proposalsCount := req.ProposalsCount
	if proposalsCount == nil && proposalsTier != "" {
		proposalsCount = scoring.ParseProposalCount(proposalsTier)
	}

	clientCountry := firstNonEmpty(req.ClientCountry, req.Country)
	clientSpentUSD := req.ClientSpentUSD
	if clientSpentUSD == nil && strings.TrimSpace(req.ClientSpent) != "" {
		val := scoring.ParseClientSpend(req.ClientSpent)
		clientSpentUSD = &val
	}

	proposalJSON, err := parseFlexibleJSONB(req.ProposalJSON)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid proposal_json value")
	}
	portfolioRefs, err := parseFlexibleJSONB(req.PortfolioReferences)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid portfolio_references value")
	}
	screeningQuestions, err := parseFlexibleJSONB(req.ScreeningQuestions)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid screening_questions value")
	}
	attachments, err := parseFlexibleJSONB(req.Attachments)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid attachments value")
	}
	qualifications, err := parseFlexibleJSONB(req.Qualifications)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid qualifications value")
	}
	clientActivity, err := parseFlexibleJSONB(req.ClientActivity)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid client_activity value")
	}
	scoreBreakdown, err := parseFlexibleJSONB(req.ScoreBreakdown)
	if err != nil {
		return dbservice.Job{}, "", false, errors.New("invalid score_breakdown value")
	}

	explicitScore := req.Score != nil
	fitLabel := firstNonEmpty(req.FitLabel, req.FitAssessment)
	fitAssessment := firstNonEmpty(req.FitAssessment, fitLabel)

	job := dbservice.Job{
		UpworkJobID:         upworkJobIDPtr,
		Title:               req.JobTitle,
		Description:         req.JobDescription,
		URL:                 jobURL,
		CanonicalURL:        canonicalURL,
		Source:              req.Source,
		SourceFeed:          req.SourceFeed,
		SourceQuery:         req.SourceQuery,
		Status:              req.Status,
		ContractType:        req.ContractType,
		Budget:              req.Budget,
		RateRange:           req.RateRange,
		RateMin:             req.RateMin,
		RateMax:             req.RateMax,
		BudgetAmount:        req.BudgetAmount,
		ExperienceLevel:     req.ExperienceLevel,
		Duration:            req.Duration,
		HoursPerWeek:        req.HoursPerWeek,
		Skills:              req.Skills.Text,
		PostedText:          postedText,
		PostedAtEst:         postedAtEst,
		ProposalsTier:       proposalsTier,
		ProposalsCount:      proposalsCount,
		ConnectsRequired:    req.ConnectsRequired,
		ScreeningQuestions:  screeningQuestions,
		Attachments:         attachments,
		Qualifications:      qualifications,
		LastEnrichedAt:      req.LastEnrichedAt,
		ClientCountry:       clientCountry,
		ClientRating:        req.ClientRating,
		ClientReviews:       req.ClientReviews,
		ClientSpent:         req.ClientSpent,
		ClientSpentUSD:      clientSpentUSD,
		ClientHires:         req.ClientHires,
		ClientHireRate:      req.ClientHireRate,
		PaymentVerified:     req.PaymentVerified,
		ClientActivity:      clientActivity,
		Score:               req.Score,
		ScoreBreakdown:      scoreBreakdown,
		ScoreReasoning:      req.ScoreReasoning,
		FitLabel:            fitLabel,
		FitAssessment:       fitAssessment,
		Proposal:            req.Proposal,
		ProposalSubject:     req.ProposalSubject,
		ProposalTone:        req.ProposalTone,
		ProposalJSON:        proposalJSON,
		PortfolioReferences: portfolioRefs,
		TimeEstimate:        string(req.TimeEstimate),
		WorkloadDivision:    string(req.WorkloadDivision),
		QuestionsForClient:  string(req.QuestionsForClient),
		TipsAndAdvice:       string(req.TipsAndAdvice),
		ExecutionPrompt:     req.ExecutionPrompt,
		ToneAnalysis:        req.ToneAnalysis,
	}

	return job, upworkJobID, explicitScore, nil
}

func upsertJobRecord(gormDB *gorm.DB, job dbservice.Job, profile *scoring.ScoringProfile, explicitScore bool) (dbservice.Job, bool, error) {
	if gormDB == nil {
		return dbservice.Job{}, false, errors.New("database unavailable")
	}

	if job.UpworkJobID != nil && *job.UpworkJobID != "" {
		upworkID := *job.UpworkJobID
		runInTx := func(fn func(tx *gorm.DB) error) error {
			if gormDB.Statement != nil {
				if committer, ok := gormDB.Statement.ConnPool.(gorm.TxCommitter); ok && committer != nil {
					return fn(gormDB)
				}
			}
			return gormDB.Transaction(fn)
		}

		var savedJob dbservice.Job
		var didUpsert bool
		txErr := runInTx(func(tx *gorm.DB) error {
			var existing dbservice.Job
			findErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("upwork_job_id = ?", upworkID).
				First(&existing).Error
			if findErr == nil {
				mergeIncomingJob(&existing, job)
				applyDeterministicScore(&existing, profile, explicitScore)
				if saveErr := tx.Save(&existing).Error; saveErr != nil {
					return saveErr
				}
				savedJob = existing
				didUpsert = true
				return nil
			}
			if !errors.Is(findErr, gorm.ErrRecordNotFound) {
				return findErr
			}

			candidate := job
			applyDeterministicScore(&candidate, profile, explicitScore)
			createRes := tx.Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "upwork_job_id"}},
				TargetWhere: clause.Where{Exprs: []clause.Expression{
					clause.Expr{SQL: "upwork_job_id IS NOT NULL AND upwork_job_id <> ''"},
				}},
				DoNothing: true,
			}).Create(&candidate)
			if createRes.Error != nil {
				return createRes.Error
			}
			if createRes.RowsAffected > 0 {
				savedJob = candidate
				didUpsert = false
				return nil
			}

			// Concurrent transaction inserted and committed this upwork_job_id first.
			var locked dbservice.Job
			if reReadErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("upwork_job_id = ?", upworkID).
				First(&locked).Error; reReadErr != nil {
				return reReadErr
			}
			mergeIncomingJob(&locked, job)
			applyDeterministicScore(&locked, profile, explicitScore)
			if saveErr := tx.Save(&locked).Error; saveErr != nil {
				return saveErr
			}
			savedJob = locked
			didUpsert = true
			return nil
		})
		if txErr != nil {
			return dbservice.Job{}, false, txErr
		}
		return savedJob, didUpsert, nil
	}

	applyDeterministicScore(&job, profile, explicitScore)
	if err := gormDB.Create(&job).Error; err != nil {
		return dbservice.Job{}, false, err
	}
	return job, false, nil
}

func (s *Server) saveJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Save job request received")
	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req saveJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	job, upworkJobID, explicitScore, err := buildJobModelFromRequest(req)
	if err != nil {
		respondInvalidParams(w, err.Error())
		return
	}

	gormDB := s.db.GetGorm()
	profile := loadScoringProfile(gormDB)

	savedJob, upserted, err := upsertJobRecord(gormDB, job, profile, explicitScore)
	if err != nil {
		log.Printf("❌ Failed to upsert job: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to save job")
		return
	}
	job = savedJob

	log.Printf("✅ Job saved successfully: id=%d upwork_job_id=%q title=%q upserted=%v", job.ID, upworkJobID, job.Title, upserted)
	respondWithJSON(w, saveJobResponse{
		ID:           job.ID,
		UpworkJobID:  upworkJobID,
		CanonicalURL: job.CanonicalURL,
		JobTitle:     job.Title,
		URL:          job.URL,
		Source:       job.Source,
		Status:       job.Status,
		Score:        job.Score,
		FitLabel:     job.FitLabel,
		CreatedAt:    job.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt:    job.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
		Upserted:     upserted,
	})
}

// ListJobsFilter configures filtering, sorting, and pagination for ListJobs.
type ListJobsFilter struct {
	SearchRunID          *uint    `json:"search_run_id,omitempty"`
	Status               string   `json:"status,omitempty"`
	Fit                  string   `json:"fit,omitempty"`
	ContractType         string   `json:"contract_type,omitempty"`
	SourceQuery          string   `json:"source_query,omitempty"`
	MinScore             *int     `json:"min_score,omitempty"`
	MaxAgeDays           *int     `json:"max_age_days,omitempty"`
	MaxProposals         *int     `json:"max_proposals,omitempty"`
	IncludeUnknown       bool     `json:"include_unknown,omitempty"`
	IncludeUnknownBudget bool     `json:"include_unknown_budget,omitempty"`
	Query                string   `json:"query,omitempty"`
	RequiredKeywords     []string `json:"required_keywords,omitempty"`
	ExcludeKeywords      []string `json:"exclude_keywords,omitempty"`
	BudgetMin            *float64 `json:"budget_min,omitempty"`
	BudgetMax            *float64 `json:"budget_max,omitempty"`
	HourlyRateMin        *float64 `json:"hourly_rate_min,omitempty"`
	HourlyRateMax        *float64 `json:"hourly_rate_max,omitempty"`
	EnrichmentStatus     string   `json:"enrichment_status,omitempty"`
	HasAIAnalysis        *bool    `json:"has_ai_analysis,omitempty"`
	MatchedProject       string   `json:"matched_project,omitempty"`
	Limit                int      `json:"limit,omitempty"`
	Offset               int      `json:"offset,omitempty"`
	Sort                 string   `json:"sort,omitempty"`
}

func validateNumericRangeParams(minVal, maxVal *float64, name string) error {
	if minVal != nil && (math.IsNaN(*minVal) || math.IsInf(*minVal, 0) || *minVal < 0) {
		return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("Invalid %s_min parameter", name)}
	}
	if maxVal != nil && (math.IsNaN(*maxVal) || math.IsInf(*maxVal, 0) || *maxVal < 0) {
		return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("Invalid %s_max parameter", name)}
	}
	if minVal != nil && maxVal != nil && *minVal > *maxVal {
		return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("%s_min cannot exceed %s_max", name, name)}
	}
	return nil
}

func parseNumericOrDollar(raw string) *float64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if amt := scoring.ParseBudgetAmount(trimmed); amt != nil {
		return amt
	}
	cleaned := strings.ReplaceAll(trimmed, ",", "")
	cleaned = strings.TrimPrefix(cleaned, "$")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return nil
	}
	v, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return nil
	}
	return &v
}

func extractJobHourlyRateRange(j dbservice.Job) (*float64, *float64) {
	hourlyRate := strings.TrimSpace(j.RateRange)
	if hourlyRate == "" && strings.EqualFold(strings.TrimSpace(j.ContractType), "hourly") {
		hourlyRate = strings.TrimSpace(j.Budget)
	}
	minRate, maxRate := scoring.ParseHourlyRateRange(hourlyRate)
	if minRate != nil && maxRate != nil {
		return minRate, maxRate
	}
	minParsed := parseNumericOrDollar(j.RateMin)
	maxParsed := parseNumericOrDollar(j.RateMax)
	if minParsed != nil || maxParsed != nil {
		if minParsed == nil {
			minParsed = maxParsed
		}
		if maxParsed == nil {
			maxParsed = minParsed
		}
		if *minParsed > *maxParsed {
			minParsed, maxParsed = maxParsed, minParsed
		}
		return minParsed, maxParsed
	}
	return nil, nil
}

func extractJobSortBudget(j dbservice.Job) (float64, bool) {
	isHourly := strings.EqualFold(strings.TrimSpace(j.ContractType), "hourly")
	if !isHourly {
		budgetStr := strings.TrimSpace(j.BudgetAmount)
		if budgetStr == "" {
			budgetStr = strings.TrimSpace(j.Budget)
		}
		if amt := parseNumericOrDollar(budgetStr); amt != nil {
			return *amt, true
		}
	}
	if _, maxRate := extractJobHourlyRateRange(j); maxRate != nil {
		return *maxRate, true
	}
	if amt := scoring.ParseBudgetAmount(j.Budget); amt != nil {
		return *amt, true
	}
	return 0, false
}

func (s *Server) resolveMatchedProjectTargets(ctx context.Context, target string) []string {
	needle := strings.TrimSpace(target)
	if needle == "" {
		return nil
	}
	targets := []string{needle}
	seen := map[string]struct{}{
		strings.ToLower(needle): {},
	}
	appendUnique := func(val string) {
		trimmed := strings.TrimSpace(val)
		if trimmed == "" {
			return
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		targets = append(targets, trimmed)
	}

	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return targets
	}

	// NDA invariant: never resolve private projects' keys into display labels.
	var projects []dbservice.ActiveProject
	if err := s.db.GetGorm().WithContext(ctx).
		Where("LOWER(proposal_visibility) <> ? AND LOWER(project_key) = LOWER(?)", "private", needle).
		Find(&projects).Error; err != nil {
		return targets
	}

	for _, p := range projects {
		displayName, _, _, ok := SanitizedActiveProjectDisplay(p)
		if !ok {
			continue
		}
		appendUnique(displayName)
		if strings.EqualFold(strings.TrimSpace(p.ProposalVisibility), "public") {
			appendUnique(p.PublicAlias)
			appendUnique(p.Name)
		}
	}
	return targets
}

func jobMatchesProject(j dbservice.Job, targets ...string) bool {
	needles := make([]string, 0, len(targets))
	for _, t := range targets {
		if trimmed := strings.TrimSpace(t); trimmed != "" {
			needles = append(needles, trimmed)
		}
	}
	if len(needles) == 0 {
		return true
	}
	matchLabel := func(label string) bool {
		trimmed := strings.TrimSpace(label)
		if trimmed == "" {
			return false
		}
		for _, needle := range needles {
			if strings.EqualFold(trimmed, needle) || scoring.KeywordMatches(needle, trimmed) {
				return true
			}
		}
		return false
	}

	if len(j.ScoreBreakdown) > 0 {
		var sb scoring.ScoreBreakdown
		if err := json.Unmarshal(j.ScoreBreakdown, &sb); err == nil {
			for _, label := range sb.MatchedActiveProjects {
				if matchLabel(label) {
					return true
				}
			}
		}
	}
	if len(j.PortfolioReferences) > 0 {
		var refs []PortfolioReferenceEntry
		if err := json.Unmarshal(j.PortfolioReferences, &refs); err == nil {
			for _, ref := range refs {
				if strings.EqualFold(strings.TrimSpace(ref.Source), "active_project") && matchLabel(ref.DisplayName) {
					return true
				}
			}
		}
	}
	return false
}

// ListJobs queries persisted jobs with optional filtering, sorting, and pagination.
func (s *Server) ListJobs(ctx context.Context, filter ListJobsFilter) ([]JobEntry, error) {
	entries, _, err := s.ListJobsWithTotal(ctx, filter)
	return entries, err
}

// ListJobsWithTotal queries persisted jobs with optional filtering, sorting, and pagination,
// returning both the current page of jobs and the pre-pagination total matching count.
func (s *Server) ListJobsWithTotal(ctx context.Context, filter ListJobsFilter) ([]JobEntry, int, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, 0, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	if filter.SearchRunID != nil && (*filter.SearchRunID == 0 || uint64(*filter.SearchRunID) > math.MaxInt64) {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid search_run_id parameter"}
	}
	contractType := strings.ToLower(strings.TrimSpace(filter.ContractType))
	if contractType != "" && contractType != "hourly" && contractType != "fixed" {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid contract_type parameter"}
	}
	enrichmentStatus := strings.ToLower(strings.TrimSpace(filter.EnrichmentStatus))
	switch enrichmentStatus {
	case "", "none", "detail_only", "queued", "scraping_details", "analyzing", "completed", "failed":
	default:
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid enrichment_status parameter"}
	}
	if err := validateNumericRangeParams(filter.BudgetMin, filter.BudgetMax, "budget"); err != nil {
		return nil, 0, err
	}
	if err := validateNumericRangeParams(filter.HourlyRateMin, filter.HourlyRateMax, "hourly_rate"); err != nil {
		return nil, 0, err
	}

	sortMode := strings.ToLower(strings.TrimSpace(filter.Sort))
	var orderClause string
	switch sortMode {
	case "", "created_desc", "budget_desc":
		orderClause = "created_at DESC, id DESC"
	case "score_desc":
		orderClause = "COALESCE(score, -1) DESC, created_at DESC, id DESC"
	case "posted_desc":
		orderClause = "COALESCE(posted_at_est, created_at) DESC, created_at DESC, id DESC"
	case "enriched_desc":
		orderClause = "ai_enriched_at DESC NULLS LAST, last_enriched_at DESC NULLS LAST, created_at DESC, id DESC"
	default:
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid sort parameter"}
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.Job{})

	if filter.SearchRunID != nil {
		db = db.Where("(jobs.last_search_run_id = ? OR EXISTS (SELECT 1 FROM search_run_jobs srj WHERE srj.job_id = jobs.id AND srj.search_run_id = ?))", *filter.SearchRunID, *filter.SearchRunID)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		db = db.Where("status = ?", status)
	}
	if fit := strings.TrimSpace(filter.Fit); fit != "" {
		db = db.Where("fit_label = ?", fit)
	}
	if contractType != "" {
		db = db.Where("LOWER(TRIM(contract_type)) = ?", contractType)
	}
	if sourceQuery := strings.TrimSpace(filter.SourceQuery); sourceQuery != "" {
		db = db.Where("LOWER(TRIM(source_query)) = LOWER(?)", sourceQuery)
	}
	if filter.MinScore != nil {
		db = db.Where("score >= ?", *filter.MinScore)
	}
	if filter.MaxAgeDays != nil {
		maxAgeDays := *filter.MaxAgeDays
		if maxAgeDays < 0 || maxAgeDays > 36500 {
			return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid max_age_days parameter"}
		}
		cutoff := time.Now().UTC().Add(-time.Duration(maxAgeDays+1) * 24 * time.Hour)
		db = db.Where("(posted_at_est IS NOT NULL AND posted_at_est >= ?) OR (posted_at_est IS NULL AND created_at >= ?)", cutoff, cutoff)
	}
	if filter.MaxProposals != nil {
		maxProposals := *filter.MaxProposals
		if maxProposals < 0 {
			return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid max_proposals parameter"}
		}
		if filter.IncludeUnknown {
			db = db.Where("proposals_count IS NULL OR proposals_count <= ?", maxProposals)
		} else {
			db = db.Where("proposals_count <= ?", maxProposals)
		}
	}
	if enrichmentStatus != "" {
		switch enrichmentStatus {
		case "none":
			db = db.Where("(ai_enrichment_status = 'none' OR ai_enrichment_status = '') AND last_enriched_at IS NULL")
		case "detail_only":
			db = db.Where("(ai_enrichment_status = 'none' OR ai_enrichment_status = '') AND last_enriched_at IS NOT NULL")
		default:
			db = db.Where("ai_enrichment_status = ?", enrichmentStatus)
		}
	}
	if filter.HasAIAnalysis != nil {
		expr := `(ai_enrichment_status = 'completed' OR ai_enriched_at IS NOT NULL OR COALESCE(proposal, '') ~ '\S')`
		if *filter.HasAIAnalysis {
			db = db.Where(expr)
		} else {
			db = db.Where("NOT " + expr)
		}
	}
	if search := strings.TrimSpace(filter.Query); search != "" {
		pattern := "%" + search + "%"
		db = db.Where("(title ILIKE ? OR description ILIKE ? OR skills ILIKE ?)", pattern, pattern, pattern)
	}

	hasBudgetFilter := filter.BudgetMin != nil || filter.BudgetMax != nil
	hasHourlyRateFilter := filter.HourlyRateMin != nil || filter.HourlyRateMax != nil
	hasKeywordFilter := len(filter.RequiredKeywords) > 0 || len(filter.ExcludeKeywords) > 0
	matchedProjectTarget := strings.TrimSpace(filter.MatchedProject)
	hasMatchedProjectFilter := matchedProjectTarget != ""
	hasInMemoryProcessing := hasBudgetFilter || hasHourlyRateFilter || hasKeywordFilter || hasMatchedProjectFilter || sortMode == "budget_desc"

	var matchedProjectTargets []string
	if hasMatchedProjectFilter {
		matchedProjectTargets = s.resolveMatchedProjectTargets(ctx, matchedProjectTarget)
	}

	limit := filter.Limit
	if limit < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid limit parameter"}
	}
	if limit > 500 {
		limit = 500
	}
	offset := filter.Offset
	if offset < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid offset parameter"}
	}

	var totalCount int
	if !hasInMemoryProcessing {
		var count64 int64
		if err := db.Session(&gorm.Session{}).Count(&count64).Error; err != nil {
			log.Printf("❌ Failed to count jobs: %v", err)
			return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list jobs"}
		}
		totalCount = int(count64)
		if limit > 0 {
			db = db.Limit(limit)
		}
		if offset > 0 {
			db = db.Offset(offset)
		}
	}

	var jobs []dbservice.Job
	if err := db.Order(orderClause).Find(&jobs).Error; err != nil {
		log.Printf("❌ Failed to list jobs: %v", err)
		return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list jobs"}
	}

	if hasInMemoryProcessing {
		filtered := make([]dbservice.Job, 0, len(jobs))
		for _, j := range jobs {
			if hasBudgetFilter {
				budgetStr := j.BudgetAmount
				if budgetStr == "" && !strings.EqualFold(j.ContractType, "hourly") {
					budgetStr = j.Budget
				}
				hourlyRate := effectiveHourlyRate(j.RateRange, j.ContractType, j.Budget, j.RateMin, j.RateMax)
				isHourlyJob := strings.EqualFold(strings.TrimSpace(j.ContractType), "hourly") ||
					(strings.TrimSpace(budgetStr) == "" &&
						strings.TrimSpace(hourlyRate) != "" &&
						!strings.Contains(strings.ToLower(strings.TrimSpace(hourlyRate)), "fixed"))
				if !isHourlyJob {
					amt := scoring.ParseBudgetAmount(budgetStr)
					if amt == nil {
						if !filter.IncludeUnknownBudget {
							continue
						}
					} else {
						if filter.BudgetMin != nil && *amt < *filter.BudgetMin {
							continue
						}
						if filter.BudgetMax != nil && *amt > *filter.BudgetMax {
							continue
						}
					}
				}
			}

			if hasHourlyRateFilter {
				minRate, maxRate := extractJobHourlyRateRange(j)
				if minRate == nil && maxRate == nil {
					isFixedJob := strings.EqualFold(strings.TrimSpace(j.ContractType), "fixed") ||
						(strings.TrimSpace(j.BudgetAmount) != "" && !strings.EqualFold(strings.TrimSpace(j.ContractType), "hourly")) ||
						strings.Contains(strings.ToLower(j.RateRange), "fixed")
					if !isFixedJob && !filter.IncludeUnknownBudget {
						continue
					}
				} else {
					if filter.HourlyRateMin != nil && *maxRate < *filter.HourlyRateMin {
						continue
					}
					if filter.HourlyRateMax != nil && *minRate > *filter.HourlyRateMax {
						continue
					}
				}
			}

			if hasKeywordFilter {
				haystack := strings.TrimSpace(j.Title + " " + j.Description + " " + j.Skills)
				if len(filter.RequiredKeywords) > 0 {
					matched := false
					hasNonEmpty := false
					for _, kw := range filter.RequiredKeywords {
						if strings.TrimSpace(kw) == "" {
							continue
						}
						hasNonEmpty = true
						if scoring.KeywordMatches(kw, haystack) {
							matched = true
							break
						}
					}
					if hasNonEmpty && !matched {
						continue
					}
				}
				if len(filter.ExcludeKeywords) > 0 {
					excluded := false
					for _, kw := range filter.ExcludeKeywords {
						if strings.TrimSpace(kw) == "" {
							continue
						}
						if scoring.KeywordMatches(kw, haystack) {
							excluded = true
							break
						}
					}
					if excluded {
						continue
					}
				}
			}

			if hasMatchedProjectFilter && !jobMatchesProject(j, matchedProjectTargets...) {
				continue
			}

			filtered = append(filtered, j)
		}

		if sortMode == "budget_desc" {
			sort.SliceStable(filtered, func(i, j int) bool {
				va, okA := extractJobSortBudget(filtered[i])
				vb, okB := extractJobSortBudget(filtered[j])
				if okA != okB {
					return okA
				}
				return va > vb
			})
		}

		totalCount = len(filtered)
		if offset >= len(filtered) {
			jobs = nil
		} else {
			end := len(filtered)
			if limit > 0 && offset+limit < end {
				end = offset + limit
			}
			jobs = filtered[offset:end]
		}
	}

	entries := make([]JobEntry, 0, len(jobs))
	for _, j := range jobs {
		entries = append(entries, jobEntryFromModel(j))
	}
	return entries, totalCount, nil
}

// ResolveJobRef resolves a job by flexible job_id (uint, int, float64, numeric string, or ~upworkJobID) or explicit upwork_job_id.
func (s *Server) ResolveJobRef(ctx context.Context, jobIDRaw any, upworkJobID string) (*dbservice.Job, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)

	var numericID uint64
	var upworkID string

	switch v := jobIDRaw.(type) {
	case nil:
	case uint:
		if v == 0 || uint64(v) > math.MaxInt64 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case uint64:
		if v == 0 || v > math.MaxInt64 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = v
	case uint32:
		if v == 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case int:
		if v <= 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case int64:
		if v <= 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case int32:
		if v <= 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v != math.Trunc(v) || v >= 9223372036854775808 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(v)
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 || f != math.Trunc(f) || f >= 9223372036854775808 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
		}
		numericID = uint64(f)
	case json.Number:
		sVal := strings.TrimSpace(v.String())
		if sVal != "" {
			parsed, err := strconv.ParseUint(sVal, 10, 64)
			if err != nil || parsed == 0 || parsed > math.MaxInt64 {
				return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
			}
			numericID = parsed
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed != "" {
			if parsed, err := strconv.ParseUint(trimmed, 10, 64); err == nil || errors.Is(err, strconv.ErrRange) {
				if err != nil || parsed == 0 || parsed > math.MaxInt64 {
					return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
				}
				numericID = parsed
			} else {
				upworkID = firstNonEmpty(scoring.NormalizeUpworkJobID(trimmed), trimmed)
			}
		}
	default:
		if b, err := json.Marshal(v); err == nil {
			sVal := strings.Trim(strings.TrimSpace(string(b)), `"`)
			if parsed, err := strconv.ParseUint(sVal, 10, 64); err == nil || errors.Is(err, strconv.ErrRange) {
				if err != nil || parsed == 0 || parsed > math.MaxInt64 {
					return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid numeric job_id"}
				}
				numericID = parsed
			} else if sVal != "" && sVal != "null" {
				upworkID = firstNonEmpty(scoring.NormalizeUpworkJobID(sVal), sVal)
			}
		}
	}

	if upworkID == "" && strings.TrimSpace(upworkJobID) != "" {
		upworkID = firstNonEmpty(scoring.NormalizeUpworkJobID(upworkJobID), strings.TrimSpace(upworkJobID))
	}

	if numericID == 0 && upworkID == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "job_id or upwork_job_id is required"}
	}

	var job dbservice.Job
	var err error
	if numericID > 0 {
		err = gormDB.First(&job, numericID).Error
	} else {
		err = gormDB.Where("upwork_job_id = ?", upworkID).First(&job).Error
	}
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Job not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load job"}
	}
	return &job, nil
}

// GetJob retrieves a single job by numeric id or upwork_job_id.
func (s *Server) GetJob(ctx context.Context, id uint, upworkJobID string) (*JobEntry, error) {
	var ref any
	if id > 0 {
		ref = id
	}
	job, err := s.ResolveJobRef(ctx, ref, upworkJobID)
	if err != nil {
		return nil, err
	}
	entry := jobEntryFromModel(*job)
	return &entry, nil
}

// ListHotJobs returns hot jobs (fit_label='hot' or score >= 80) ordered by score desc.
func (s *Server) ListHotJobs(ctx context.Context, limit int) ([]JobEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var jobs []dbservice.Job
	if err := s.db.GetGorm().WithContext(ctx).
		Where("fit_label = ? OR score >= ?", "hot", 80).
		Order("COALESCE(score, -1) DESC, created_at DESC, id DESC").
		Limit(limit).
		Find(&jobs).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list hot jobs"}
	}
	entries := make([]JobEntry, 0, len(jobs))
	for _, j := range jobs {
		entries = append(entries, jobEntryFromModel(j))
	}
	return entries, nil
}

func respondInvalidParams(w http.ResponseWriter, msg string) {
	respondBridgeError(w, &ServiceError{
		Code:       "INVALID_PARAMS",
		HTTPStatus: http.StatusBadRequest,
		Message:    msg,
	})
}

func parseKeywordQueryParam(q url.Values, keys ...string) []string {
	var out []string
	seen := make(map[string]struct{})
	for _, key := range keys {
		for _, raw := range q[key] {
			for _, part := range strings.Split(raw, ",") {
				trimmed := strings.TrimSpace(part)
				if trimmed == "" {
					continue
				}
				lower := strings.ToLower(trimmed)
				if _, exists := seen[lower]; exists {
					continue
				}
				seen[lower] = struct{}{}
				out = append(out, trimmed)
			}
		}
	}
	return out
}

func parseOptionalFloatQueryParam(q url.Values, name string) (*float64, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return nil, fmt.Errorf("invalid %s parameter", name)
	}
	return &v, nil
}

func parseOptionalBoolQueryParam(q url.Values, name string) (*bool, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid %s parameter", name)
	}
	return &v, nil
}

func (s *Server) listJobsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 List jobs request received")
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	filter := ListJobsFilter{
		Status:           strings.TrimSpace(q.Get("status")),
		Fit:              strings.TrimSpace(q.Get("fit")),
		ContractType:     strings.TrimSpace(q.Get("contract_type")),
		SourceQuery:      strings.TrimSpace(q.Get("source_query")),
		Query:            firstNonEmpty(q.Get("q"), q.Get("query")),
		RequiredKeywords: parseKeywordQueryParam(q, "required_keywords"),
		ExcludeKeywords:  parseKeywordQueryParam(q, "exclude_keywords"),
		EnrichmentStatus: strings.TrimSpace(q.Get("enrichment_status")),
		MatchedProject:   strings.TrimSpace(q.Get("matched_project")),
		Sort:             strings.TrimSpace(q.Get("sort")),
	}

	if incUnknown, err := parseOptionalBoolQueryParam(q, "include_unknown"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	} else if incUnknown != nil {
		filter.IncludeUnknown = *incUnknown
	}
	if incUnknownBudget, err := parseOptionalBoolQueryParam(q, "include_unknown_budget"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	} else if incUnknownBudget != nil {
		filter.IncludeUnknownBudget = *incUnknownBudget
	}
	if hasAI, err := parseOptionalBoolQueryParam(q, "has_ai_analysis"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	} else if hasAI != nil {
		filter.HasAIAnalysis = hasAI
	}

	if runIDRaw := strings.TrimSpace(q.Get("search_run_id")); runIDRaw != "" {
		runIDVal, err := strconv.ParseUint(runIDRaw, 10, 64)
		if err != nil || runIDVal == 0 || runIDVal > math.MaxInt64 {
			respondInvalidParams(w, "Invalid search_run_id parameter")
			return
		}
		runID := uint(runIDVal)
		filter.SearchRunID = &runID
	}

	var err error
	if filter.BudgetMin, err = parseOptionalFloatQueryParam(q, "budget_min"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	}
	if filter.BudgetMax, err = parseOptionalFloatQueryParam(q, "budget_max"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	}
	if filter.HourlyRateMin, err = parseOptionalFloatQueryParam(q, "hourly_rate_min"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	}
	if filter.HourlyRateMax, err = parseOptionalFloatQueryParam(q, "hourly_rate_max"); err != nil {
		respondInvalidParams(w, err.Error())
		return
	}

	if minScoreRaw := strings.TrimSpace(q.Get("min_score")); minScoreRaw != "" {
		minScore, err := strconv.Atoi(minScoreRaw)
		if err != nil {
			respondInvalidParams(w, "Invalid min_score parameter")
			return
		}
		filter.MinScore = &minScore
	}
	if maxAgeRaw := strings.TrimSpace(q.Get("max_age_days")); maxAgeRaw != "" {
		maxAgeDays, err := strconv.Atoi(maxAgeRaw)
		if err != nil || maxAgeDays < 0 || maxAgeDays > 36500 {
			respondInvalidParams(w, "Invalid max_age_days parameter")
			return
		}
		filter.MaxAgeDays = &maxAgeDays
	}
	if maxPropRaw := strings.TrimSpace(q.Get("max_proposals")); maxPropRaw != "" {
		maxProposals, err := strconv.Atoi(maxPropRaw)
		if err != nil || maxProposals < 0 {
			respondInvalidParams(w, "Invalid max_proposals parameter")
			return
		}
		filter.MaxProposals = &maxProposals
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 {
			respondInvalidParams(w, "Invalid limit parameter")
			return
		}
		filter.Limit = limit
	}
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		offset, err := strconv.Atoi(rawOffset)
		if err != nil || offset < 0 {
			respondInvalidParams(w, "Invalid offset parameter")
			return
		}
		filter.Offset = offset
	}

	entries, total, err := s.ListJobsWithTotal(r.Context(), filter)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	log.Printf("✅ Listed %d jobs (total=%d)", len(entries), total)
	respondWithJSON(w, listJobsResponse{Jobs: entries, Total: total})
}

func extractJobIDParam(r *http.Request) (uint64, error) {
	idStr := r.PathValue("id")
	if idStr == "" {
		idStr = strings.TrimPrefix(r.URL.Path, "/api/jobs/")
	}
	idVal, err := strconv.ParseUint(strings.TrimSpace(idStr), 10, 64)
	if err != nil || idVal == 0 || idVal > math.MaxInt64 {
		return 0, errors.New("invalid job ID")
	}
	return idVal, nil
}

func (s *Server) getJobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractJobIDParam(r)
	if err != nil {
		respondInvalidParams(w, "Invalid job ID")
		return
	}
	entry, getErr := s.GetJob(r.Context(), uint(id), "")
	if getErr != nil {
		respondBridgeError(w, getErr)
		return
	}
	respondWithJSON(w, map[string]any{"job": entry})
}

type updateJobRequest struct {
	Status       *string         `json:"status"`
	Proposal     *string         `json:"proposal"`
	Score        *int            `json:"score"`
	FitLabel     *string         `json:"fit_label"`
	AppliedAt    *time.Time      `json:"applied_at"`
	ProposalJSON json.RawMessage `json:"proposal_json"`
}

func (s *Server) updateJobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractJobIDParam(r)
	if err != nil {
		respondInvalidParams(w, "Invalid job ID")
		return
	}

	var req updateJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	var job dbservice.Job
	if err := s.db.GetGorm().First(&job, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondWithError(w, http.StatusNotFound, "Job not found")
			return
		}
		log.Printf("❌ Failed to find job %d: %v", id, err)
		respondWithError(w, http.StatusInternalServerError, "Failed to find job")
		return
	}

	if req.Status != nil {
		job.Status = strings.TrimSpace(*req.Status)
		if strings.EqualFold(job.Status, "applied") && job.AppliedAt == nil && req.AppliedAt == nil {
			now := time.Now().UTC()
			job.AppliedAt = &now
		}
	}
	if req.Proposal != nil {
		job.Proposal = *req.Proposal
	}
	if req.Score != nil {
		job.Score = req.Score
		if req.FitLabel == nil {
			job.FitLabel = scoring.FitLabelForScore(*req.Score)
		}
	}
	if req.FitLabel != nil {
		job.FitLabel = strings.TrimSpace(*req.FitLabel)
	}
	if req.AppliedAt != nil {
		job.AppliedAt = req.AppliedAt
	}
	if len(req.ProposalJSON) > 0 {
		parsed, pErr := parseFlexibleJSONB(req.ProposalJSON)
		if pErr != nil {
			respondWithError(w, http.StatusBadRequest, "Invalid proposal_json value")
			return
		}
		job.ProposalJSON = parsed
	}

	if err := s.db.GetGorm().Save(&job).Error; err != nil {
		log.Printf("❌ Failed to update job %d: %v", id, err)
		respondWithError(w, http.StatusInternalServerError, "Failed to update job")
		return
	}

	respondWithJSON(w, map[string]any{"job": jobEntryFromModel(job)})
}

func (s *Server) deleteJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Delete job request received")
	if r.Method != http.MethodDelete {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	id, err := extractJobIDParam(r)
	if err != nil {
		log.Printf("❌ Invalid job ID")
		respondInvalidParams(w, "Invalid job ID")
		return
	}

	result := s.db.GetGorm().Delete(&dbservice.Job{}, id)
	if result.Error != nil {
		log.Printf("❌ Failed to delete job: %v", result.Error)
		respondWithError(w, http.StatusInternalServerError, "Failed to delete job")
		return
	}

	if result.RowsAffected == 0 {
		log.Printf("❌ Job not found: id=%d", id)
		respondWithError(w, http.StatusNotFound, "Job not found")
		return
	}

	log.Printf("✅ Job deleted: id=%d", id)
	w.WriteHeader(http.StatusNoContent)
}

// respondWithError sends a JSON error response
func respondWithError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"error": message}); err != nil {
		log.Printf("⚠️ Failed to write error response: %v", err)
	}
}
