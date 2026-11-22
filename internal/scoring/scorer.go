package scoring

import (
	"fmt"
	"math"
	"strings"
)

// DefaultPortfolioKeywords mirrors PORTFOLIO_KEYWORDS from upwork-scraper-fs.
var DefaultPortfolioKeywords = []string{
	"wordpress", "php", "python", "golang", "react", "javascript",
	"sage", "docker", "api", "postgresql", "mysql", "aws", "devops",
	"tailwind", "typescript", "vue", "laravel", "acf", "gutenberg",
	"css", "html", "rest", "graphql", "nginx", "redis", "linux",
	"scrapy", "selenium", "playwright", "puppeteer", "pandas",
	"fastapi", "flask", "django", "next.js", "nuxt",
	"terraform", "ansible", "ci/cd", "github actions", "cloudflare", "ubuntu",
	"llm", "openai", "claude", "anthropic", "rag", "langchain", "agent",
}

// JobInput contains the normalized job and client signals used for deterministic scoring and filtering.
type JobInput struct {
	Title            string   `json:"title"`
	URL              string   `json:"url"`
	Description      string   `json:"description"`
	Budget           string   `json:"budget"`
	HourlyRate       string   `json:"hourly_rate"`
	ExperienceLevel  string   `json:"experience_level"`
	Duration         string   `json:"duration"`
	HoursPerWeek     string   `json:"hours_per_week"`
	Skills           []string `json:"skills"`
	Posted           string   `json:"posted"`
	Country          string   `json:"country"`
	Proposals        string   `json:"proposals"`
	ProposalsCount   *int     `json:"proposals_count,omitempty"`
	ClientRating     *float64 `json:"client_rating,omitempty"`
	ClientReviews    *int     `json:"client_reviews,omitempty"`
	ClientHires      *int     `json:"client_hires,omitempty"`
	ClientSpent      string   `json:"client_spent"`
	ClientHireRate   *float64 `json:"client_hire_rate,omitempty"`   // 0..100
	PaymentVerified  *bool    `json:"payment_verified,omitempty"`
	ConnectsRequired *int     `json:"connects_required,omitempty"`
}

// PortfolioRef represents a freelancer portfolio item used for relevance scoring.
type PortfolioRef struct {
	Title       string `json:"title"`
	Link        string `json:"link,omitempty"`
	Description string `json:"description"`
}

// ActiveProjectRef represents a tracked active project for informational job matching.
type ActiveProjectRef struct {
	Key                string   `json:"key"`
	Name               string   `json:"name"`
	PublicAlias        string   `json:"public_alias,omitempty"`
	ProposalVisibility string   `json:"proposal_visibility"`
	ActivityTier       string   `json:"activity_tier"`
	Summary            string   `json:"summary,omitempty"`
	TechStack          []string `json:"tech_stack,omitempty"`
}

// ScoringProfile configures skill and portfolio matching from the persisted Profile.
type ScoringProfile struct {
	Description    string             `json:"description"`
	Skills         []string           `json:"skills"` // empty => fallback to DefaultPortfolioKeywords
	PortfolioItems []PortfolioRef     `json:"portfolio_items,omitempty"`
	ActiveProjects []ActiveProjectRef `json:"active_projects,omitempty"`
}

// ScoreBreakdown records each scoring component and modifier contribution.
type ScoreBreakdown struct {
	RateBudget            int      `json:"rate_budget"`          // 0..25
	SkillMatch            int      `json:"skill_match"`          // 0..25
	ClientSpend           int      `json:"client_spend"`         // 0..15
	ClientHires           int      `json:"client_hires"`         // 0..10
	ProposalCount         int      `json:"proposal_count"`       // 0..10 (nil => 8)
	Recency               int      `json:"recency"`              // 0..10
	DescriptionQuality    int      `json:"description_quality"`  // 0..5
	PaymentVerifiedMod    int      `json:"payment_verified_mod"` // +5 / -5 / 0
	ClientHireRateMod     int      `json:"client_hire_rate_mod"` // +5 / +2 / -3 / 0
	ConnectsMod           int      `json:"connects_mod"`         // +2 / -3 / 0
	MatchedSkills         []string `json:"matched_skills,omitempty"`
	MatchedPortfolio      []string `json:"matched_portfolio,omitempty"`
	MatchedActiveProjects []string `json:"matched_active_projects,omitempty"`
}

// ScoreResult is the full deterministic score evaluation output.
type ScoreResult struct {
	Score     int            `json:"score"`     // clamped [0, 100]
	FitLabel  string         `json:"fit_label"` // "hot" | "ready" | "review" | "skip"
	Breakdown ScoreBreakdown `json:"score_breakdown"`
	Reasons   []string       `json:"reasons"`
}

