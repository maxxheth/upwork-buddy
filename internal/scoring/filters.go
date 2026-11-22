package scoring

import (
	"sort"
	"strings"
)

// FilterStage distinguishes pre-enrichment search-card filtering from post-enrichment filtering.
type FilterStage string

const (
	StagePreEnrichment  FilterStage = "pre_enrichment"
	StagePostEnrichment FilterStage = "post_enrichment"
)

// FilterConfig specifies deterministic job candidate filters matching SearchProfileConfig.Filters.
type FilterConfig struct {
	RequiredKeywords    []string `json:"required_keywords,omitempty"`
	ExcludeKeywords     []string `json:"exclude_keywords,omitempty"`
	MinScore            *int     `json:"min_score,omitempty"`
	MaxPostedAgeDays    *int     `json:"max_posted_age_days,omitempty"`
	MaxProposals        *int     `json:"max_proposals,omitempty"`
	BudgetMin           *float64 `json:"budget_min,omitempty"`
	BudgetMax           *float64 `json:"budget_max,omitempty"`
	HourlyRateMin       *float64 `json:"hourly_rate_min,omitempty"`
	HourlyRateMax       *float64 `json:"hourly_rate_max,omitempty"`
	PaymentVerifiedOnly bool     `json:"payment_verified_only,omitempty"`
	SortByScore         bool     `json:"sort_by_score,omitempty"`
}

func isFixedPriceLabel(raw string) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(raw)), "fixed")
}

func jobHaystack(j JobInput) string {
	return strings.TrimSpace(j.Title + " " + j.Description + " " + strings.Join(j.Skills, " "))
}

// FilterCandidates filters and optionally sorts candidate jobs for either pre-enrichment
// (preserving unknown proposals/budgets for detail scraping) or post-enrichment stages.
func FilterCandidates(jobs []JobInput, filters FilterConfig, stage FilterStage, profile *ScoringProfile) []JobInput {
	filtered := make([]JobInput, 0, len(jobs))

	for _, j := range jobs {
		haystack := jobHaystack(j)

		// 1. Required keywords (at least one must match)
		if len(filters.RequiredKeywords) > 0 {
			matched := false
			for _, kw := range filters.RequiredKeywords {
				if KeywordMatches(kw, haystack) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}

		// 2. Exclude keywords (none may match)
		if len(filters.ExcludeKeywords) > 0 {
			excluded := false
			for _, kw := range filters.ExcludeKeywords {
				if KeywordMatches(kw, haystack) {
					excluded = true
					break
				}
			}
			if excluded {
				continue
			}
		}

		// 3. Max posted age days (unknown age passes)
		if filters.MaxPostedAgeDays != nil {
			if age := ParsePostedAge(j.Posted); age != nil && *age > *filters.MaxPostedAgeDays {
				continue
			}
		}

		// 4. Max proposals (pre-enrichment keeps unknown; post-enrichment drops unknown)
		if filters.MaxProposals != nil {
			includeUnknown := stage == StagePreEnrichment
			if j.ProposalsCount != nil {
				if *j.ProposalsCount > *filters.MaxProposals {
					continue
				}
			} else if !JobMeetsProposalThreshold(j.Proposals, filters.MaxProposals, includeUnknown) {
				continue
			}
		}

		// 5. Budget range filter (fixes Stage 2/3 order and BudgetMax == 0 vs nil)
		if filters.BudgetMin != nil || filters.BudgetMax != nil {
			isHourlyJob := strings.TrimSpace(j.Budget) == "" &&
				strings.TrimSpace(j.HourlyRate) != "" &&
				!isFixedPriceLabel(j.HourlyRate)
			if !isHourlyJob {
				amt := ParseBudgetAmount(j.Budget)
				if amt == nil {
					if stage == StagePostEnrichment {
						continue
					}
					// StagePreEnrichment: keep unknown-budget cards so detail enrichment can resolve actual budget
				} else {
					if filters.BudgetMin != nil && *amt < *filters.BudgetMin {
						continue
					}
					if filters.BudgetMax != nil && *amt > *filters.BudgetMax {
						continue
					}
				}
			}
		}

		// 6. Hourly rate range filter (overlap semantics; fixed-price jobs unaffected)
		if filters.HourlyRateMin != nil || filters.HourlyRateMax != nil {
			minRate, maxRate := ParseHourlyRateRange(j.HourlyRate)
			if minRate == nil && maxRate == nil {
				isFixedJob := strings.TrimSpace(j.Budget) != "" || isFixedPriceLabel(j.HourlyRate)
				if !isFixedJob && stage == StagePostEnrichment {
					continue
				}
			} else {
				if filters.HourlyRateMin != nil && filters.HourlyRateMax != nil && *filters.HourlyRateMin > *filters.HourlyRateMax {
					continue
				}
				if filters.HourlyRateMin != nil && *maxRate < *filters.HourlyRateMin {
					continue
				}
				if filters.HourlyRateMax != nil && *minRate > *filters.HourlyRateMax {
					continue
				}
			}
		}

		// 7. Payment verified filter (pre-enrichment drops explicit false and keeps nil; post-enrichment requires true)
		if filters.PaymentVerifiedOnly {
			if j.PaymentVerified == nil {
				if stage == StagePostEnrichment {
					continue
				}
			} else if !*j.PaymentVerified {
				continue
			}
		}

		filtered = append(filtered, j)
	}

	// 8. MinScore filtering (post-enrichment) and optional score sorting
	if (stage == StagePostEnrichment && filters.MinScore != nil) || filters.SortByScore {
		type scoredJob struct {
			score int
			idx   int
			job   JobInput
		}
		scored := make([]scoredJob, 0, len(filtered))
		for idx, j := range filtered {
			res := ScoreJob(j, profile)
			if stage == StagePostEnrichment && filters.MinScore != nil && res.Score < *filters.MinScore {
				continue
			}
			scored = append(scored, scoredJob{score: res.Score, idx: idx, job: j})
		}
		if filters.SortByScore {
			sort.SliceStable(scored, func(i, j int) bool {
				if scored[i].score != scored[j].score {
					return scored[i].score > scored[j].score
				}
				return scored[i].idx < scored[j].idx
			})
		}
		out := make([]JobInput, 0, len(scored))
		for _, item := range scored {
			out = append(out, item.job)
		}
		return out
	}

	return filtered
}
