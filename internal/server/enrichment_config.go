package server

import (
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	EnrichmentModeFull       = "full"
	EnrichmentModeAIOnly     = "ai_only"
	EnrichmentModeDetailOnly = "detail_only"

	EnrichmentEffortLow    = "low"
	EnrichmentEffortMedium = "medium"
	EnrichmentEffortHigh   = "high"
	EnrichmentEffortXHigh  = "xhigh"

	DefaultEnrichmentMaxBatchSize       = 25
	MinEnrichmentMaxBatchSize           = 1
	MaxEnrichmentMaxBatchSize           = 100
	DefaultEnrichmentMode               = EnrichmentModeFull
	DefaultEnrichmentForce              = false
	DefaultEnrichmentSkipDetailIfPresent = true
	DefaultEnrichmentRequireDetails     = false
	DefaultEnrichmentMaxConcurrency     = 2
	MinEnrichmentMaxConcurrency         = 1
	MaxEnrichmentMaxConcurrency         = 4
	DefaultEnrichmentConfirmThreshold   = 5
	MinEnrichmentConfirmThreshold       = 0
	MaxEnrichmentConfirmThreshold       = 100
	DefaultEnrichmentWaitTimeoutSeconds = 60
	MinEnrichmentWaitTimeoutSeconds     = 5
	MaxEnrichmentWaitTimeoutSeconds     = 180
	DefaultWebUIEnabled                 = true
	DefaultWebSessionTTLMinutes         = 720
	MinWebSessionTTLMinutes             = 5
	MaxWebSessionTTLMinutes             = 10080
)

// EnrichmentConfig holds resolved, clamped defaults and guardrails for async batch
// job enrichment and the standalone local web dashboard.
type EnrichmentConfig struct {
	MaxBatchSize         int    `json:"max_batch_size"`
	DefaultMode          string `json:"default_mode"`
	DefaultForce         bool   `json:"default_force"`
	SkipDetailIfPresent  bool   `json:"skip_detail_if_present"`
	RequireDetails       bool   `json:"require_details"`
	MaxConcurrency       int    `json:"max_concurrency"`
	DefaultModel         string `json:"default_model"`
	DefaultEffort        string `json:"default_effort"`
	ConfirmThreshold     int    `json:"confirm_threshold"`
	WaitTimeoutSeconds   int    `json:"wait_timeout_seconds"`
	WebUIEnabled         bool   `json:"web_ui_enabled"`
	WebSessionTTLMinutes int    `json:"web_session_ttl_minutes"`
}

// ResolveEnrichmentConfig reads ENRICHMENT_* and WEB_* environment variables,
// normalizing enums and clamping numeric bounds to safe guardrails.
func ResolveEnrichmentConfig() EnrichmentConfig {
	defaultMode := DefaultEnrichmentMode
	if parsed, ok := ParseEnrichmentMode(os.Getenv("ENRICHMENT_DEFAULT_MODE")); ok {
		defaultMode = parsed
	}

	defaultEffort := ""
	if parsed, ok := ParseEnrichmentEffort(os.Getenv("ENRICHMENT_DEFAULT_EFFORT")); ok {
		defaultEffort = parsed
	}

	return EnrichmentConfig{
		MaxBatchSize:         parseClampedEnvInt("ENRICHMENT_MAX_BATCH_SIZE", DefaultEnrichmentMaxBatchSize, MinEnrichmentMaxBatchSize, MaxEnrichmentMaxBatchSize),
		DefaultMode:          defaultMode,
		DefaultForce:         parseEnvBool("ENRICHMENT_DEFAULT_FORCE", DefaultEnrichmentForce),
		SkipDetailIfPresent:  parseEnvBool("ENRICHMENT_SKIP_DETAIL_IF_PRESENT", DefaultEnrichmentSkipDetailIfPresent),
		RequireDetails:       parseEnvBool("ENRICHMENT_REQUIRE_DETAILS", DefaultEnrichmentRequireDetails),
		MaxConcurrency:       parseClampedEnvInt("ENRICHMENT_MAX_CONCURRENCY", DefaultEnrichmentMaxConcurrency, MinEnrichmentMaxConcurrency, MaxEnrichmentMaxConcurrency),
		DefaultModel:         strings.TrimSpace(os.Getenv("ENRICHMENT_DEFAULT_MODEL")),
		DefaultEffort:        defaultEffort,
		ConfirmThreshold:     parseClampedEnvInt("ENRICHMENT_CONFIRM_THRESHOLD", DefaultEnrichmentConfirmThreshold, MinEnrichmentConfirmThreshold, MaxEnrichmentConfirmThreshold),
		WaitTimeoutSeconds:   parseClampedEnvInt("ENRICHMENT_WAIT_TIMEOUT_SECONDS", DefaultEnrichmentWaitTimeoutSeconds, MinEnrichmentWaitTimeoutSeconds, MaxEnrichmentWaitTimeoutSeconds),
		WebUIEnabled:         parseEnvBool("WEB_UI_ENABLED", DefaultWebUIEnabled),
		WebSessionTTLMinutes: parseClampedEnvInt("WEB_SESSION_TTL_MINUTES", DefaultWebSessionTTLMinutes, MinWebSessionTTLMinutes, MaxWebSessionTTLMinutes),
	}
}