// FitLabelForScore maps a numeric 0..100 score to its fit tier label.
func FitLabelForScore(score int) string {
	switch {
	case score >= 80:
		return "hot"
	case score >= 60:
		return "ready"
	case score >= 40:
		return "review"
	default:
		return "skip"
	}
}

func extractHourlyMaxRate(hourlyRate string) float64 {
	_, maxRate := ParseHourlyRateRange(hourlyRate)
	if maxRate == nil || math.IsNaN(*maxRate) {
		return 0
	}
	return *maxRate
}

func normalizeSkillList(raw []string) []string {
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		for _, part := range strings.Split(entry, ",") {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			key := strings.ToLower(trimmed)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, trimmed)
		}
	}
	return out
}

// ScoreJob computes a deterministic 0-100 job score, breakdown, fit label, and reasoning.
func ScoreJob(job JobInput, profile *ScoringProfile) ScoreResult {
	var breakdown ScoreBreakdown
	reasons := make([]string, 0, 10)

	// 1. Rate / budget match (0..25)
	hourlyRate := strings.TrimSpace(job.HourlyRate)
	budget := strings.TrimSpace(job.Budget)
	if hourlyRate != "" {
		maxRate := extractHourlyMaxRate(hourlyRate)
		switch {
		case maxRate >= 50 && maxRate < 100:
			breakdown.RateBudget = 25
		case maxRate >= 100:
			breakdown.RateBudget = 20
		case maxRate >= 30 && maxRate < 50:
			breakdown.RateBudget = 10
		case maxRate == 0 && strings.Contains(strings.ToLower(hourlyRate), "fixed"):
			breakdown.RateBudget = 5
		}
		reasons = append(reasons, fmt.Sprintf("Rate/budget signal: %s.", hourlyRate))
	} else if budget != "" {
		amt := ParseBudgetAmount(budget)
		if amt != nil {
			switch {
			case *amt >= 1000:
				breakdown.RateBudget = 20
			case *amt >= 500:
				breakdown.RateBudget = 15
			case *amt >= 200:
				breakdown.RateBudget = 10
			default:
				breakdown.RateBudget = 5
			}
		} else {
			breakdown.RateBudget = 5
		}
		reasons = append(reasons, fmt.Sprintf("Rate/budget signal: %s.", budget))
	}

	// 2. Skill & portfolio match (0..25)
	keywords := DefaultPortfolioKeywords
	var portfolioItems []PortfolioRef
	if profile != nil {
		if cleaned := normalizeSkillList(profile.Skills); len(cleaned) > 0 {
			keywords = cleaned
		}
		portfolioItems = profile.PortfolioItems
	}

	matchedSkills := make([]string, 0)
	for _, kw := range keywords {
		for _, jobSkill := range job.Skills {
			if KeywordMatches(kw, jobSkill) {
				matchedSkills = append(matchedSkills, kw)
				break
			}
		}
	}
	breakdown.MatchedSkills = matchedSkills

	matchedPortfolio := make([]string, 0)
	if len(portfolioItems) > 0 {
		jobHaystack := strings.TrimSpace(job.Title + " " + job.Description + " " + strings.Join(job.Skills, " "))
		// Match portfolio items when any job skill or matched keyword appears in the item title/description,
		// or when a term from the item title/description matches the job.
		searchTerms := make([]string, 0, len(job.Skills)+len(matchedSkills))
		searchTerms = append(searchTerms, job.Skills...)
		searchTerms = append(searchTerms, matchedSkills...)
		searchTerms = normalizeSkillList(searchTerms)

		for _, item := range portfolioItems {
			itemText := strings.TrimSpace(item.Title + " " + item.Description)
			if itemText == "" {
				continue
			}
			itemMatched := false
			for _, term := range searchTerms {
				if KeywordMatches(term, itemText) {
					itemMatched = true
					break
				}
			}
			if !itemMatched && jobHaystack != "" {
				for _, kw := range keywords {
					if KeywordMatches(kw, itemText) && KeywordMatches(kw, jobHaystack) {
						itemMatched = true
						break
					}
				}
			}
			if itemMatched {
				title := strings.TrimSpace(item.Title)
				if title == "" {
					title = "portfolio-item"
				}
				matchedPortfolio = append(matchedPortfolio, title)
			}
		}
	}
	breakdown.MatchedPortfolio = matchedPortfolio

	skillPts := len(matchedSkills)*5 + len(matchedPortfolio)*3
	if skillPts > 25 {
		skillPts = 25
	}
	breakdown.SkillMatch = skillPts
	if len(matchedSkills) > 0 {
		limit := len(matchedSkills)
		if limit > 8 {
			limit = 8
		}
		reasons = append(reasons, fmt.Sprintf("Portfolio skill matches: %s.", strings.Join(matchedSkills[:limit], ", ")))
	}
	if len(matchedPortfolio) > 0 {
		reasons = append(reasons, fmt.Sprintf("Matching portfolio items: %s.", strings.Join(matchedPortfolio, ", ")))
	}

	// Informational active project matching (does NOT affect numeric score or breakdown.SkillMatch).
	if profile != nil && len(profile.ActiveProjects) > 0 {
		jobHaystack := strings.TrimSpace(job.Title + " " + job.Description + " " + strings.Join(job.Skills, " "))
		searchTerms := make([]string, 0, len(job.Skills)+len(matchedSkills))
		searchTerms = append(searchTerms, job.Skills...)
		searchTerms = append(searchTerms, matchedSkills...)
		searchTerms = normalizeSkillList(searchTerms)

		matchedActive := matchActiveProjects(jobHaystack, keywords, searchTerms, profile.ActiveProjects)
		if len(matchedActive) > 0 {
			breakdown.MatchedActiveProjects = matchedActive
			reasons = append(reasons, fmt.Sprintf("Relevant active projects: %s.", strings.Join(matchedActive, ", ")))
		}
	}

	// 3. Client spend (0..15)
	if spend := strings.TrimSpace(job.ClientSpent); spend != "" {
		spendUSD := ParseClientSpend(spend)
		switch {
		case spendUSD >= 100_000:
			breakdown.ClientSpend = 15
		case spendUSD >= 10_000:
			breakdown.ClientSpend = 12
		case spendUSD >= 1_000:
			breakdown.ClientSpend = 8
		}
		reasons = append(reasons, fmt.Sprintf("Client spend signal: %s.", spend))
	}

	// 4. Client hires (0..10)
	if job.ClientHires != nil {
		hires := *job.ClientHires
		switch {
		case hires >= 50:
			breakdown.ClientHires = 10
		case hires >= 10:
			breakdown.ClientHires = 8
		case hires >= 5:
			breakdown.ClientHires = 5
		}
		if hires > 0 {
			reasons = append(reasons, fmt.Sprintf("Client hire history: %d hires.", hires))
		}
	}

	// 5. Proposal count (0..10; nil => +8)
	var upperProposals *int
	if job.ProposalsCount != nil {
		v := *job.ProposalsCount
		upperProposals = &v
	} else if strings.TrimSpace(job.Proposals) != "" {
		upperProposals = ParseProposalCount(job.Proposals)
	}
	switch {
	case upperProposals == nil:
		breakdown.ProposalCount = 8
	case *upperProposals <= 15:
		breakdown.ProposalCount = 10
	case *upperProposals <= 20:
		breakdown.ProposalCount = 7
	case *upperProposals <= 50:
		breakdown.ProposalCount = 5
	default:
		breakdown.ProposalCount = 2
	}
	if strings.TrimSpace(job.Proposals) != "" {
		reasons = append(reasons, fmt.Sprintf("Competition signal: %s proposals.", strings.TrimSpace(job.Proposals)))
	}

	// 6. Recency (0..10)
	if posted := strings.TrimSpace(job.Posted); posted != "" {
		ageDays := ParsePostedAge(posted)
		if ageDays != nil {
			switch {
			case *ageDays <= 0:
				breakdown.Recency = 10
			case *ageDays <= 1:
				breakdown.Recency = 8
			case *ageDays <= 3:
				breakdown.Recency = 6
			case *ageDays <= 7:
				breakdown.Recency = 4
			case *ageDays <= 14:
				breakdown.Recency = 2
			}
			reasons = append(reasons, fmt.Sprintf("Recency signal: approximately %d day(s) old.", *ageDays))
		} else {
			reasons = append(reasons, fmt.Sprintf("Recency signal: %s.", posted))
		}
	}

	// 7. Description quality (0..5)
	descLen := len(job.Description)
	switch {
	case descLen > 500:
		breakdown.DescriptionQuality = 5
	case descLen > 200:
		breakdown.DescriptionQuality = 3
	}

	// 8. Authenticated client & connects modifiers
	if job.PaymentVerified != nil {
		if *job.PaymentVerified {
			breakdown.PaymentVerifiedMod = 5
			reasons = append(reasons, "Client payment method is verified (+5).")
		} else {
			breakdown.PaymentVerifiedMod = -5
			reasons = append(reasons, "Client payment method is unverified (-5).")
		}
	}

	if job.ClientHireRate != nil {
		hr := *job.ClientHireRate
		switch {
		case hr >= 50.0:
			breakdown.ClientHireRateMod = 5
			reasons = append(reasons, fmt.Sprintf("High client hire rate: %.0f%% (+5).", hr))
		case hr >= 25.0:
			breakdown.ClientHireRateMod = 2
			reasons = append(reasons, fmt.Sprintf("Moderate client hire rate: %.0f%% (+2).", hr))
		case hr < 10.0:
			breakdown.ClientHireRateMod = -3
			reasons = append(reasons, fmt.Sprintf("Low client hire rate: %.0f%% (-3).", hr))
		}
	}

	if job.ConnectsRequired != nil {
		c := *job.ConnectsRequired
		switch {
		case c <= 8:
			breakdown.ConnectsMod = 2
			reasons = append(reasons, fmt.Sprintf("Low connects cost: %d (+2).", c))
		case c >= 20:
			breakdown.ConnectsMod = -3
			reasons = append(reasons, fmt.Sprintf("High connects cost: %d (-3).", c))
		}
	}

	total := breakdown.RateBudget +
		breakdown.SkillMatch +
		breakdown.ClientSpend +
		breakdown.ClientHires +
		breakdown.ProposalCount +
		breakdown.Recency +
		breakdown.DescriptionQuality +
		breakdown.PaymentVerifiedMod +
		breakdown.ClientHireRateMod +
		breakdown.ConnectsMod

	if total < 0 {
		total = 0
	} else if total > 100 {
		total = 100
	}

	fitLabel := FitLabelForScore(total)
	finalReasons := append([]string{fmt.Sprintf("Overall score is %d/100 (%s).", total, fitLabel)}, reasons...)

	return ScoreResult{
		Score:     total,
		FitLabel:  fitLabel,
		Breakdown: breakdown,
		Reasons:   finalReasons,
	}
}

