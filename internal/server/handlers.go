package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/gemini"

	"gorm.io/gorm"
)

// analyzeJobHandler handles POST /api/analyze-job requests
func (s *Server) analyzeJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("=== ANALYZE JOB REQUEST START ===")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req gemini.JobAnalysisRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	log.Printf("📥 Received request: title=%q, budget=%q, skills=%q, profile_length=%d, user_skills_length=%d",
		req.JobTitle, req.Budget, req.Skills, len(req.UserProfile), len(req.UserSkills))

	// Create Gemini service
	geminiService, err := gemini.New()
	if err != nil {
		log.Printf("❌ Failed to create Gemini service: %v", err)
		http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer geminiService.Close()

	// Analyze the job
	result, err := geminiService.AnalyzeJob(r.Context(), req)
	if err != nil {
		log.Printf("❌ Failed to analyze job: %v", err)
		http.Error(w, "Failed to analyze job", http.StatusInternalServerError)
		return
	}

	log.Printf("✅ Analysis complete: proposal_length=%d, spec_sheet_length=%d, questions=%d, tips=%d",
		len(result.Proposal), len(result.SpecSheetPrompt),
		len(result.QuestionsForClient), len(result.TipsAndAdvice))

	// Return the response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("❌ Failed to encode response: %v", err)
	} else {
		log.Printf("📤 Response sent successfully")
	}
	log.Printf("=== ANALYZE JOB REQUEST END ===")
}

type profileRequest struct {
	Description    string                 `json:"description"`
	Skills         string                 `json:"skills"`
	PortfolioItems []portfolioItemRequest `json:"portfolio_items"`
}

type portfolioItemRequest struct {
	Title       string `json:"title"`
	Link        string `json:"link"`
	Description string `json:"description"`
}

type profileResponse struct {
	Description    string                  `json:"description"`
	Skills         string                  `json:"skills"`
	PortfolioItems []portfolioItemResponse `json:"portfolio_items"`
}

type portfolioItemResponse struct {
	ID          uint   `json:"id"`
	Title       string `json:"title"`
	Link        string `json:"link"`
	Description string `json:"description"`
}

func (s *Server) profileHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getProfile(w)
	case http.MethodPost, http.MethodPut:
		s.saveProfile(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) getProfile(w http.ResponseWriter) {
	db := s.db.GetGorm()
	var profile dbservice.Profile
	if err := db.Preload("PortfolioItems").Order("id asc").First(&profile).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondWithJSON(w, profileResponse{})
			return
		}
		http.Error(w, "Failed to load profile", http.StatusInternalServerError)
		return
	}

	respondWithJSON(w, profileResponseFromModel(&profile))
}

func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request) {
	var payload profileRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	db := s.db.GetGorm()
	tx := db.Begin()
	if tx.Error != nil {
		http.Error(w, "Database unavailable", http.StatusInternalServerError)
		return
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			panic(r)
		}
	}()

	var profile dbservice.Profile
	err := tx.Preload("PortfolioItems").Order("id asc").First(&profile).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		profile = dbservice.Profile{
			Description: payload.Description,
			Skills:      payload.Skills,
		}
		if err := tx.Create(&profile).Error; err != nil {
			tx.Rollback()
			http.Error(w, "Failed to create profile", http.StatusInternalServerError)
			return
		}
	} else if err != nil {
		tx.Rollback()
		http.Error(w, "Failed to load profile", http.StatusInternalServerError)
		return
	} else {
		profile.Description = payload.Description
		profile.Skills = payload.Skills
		if err := tx.Save(&profile).Error; err != nil {
			tx.Rollback()
			http.Error(w, "Failed to update profile", http.StatusInternalServerError)
			return
		}
		if err := tx.Where("profile_id = ?", profile.ID).Delete(&dbservice.PortfolioItem{}).Error; err != nil {
			tx.Rollback()
			http.Error(w, "Failed to clear existing portfolio", http.StatusInternalServerError)
			return
		}
	}

	createdItems := make([]portfolioItemResponse, 0, len(payload.PortfolioItems))
	for _, itemReq := range payload.PortfolioItems {
		if strings.TrimSpace(itemReq.Title) == "" && strings.TrimSpace(itemReq.Link) == "" && strings.TrimSpace(itemReq.Description) == "" {
			continue
		}
		portfolioItem := dbservice.PortfolioItem{
			ProfileID:   profile.ID,
			Title:       itemReq.Title,
			Link:        itemReq.Link,
			Description: itemReq.Description,
		}
		if err := tx.Create(&portfolioItem).Error; err != nil {
			tx.Rollback()
			http.Error(w, "Failed to save portfolio items", http.StatusInternalServerError)
			return
		}
		createdItems = append(createdItems, portfolioItemResponse{
			ID:          portfolioItem.ID,
			Title:       portfolioItem.Title,
			Link:        portfolioItem.Link,
			Description: portfolioItem.Description,
		})
	}

	if err := tx.Commit().Error; err != nil {
		http.Error(w, "Failed to persist profile", http.StatusInternalServerError)
		return
	}

	respondWithJSON(w, profileResponse{
		Description:    profile.Description,
		Skills:         profile.Skills,
		PortfolioItems: createdItems,
	})
}

func profileResponseFromModel(profile *dbservice.Profile) profileResponse {
	items := make([]portfolioItemResponse, 0, len(profile.PortfolioItems))
	for _, item := range profile.PortfolioItems {
		items = append(items, portfolioItemResponse{
			ID:          item.ID,
			Title:       item.Title,
			Link:        item.Link,
			Description: item.Description,
		})
	}
	return profileResponse{
		Description:    profile.Description,
		Skills:         profile.Skills,
		PortfolioItems: items,
	}
}

func respondWithJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("Failed to encode response: %v", err)
	}
}