// ParseEnrichmentMode trims and normalizes an enrichment mode string.
func ParseEnrichmentMode(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case EnrichmentModeFull:
		return EnrichmentModeFull, true
	case EnrichmentModeAIOnly:
		return EnrichmentModeAIOnly, true
	case EnrichmentModeDetailOnly:
		return EnrichmentModeDetailOnly, true
	default:
		return "", false
	}
}

// ParseEnrichmentEffort trims and normalizes an AGY reasoning effort level.
func ParseEnrichmentEffort(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case EnrichmentEffortLow:
		return EnrichmentEffortLow, true
	case EnrichmentEffortMedium:
		return EnrichmentEffortMedium, true
	case EnrichmentEffortHigh:
		return EnrichmentEffortHigh, true
	case EnrichmentEffortXHigh:
		return EnrichmentEffortXHigh, true
	default:
		return "", false
	}
}

// EffectiveMaxBatchSize returns a zero-value-safe clamped max batch size.
func (c EnrichmentConfig) EffectiveMaxBatchSize() int {
	if c.MaxBatchSize <= 0 {
		return DefaultEnrichmentMaxBatchSize
	}
	return clampInt(c.MaxBatchSize, MinEnrichmentMaxBatchSize, MaxEnrichmentMaxBatchSize)
}

// EffectiveMaxConcurrency returns a zero-value-safe clamped max concurrency.
func (c EnrichmentConfig) EffectiveMaxConcurrency() int {
	if c.MaxConcurrency <= 0 {
		return DefaultEnrichmentMaxConcurrency
	}
	return clampInt(c.MaxConcurrency, MinEnrichmentMaxConcurrency, MaxEnrichmentMaxConcurrency)
}

// EffectiveMode returns a zero-value-safe normalized enrichment mode.
func (c EnrichmentConfig) EffectiveMode() string {
	if mode, ok := ParseEnrichmentMode(c.DefaultMode); ok {
		return mode
	}
	return DefaultEnrichmentMode
}

// WaitTimeout returns the zero-value-safe clamped wait timeout duration.
func (c EnrichmentConfig) WaitTimeout() time.Duration {
	secs := c.WaitTimeoutSeconds
	if secs <= 0 {
		secs = DefaultEnrichmentWaitTimeoutSeconds
	} else {
		secs = clampInt(secs, MinEnrichmentWaitTimeoutSeconds, MaxEnrichmentWaitTimeoutSeconds)
	}
	return time.Duration(secs) * time.Second
}

// WebSessionTTL returns the zero-value-safe clamped web dashboard session TTL.
func (c EnrichmentConfig) WebSessionTTL() time.Duration {
	mins := c.WebSessionTTLMinutes
	if mins <= 0 {
		mins = DefaultWebSessionTTLMinutes
	} else {
		mins = clampInt(mins, MinWebSessionTTLMinutes, MaxWebSessionTTLMinutes)
	}
	return time.Duration(mins) * time.Minute
}

func parseClampedEnvInt(key string, defVal, minVal, maxVal int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defVal
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return defVal
	}
	return clampInt(v, minVal, maxVal)
}

func clampInt(v, minVal, maxVal int) int {
	if v < minVal {
		return minVal
	}
	if v > maxVal {
		return maxVal
	}
	return v
}

func parseEnvBool(key string, defVal bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch raw {
	case "1", "true", "t", "yes", "y", "on":
		return true
	case "0", "false", "f", "no", "n", "off":
		return false
	default:
		return defVal
	}
}