func matchActiveProjects(jobHaystack string, keywords, searchTerms []string, projects []ActiveProjectRef) []string {
	if jobHaystack == "" && len(searchTerms) == 0 {
		return nil
	}
	matched := make([]string, 0)
	seenLabels := make(map[string]struct{})
	for _, proj := range projects {
		vis := strings.ToLower(strings.TrimSpace(proj.ProposalVisibility))
		if vis == "private" {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(proj.ActivityTier), "archived") {
			continue
		}

		parts := []string{
			strings.Join(proj.TechStack, " "),
			proj.Summary,
			proj.PublicAlias,
		}
		if vis == "public" {
			parts = append(parts, proj.Name)
		}
		projText := strings.TrimSpace(strings.Join(parts, " "))
		if projText == "" {
			continue
		}

		isMatch := false
		for _, term := range searchTerms {
			if KeywordMatches(term, projText) {
				isMatch = true
				break
			}
		}
		if !isMatch && jobHaystack != "" {
			for _, tech := range proj.TechStack {
				if t := strings.TrimSpace(tech); t != "" && KeywordMatches(t, jobHaystack) {
					isMatch = true
					break
				}
			}
		}
		if !isMatch && jobHaystack != "" {
			for _, kw := range keywords {
				if KeywordMatches(kw, projText) && KeywordMatches(kw, jobHaystack) {
					isMatch = true
					break
				}
			}
		}
		if isMatch {
			label := activeProjectDisplayLabel(proj)
			if _, exists := seenLabels[label]; !exists {
				seenLabels[label] = struct{}{}
				matched = append(matched, label)
			}
		}
	}
	return matched
}

func activeProjectDisplayLabel(proj ActiveProjectRef) string {
	vis := strings.ToLower(strings.TrimSpace(proj.ProposalVisibility))
	alias := strings.TrimSpace(proj.PublicAlias)
	if vis == "public" {
		if alias != "" {
			return alias
		}
		if name := strings.TrimSpace(proj.Name); name != "" {
			return name
		}
	}
	if alias != "" {
		return alias
	}
	top3 := make([]string, 0, 3)
	for _, tech := range proj.TechStack {
		if t := strings.TrimSpace(tech); t != "" {
			top3 = append(top3, t)
			if len(top3) == 3 {
				break
			}
		}
	}
	if len(top3) > 0 {
		return "Active client project (" + strings.Join(top3, ", ") + ")"
	}
	return "Active client project"
}
