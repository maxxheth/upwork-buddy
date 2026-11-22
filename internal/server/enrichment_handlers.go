package server

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

func extractEnrichmentBatchIDParam(r *http.Request) (uint64, error) {
	idStr := strings.TrimSpace(r.PathValue("id"))
	if idStr == "" {
		path := strings.TrimPrefix(r.URL.Path, "/api/enrichment-batches/")
		if idx := strings.Index(path, "/"); idx != -1 {
			path = path[:idx]
		}
		idStr = strings.TrimSpace(path)
	}
	idVal, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil || idVal == 0 || idVal > math.MaxInt64 {
		return 0, errors.New("invalid enrichment batch ID")
	}
	return idVal, nil
}

// enrichmentConfigHandler handles GET /api/enrichment-config requests.
func (s *Server) enrichmentConfigHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	respondWithJSON(w, ResolveEnrichmentConfig())
}

// enrichJobsHandler handles POST /api/jobs/enrich requests.
func (s *Server) enrichJobsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		})
		return
	}

	var req BatchEnrichRequest
	if r.Body == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	if err := dec.Decode(&req); err != nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}

	res, err := s.getEnrichmentManager().StartBatch(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	if req.Wait != nil && *req.Wait && res.Completed {
		respondWithJSON(w, res)
		return
	}
	respondWithJSONStatus(w, http.StatusAccepted, res)
}

// listEnrichmentBatchesHandler handles GET /api/enrichment-batches requests.
func (s *Server) listEnrichmentBatchesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		})
		return
	}

	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))

	limit := 0
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v <= 0 {
			respondBridgeError(w, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Invalid limit parameter",
			})
			return
		}
		limit = v
	}

	offset := 0
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		v, err := strconv.Atoi(rawOffset)
		if err != nil || v < 0 {
			respondBridgeError(w, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Invalid offset parameter",
			})
			return
		}
		offset = v
	}

	batches, total, err := s.getEnrichmentManager().ListBatches(r.Context(), status, limit, offset)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, map[string]any{
		"batches": batches,
		"total":   total,
	})
}

// getEnrichmentBatchHandler handles GET /api/enrichment-batches/{id} requests.
func (s *Server) getEnrichmentBatchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		})
		return
	}

	idVal, err := extractEnrichmentBatchIDParam(r)
	if err != nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid enrichment batch ID",
		})
		return
	}

	res, err := s.getEnrichmentManager().GetBatch(r.Context(), uint(idVal))
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

// cancelEnrichmentBatchHandler handles POST /api/enrichment-batches/{id}/cancel requests.
func (s *Server) cancelEnrichmentBatchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		})
		return
	}

	idVal, err := extractEnrichmentBatchIDParam(r)
	if err != nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid enrichment batch ID",
		})
		return
	}

	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		var body map[string]any
		err := dec.Decode(&body)
		if err != nil && !errors.Is(err, io.EOF) {
			respondBridgeError(w, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Invalid request body",
			})
			return
		}
		if err == nil {
			var extra any
			if err2 := dec.Decode(&extra); !errors.Is(err2, io.EOF) {
				respondBridgeError(w, &ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "Invalid request body",
				})
				return
			}
		}
	}

	res, err := s.getEnrichmentManager().CancelBatch(r.Context(), uint(idVal))
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}
