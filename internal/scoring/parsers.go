package scoring

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	reHighlightSlug = regexp.MustCompile(`span-class-highlight-([A-Za-z0-9_-]+?)-span`)
	reMultiHyphen   = regexp.MustCompile(`-{2,}`)
	reUpworkJobID   = regexp.MustCompile(`~[0-9a-zA-Z]+`)
	reFullJobID     = regexp.MustCompile(`^~[0-9a-zA-Z]+$`)
	reBareJobID     = regexp.MustCompile(`^[0-9a-zA-Z]{8,}$`)

	reAgeMinSec = regexp.MustCompile(`(\d+)\s*(?:minute|min|second|sec)`)
	reAgeHour   = regexp.MustCompile(`(\d+)\s*hour`)
	reAgeDay    = regexp.MustCompile(`(\d+)\s*day`)
	reAgeWeek   = regexp.MustCompile(`(\d+)\s*week`)
	reAgeMonth  = regexp.MustCompile(`(\d+)\s*month`)
	reAgeYear   = regexp.MustCompile(`(\d+)\s*year`)

	reProposalsPrefix = regexp.MustCompile(`(?i)^proposals\s*:\s*`)
	reProposalsLess   = regexp.MustCompile(`(?:less\s+than|<)\s*(\d+)`)
	reProposalsRange  = regexp.MustCompile(`(\d+)\s*(?:to|-|\x{2013})\s*(\d+)`)
	reProposalsPlus   = regexp.MustCompile(`(\d+)\s*\+|(?:more\s+than|over|>)\s*(\d+)`)
	reProposalsExact  = regexp.MustCompile(`^(\d+)(?:\s+proposals?)?$`)

	reDollarAmount = regexp.MustCompile(`\$([0-9]+(?:\.[0-9]+)?)`)
	reHourlyRange  = regexp.MustCompile(`(?i)\$([0-9]+(?:\.[0-9]+)?)\s*(?:-|–|\x{2014}|to)\s*\$?([0-9]+(?:\.[0-9]+)?)`)
	reClientSpend  = regexp.MustCompile(`\$?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*([KM])(?:[^A-Z]|$))?`)
)

func intPtr(v int) *int {
	return &v
}

// NormalizeJobURL sanitizes Upwork job URLs by prepending the base host for relative
// paths, stripping query/fragment params, removing leaked search-highlight span tokens,
// and collapsing duplicate hyphens in the slug prefix.
func NormalizeJobURL(raw string) string {
	u := strings.TrimSpace(raw)
	if u == "" {
		return ""
	}
	if strings.HasPrefix(u, "/") {
		u = "https://www.upwork.com" + u
	}
	if idx := strings.IndexByte(u, '?'); idx >= 0 {
		u = u[:idx]
	}
	if idx := strings.IndexByte(u, '#'); idx >= 0 {
		u = u[:idx]
	}

	u = reHighlightSlug.ReplaceAllString(u, "$1")
	u = strings.ReplaceAll(u, "-amp-", "-")

	if idx := strings.Index(u, "_~"); idx >= 0 {
		prefix := reMultiHyphen.ReplaceAllString(u[:idx], "-")
		u = prefix + u[idx:]
	}
	return u
}

// ExtractUpworkJobID extracts the canonical ~<alphanum> job ID from a URL or path,
// stripping query strings and fragments first so referrer_url_path tokens are ignored.
func ExtractUpworkJobID(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if idx := strings.IndexByte(s, '?'); idx >= 0 {
		s = s[:idx]
	}
	if idx := strings.IndexByte(s, '#'); idx >= 0 {
		s = s[:idx]
	}
	return reUpworkJobID.FindString(s)
}

// NormalizeUpworkJobID normalizes either a ~<id>, a bare alphanumeric ID (8+ chars),
// or a URL/path containing ~<id> into canonical ~<id> form.
func NormalizeUpworkJobID(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if reFullJobID.MatchString(s) {
		return s
	}
	if reBareJobID.MatchString(s) {
		return "~" + s
	}
	return ExtractUpworkJobID(s)
}

// ParsePostedAge parses a human-readable Upwork posted string into approximate days old.
func ParsePostedAge(posted string) *int {
	text := strings.TrimSpace(strings.ReplaceAll(strings.ToLower(posted), "posted ", ""))
	if text == "" {
		return nil
	}

	switch text {
	case "just now", "today", "moments ago", "a few seconds ago", "a minute ago", "an hour ago":
		return intPtr(0)
	case "yesterday", "a day ago":
		return intPtr(1)
	case "a week ago":
		return intPtr(7)
	case "a month ago":
		return intPtr(30)
	case "a year ago":
		return intPtr(365)
	}

	if reAgeMinSec.MatchString(text) {
		return intPtr(0)
	}
	if m := reAgeHour.FindStringSubmatch(text); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n / 24)
		}
	}
	if m := reAgeDay.FindStringSubmatch(text); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n)
		}
	}
	if m := reAgeWeek.FindStringSubmatch(text); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n * 7)
		}
	}
	if m := reAgeMonth.FindStringSubmatch(text); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n * 30)
		}
	}
	if m := reAgeYear.FindStringSubmatch(text); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n * 365)
		}
	}
	return nil
}

