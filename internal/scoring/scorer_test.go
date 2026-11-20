package scoring

import "testing"

func floatPtr(v float64) *float64 { return &v }
func boolPtr(v bool) *bool       { return &v }

func TestNormalizeJobURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "relative_with_highlight_and_referrer",
			raw:  "/jobs/On-Page-SEO-Expert-Audit-span-class-highlight-WordPress-span-Elementor_~022115332344639171/?referrer_url_path=/nx/search/jobs/",
			want: "https://www.upwork.com/jobs/On-Page-SEO-Expert-Audit-WordPress-Elementor_~022115332344639171/",
		},
		{
			name: "relative_with_highlight_and_amp",
			raw:  "/jobs/Cloudflare-Pages-Developer-Move-Website-Assets-Off-span-class-highlight-WordPress-span-amp-Host-New-Static-Site-Fixed-Price_~022112225892746435112/?referrer_url_path=/nx/search/jobs/",
			want: "https://www.upwork.com/jobs/Cloudflare-Pages-Developer-Move-Website-Assets-Off-WordPress-Host-New-Static-Site-Fixed-Price_~022112225892746435112/",
		},
		{
			name: "already_clean_full_url_with_fragment",
			raw:  "https://www.upwork.com/jobs/Python-Engineer-FastAPI_~022111887415567641941/#details",
			want: "https://www.upwork.com/jobs/Python-Engineer-FastAPI_~022111887415567641941/",
		},
		{
			name: "empty",
			raw:  "   ",
			want: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeJobURL(tc.raw); got != tc.want {
				t.Fatalf("NormalizeJobURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestExtractAndNormalizeUpworkJobID(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"https://www.upwork.com/jobs/Senior-WordPress_~022115332344639171/", "~022115332344639171"},
		{"/jobs/~01abc123/?referrer_url_path=/best-matches/details/~02999", "~01abc123"},
		{"/nx/proposals/job/~01def456/apply/", "~01def456"},
		{"https://example.com/no-id", ""},
		{"", ""},
	}
	for _, tc := range tests {
		if got := ExtractUpworkJobID(tc.raw); got != tc.want {
			t.Errorf("ExtractUpworkJobID(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}

	if got := NormalizeUpworkJobID("022115332344639171"); got != "~022115332344639171" {
		t.Errorf("NormalizeUpworkJobID bare = %q", got)
	}
	if got := NormalizeUpworkJobID("~022115332344639171"); got != "~022115332344639171" {
		t.Errorf("NormalizeUpworkJobID canonical = %q", got)
	}
}

func TestParsePostedAge(t *testing.T) {
	tests := []struct {
		raw  string
		want *int
	}{
		{"Posted 15 minutes ago", intPtr(0)},
		{"Posted 45 mins ago", intPtr(0)},
		{"Just now", intPtr(0)},
		{"Today", intPtr(0)},
		{"Posted 2 hours ago", intPtr(0)},
		{"Posted 23 hours ago", intPtr(0)},
		{"Posted 25 hours ago", intPtr(1)},
		{"Yesterday", intPtr(1)},
		{"Posted 2 days ago", intPtr(2)},
		{"Posted 1 week ago", intPtr(7)},
		{"Posted 2 weeks ago", intPtr(14)},
		{"Posted 1 month ago", intPtr(30)},
		{"", nil},
		{"unknown", nil},
	}
	for _, tc := range tests {
		got := ParsePostedAge(tc.raw)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("ParsePostedAge(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestParseProposalCount(t *testing.T) {
	tests := []struct {
		raw  string
		want *int
	}{
		{"Less than 5", intPtr(4)},
		{"Proposals: Less than 5", intPtr(4)},
		{"5 to 10", intPtr(10)},
		{"10 to 15", intPtr(15)},
		{"15 to 20", intPtr(20)},
		{"20 to 50", intPtr(50)},
		{"50+", intPtr(999)},
		{"12", intPtr(12)},
		{"", nil},
	}
	for _, tc := range tests {
		got := ParseProposalCount(tc.raw)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("ParseProposalCount(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestParseBudgetAmount(t *testing.T) {
	tests := []struct {
		raw  string
		want *float64
	}{
		{"$2,500", floatPtr(2500.0)},
		{"$150.00", floatPtr(150.0)},
		{"$0", floatPtr(0.0)},
		{"$0.00", floatPtr(0.0)},
		{"Fixed price", nil},
		{"", nil},
		{"Not specified", nil},
	}
	for _, tc := range tests {
		got := ParseBudgetAmount(tc.raw)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("ParseBudgetAmount(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestParseClientSpend(t *testing.T) {
	tests := []struct {
		raw  string
		want float64
	}{
		{"$1.9K", 1900},
		{"$580K", 580000},
		{"$1M", 1000000},
		{"10k", 10000},
		{"$25.5K total spent", 25500},
		{"$500+", 500},
		{"$1,250", 1250},
		{"$500 more", 500},
		{"$200k", 200000},
		{"$300 million", 300},
		{"$0", 0},
		{"", 0},
	}
	for _, tc := range tests {
		if got := ParseClientSpend(tc.raw); got != tc.want {
			t.Errorf("ParseClientSpend(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestKeywordMatches(t *testing.T) {
	tests := []struct {
		kw   string
		text string
		want bool
	}{
		{"go", "Go backend developer needed", true},
		{"go", "Looking for Golang or Go engineers", true},
		{"go", "Django and PostgreSQL developer", false},
		{"go", "Good communication skills and Google Cloud experience", false},
		{"ai", "Building an AI agent", true},
		{"ai", "Send email and maintain codebase", false},
		{"ai", "Tailwind CSS styling", false},
		{"c#", "Senior C# backend engineer", true},
		{"c#", "C#/ASP.NET developer", true},
		{"c#", "C#8 language features", false},
		{".net", "Experienced in .NET 8 and C#", true},
		{".net", "ASP.NET Core developer", true},
		{".net", "Computer networking technician", false},
		{"ci/cd", "Setup CI/CD pipelines", true},
		{"next.js", "Build frontend with Next.js", true},
	}
	for _, tc := range tests {
		if got := KeywordMatches(tc.kw, tc.text); got != tc.want {
			t.Errorf("KeywordMatches(%q, %q) = %v, want %v", tc.kw, tc.text, got, tc.want)
		}
	}
}

func TestScoreJobParityWithUpworkScraperFS(t *testing.T) {
	tests := []struct {
		name string
		job  JobInput
		want int
	}{
		{"proposals_less_than_5", JobInput{Proposals: "Less than 5"}, 10},
		{"proposals_10_to_15", JobInput{Proposals: "10 to 15"}, 10},
		{"proposals_15_to_20", JobInput{Proposals: "15 to 20"}, 7},
		{"proposals_20_to_50", JobInput{Proposals: "20 to 50"}, 5},
		{"proposals_50_plus", JobInput{Proposals: "50+"}, 2},
		{"budget_2500", JobInput{Budget: "$2,500"}, 28},
		{"budget_1000", JobInput{Budget: "$1,000"}, 28},
		{"budget_750", JobInput{Budget: "$750"}, 23},
		{"budget_500", JobInput{Budget: "$500"}, 23},
		{"budget_300", JobInput{Budget: "$300"}, 18},
		{"budget_200", JobInput{Budget: "$200"}, 18},
		{"budget_100", JobInput{Budget: "$100"}, 13},
		{"budget_50", JobInput{Budget: "$50"}, 13},
		{"budget_1000_less_than_5", JobInput{Budget: "$1,000", Proposals: "Less than 5"}, 30},
		{"budget_500_15_to_20", JobInput{Budget: "$500", Proposals: "15 to 20"}, 22},
		{"budget_200_50_plus", JobInput{Budget: "$200", Proposals: "50+"}, 12},
		{"hourly_80", JobInput{HourlyRate: "$80.00/hr"}, 33},
		{"hourly_100", JobInput{HourlyRate: "$100.00/hr"}, 28},
		{"hourly_30", JobInput{HourlyRate: "$30.00/hr"}, 18},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := ScoreJob(tc.job, nil)
			if res.Score != tc.want {
				t.Fatalf("ScoreJob(%+v) = %d (breakdown=%+v), want %d", tc.job, res.Score, res.Breakdown, tc.want)
			}
		})
	}
}

func TestScoreJobProfileAndModifiers(t *testing.T) {
	profile := &ScoringProfile{
		Skills: []string{"Rust", "WebAssembly"},
		PortfolioItems: []PortfolioRef{
			{Title: "WASM Engine", Description: "Built high-throughput Rust WebAssembly parser"},
		},
	}
	res := ScoreJob(JobInput{
		Title:            "Rust WASM Runtime",
		Description:      stringsRepeat("Rust and WebAssembly systems work. ", 25),
		HourlyRate:       "$75.00/hr",
		Skills:           []string{"Rust", "WebAssembly"},
		Posted:           "Posted 1 hour ago",
		Proposals:        "Less than 5",
		ClientSpent:      "$150K",
		ClientHires:      intPtr(60),
		PaymentVerified:  boolPtr(true),
		ClientHireRate:   floatPtr(75.0),
		ConnectsRequired: intPtr(6),
	}, profile)

	if res.Breakdown.SkillMatch != 13 { // 2 skills*5 + 1 portfolio*3 = 13
		t.Fatalf("expected SkillMatch=13, got %d", res.Breakdown.SkillMatch)
	}
	if res.Breakdown.PaymentVerifiedMod != 5 || res.Breakdown.ClientHireRateMod != 5 || res.Breakdown.ConnectsMod != 2 {
		t.Fatalf("unexpected modifiers: %+v", res.Breakdown)
	}
	if res.Score != 100 || res.FitLabel != "hot" {
		t.Fatalf("expected clamped score 100 'hot', got %d %q", res.Score, res.FitLabel)
	}

	// Negative modifiers floor at 0
	neg := ScoreJob(JobInput{
		Proposals:        "50+",
		PaymentVerified:  boolPtr(false),
		ClientHireRate:   floatPtr(5.0),
		ConnectsRequired: intPtr(24),
	}, nil)
	if neg.Score != 0 || neg.FitLabel != "skip" {
		t.Fatalf("expected score 0 'skip', got %d %q", neg.Score, neg.FitLabel)
	}
}

func TestFilterCandidatesTwoStageAndBudgetZero(t *testing.T) {
	jobs := []JobInput{
		{Title: "Go API with unknown budget", Description: "Golang microservice", Budget: "", Proposals: ""},
		{Title: "Go API $1,200", Description: "Golang backend", Budget: "$1,200", Proposals: "Less than 5"},
		{Title: "Go API $100", Description: "Golang script", Budget: "$100", Proposals: "Less than 5"},
		{Title: "Free task $0", Description: "Zero budget", Budget: "$0", Proposals: "Less than 5"},
	}

	// StagePreEnrichment keeps unknown budget and unknown proposals when BudgetMin=500
	pre := FilterCandidates(jobs, FilterConfig{
		RequiredKeywords: []string{"go"},
		MaxProposals:     intPtr(10),
		BudgetMin:        floatPtr(500),
	}, StagePreEnrichment, nil)
	if len(pre) != 2 {
		t.Fatalf("expected 2 pre-enrichment candidates (unknown budget + $1,200), got %d: %+v", len(pre), pre)
	}

	// StagePostEnrichment drops unknown budget and unknown proposals
	post := FilterCandidates(jobs, FilterConfig{
		RequiredKeywords: []string{"go"},
		MaxProposals:     intPtr(10),
		BudgetMin:        floatPtr(500),
	}, StagePostEnrichment, nil)
	if len(post) != 1 || post[0].Title != "Go API $1,200" {
		t.Fatalf("expected only 'Go API $1,200' post-enrichment, got %+v", post)
	}

	// BudgetMax = &0.0 must enforce <= $0 (not treat 0 as +Inf!)
	zeroMax := FilterCandidates(jobs, FilterConfig{
		BudgetMax: floatPtr(0.0),
	}, StagePostEnrichment, nil)
	if len(zeroMax) != 1 || zeroMax[0].Title != "Free task $0" {
		t.Fatalf("expected only '$0' job when BudgetMax=0, got %+v", zeroMax)
	}

	// StagePostEnrichment with BudgetMin/BudgetMax must NOT drop hourly jobs, while still dropping unknown-budget fixed jobs
	mixedJobs := []JobInput{
		{Title: "Hourly Go Engineer", Description: "Go + Postgres", Budget: "", HourlyRate: "$60.00 - $80.00/hr"},
		{Title: "Unknown Fixed Go Job", Description: "Go + Postgres", Budget: "", HourlyRate: ""},
		{Title: "Fixed Label Only", Description: "Go + Postgres", Budget: "", HourlyRate: "Fixed price"},
		{Title: "Fixed $80 Job", Description: "Go + Postgres", Budget: "$80", HourlyRate: ""},
	}
	hourlyRetained := FilterCandidates(mixedJobs, FilterConfig{
		BudgetMax: floatPtr(100),
	}, StagePostEnrichment, nil)
	if len(hourlyRetained) != 2 || hourlyRetained[0].Title != "Hourly Go Engineer" || hourlyRetained[1].Title != "Fixed $80 Job" {
		t.Fatalf("expected hourly job + $80 fixed job retained, got %+v", hourlyRetained)
	}
}

func stringsRepeat(s string, count int) string {
	out := ""
	for i := 0; i < count; i++ {
		out += s
	}
	return out
}