// ParseProposalCount parses an Upwork proposal tier string into its upper-bound integer count.
func ParseProposalCount(proposals string) *int {
	text := strings.TrimSpace(proposals)
	if text == "" {
		return nil
	}
	text = strings.TrimSpace(reProposalsPrefix.ReplaceAllString(text, ""))
	if text == "" {
		return nil
	}
	lower := strings.ToLower(text)

	if m := reProposalsLess.FindStringSubmatch(lower); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			if n <= 0 {
				return intPtr(0)
			}
			return intPtr(n - 1)
		}
	}
	if m := reProposalsRange.FindStringSubmatch(lower); len(m) == 3 {
		n2, err := strconv.Atoi(m[2])
		if err == nil {
			return intPtr(n2)
		}
	}
	if m := reProposalsPlus.FindStringSubmatch(lower); len(m) == 3 {
		rawNum := m[1]
		if rawNum == "" {
			rawNum = m[2]
		}
		n, err := strconv.Atoi(rawNum)
		if err == nil {
			if n+1 > 999 {
				return intPtr(n + 1)
			}
			return intPtr(999)
		}
	}
	if m := reProposalsExact.FindStringSubmatch(lower); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			return intPtr(n)
		}
	}
	return nil
}

// JobMeetsProposalThreshold checks whether a job's proposal count is within maxProposals.
func JobMeetsProposalThreshold(proposals string, maxProposals *int, includeUnknown bool) bool {
	if maxProposals == nil {
		return true
	}
	upper := ParseProposalCount(proposals)
	if upper == nil {
		return includeUnknown
	}
	return *upper <= *maxProposals
}

// ParseBudgetAmount parses a numeric dollar amount from a budget string like "$1,500.00".
// Returns nil when empty or when no explicit "$" amount is present; returns &0.0 only on explicit "$0".
func ParseBudgetAmount(budget string) *float64 {
	trimmed := strings.TrimSpace(budget)
	if trimmed == "" {
		return nil
	}
	cleaned := strings.ReplaceAll(trimmed, ",", "")
	m := reDollarAmount.FindStringSubmatch(cleaned)
	if len(m) != 2 {
		return nil
	}
	val, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil
	}
	return &val
}

// ParseHourlyRateRange parses an hourly rate string like "$40.00 - $80.00/hr" or "$50/hr"
// into normalized (min, max) dollar bounds. Returns (nil, nil) for empty, non-rate, or fixed-price strings.
func ParseHourlyRateRange(raw string) (*float64, *float64) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.Contains(strings.ToLower(trimmed), "fixed") {
		return nil, nil
	}
	cleaned := strings.ReplaceAll(trimmed, ",", "")
	if m := reHourlyRange.FindStringSubmatch(cleaned); len(m) == 3 {
		v1, err1 := strconv.ParseFloat(m[1], 64)
		v2, err2 := strconv.ParseFloat(m[2], 64)
		if err1 == nil && err2 == nil && !math.IsNaN(v1) && !math.IsNaN(v2) {
			if v1 > v2 {
				v1, v2 = v2, v1
			}
			return &v1, &v2
		}
	}

	matches := reDollarAmount.FindAllStringSubmatch(cleaned, -1)
	if len(matches) == 0 {
		return nil, nil
	}
	var minVal, maxVal float64
	found := false
	for _, m := range matches {
		if len(m) != 2 {
			continue
		}
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil || math.IsNaN(v) {
			continue
		}
		if !found {
			minVal, maxVal = v, v
			found = true
			continue
		}
		if v < minVal {
			minVal = v
		}
		if v > maxVal {
			maxVal = v
		}
	}
	if !found {
		return nil, nil
	}
	return &minVal, &maxVal
}

// ParseClientSpend parses a client spend string like "$1.9K", "10k", "$1M", or "$25.5K total spent"
// into a float64 USD amount. Returns 0 when empty or unparseable.
func ParseClientSpend(spend string) float64 {
	s := strings.ToUpper(strings.TrimSpace(spend))
	if s == "" {
		return 0
	}
	s = strings.ReplaceAll(s, ",", "")
	m := reClientSpend.FindStringSubmatch(s)
	if len(m) < 2 {
		return 0
	}
	val, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	if len(m) >= 3 {
		switch m[2] {
		case "M":
			return val * 1_000_000
		case "K":
			return val * 1_000
		}
	}
	return val
}

func isASCIILowerAlnum(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
}

func isASCIILowerAlnumOrUnderscore(b byte) bool {
	return isASCIILowerAlnum(b) || b == '_'
}

func isRuneAlnum(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// KeywordMatches checks if keyword matches within text using RE2-safe boundary semantics
// equivalent to upwork-scraper-fs's Python lookaround matcher.
func KeywordMatches(keyword, text string) bool {
	kw := strings.ToLower(strings.TrimSpace(keyword))
	t := strings.ToLower(text)
	if kw == "" || t == "" {
		return false
	}

	firstRune, _ := utf8.DecodeRuneInString(kw)
	lastRune, _ := utf8.DecodeLastRuneInString(kw)
	startsDot := strings.HasPrefix(kw, ".")
	firstAlnum := isRuneAlnum(firstRune)
	lastAlnum := isRuneAlnum(lastRune)

	offset := 0
	for offset <= len(t)-len(kw) {
		idx := strings.Index(t[offset:], kw)
		if idx < 0 {
			return false
		}
		start := offset + idx
		end := start + len(kw)

		leftOK := startsDot || start == 0
		if !leftOK {
			prev := t[start-1]
			if firstAlnum {
				leftOK = !isASCIILowerAlnum(prev)
			} else {
				leftOK = !isASCIILowerAlnumOrUnderscore(prev)
			}
		}

		rightOK := end == len(t)
		if !rightOK {
			next := t[end]
			if startsDot || lastAlnum {
				rightOK = !isASCIILowerAlnum(next)
			} else {
				rightOK = !isASCIILowerAlnumOrUnderscore(next)
			}
		}

		if leftOK && rightOK {
			return true
		}

		_, w := utf8.DecodeRuneInString(t[start:])
		if w <= 0 {
			w = 1
		}
		offset = start + w
	}
	return false
}
