package server

import (
	"encoding/json"
	"testing"
	"time"
)

func clearEnrichmentEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"ENRICHMENT_MAX_BATCH_SIZE",
		"ENRICHMENT_DEFAULT_MODE",
		"ENRICHMENT_DEFAULT_FORCE",
		"ENRICHMENT_SKIP_DETAIL_IF_PRESENT",
		"ENRICHMENT_REQUIRE_DETAILS",
		"ENRICHMENT_MAX_CONCURRENCY",
		"ENRICHMENT_DEFAULT_MODEL",
		"ENRICHMENT_DEFAULT_EFFORT",
		"ENRICHMENT_CONFIRM_THRESHOLD",
		"ENRICHMENT_WAIT_TIMEOUT_SECONDS",
		"WEB_UI_ENABLED",
		"WEB_SESSION_TTL_MINUTES",
	} {
		t.Setenv(key, "")
	}
}

func TestResolveEnrichmentConfig_Defaults(t *testing.T) {
	clearEnrichmentEnv(t)

	cfg := ResolveEnrichmentConfig()
	if cfg.MaxBatchSize != 25 {
		t.Errorf("MaxBatchSize = %d, want 25", cfg.MaxBatchSize)
	}
	if cfg.DefaultMode != "full" {
		t.Errorf("DefaultMode = %q, want 'full'", cfg.DefaultMode)
	}
	if cfg.DefaultForce {
		t.Errorf("DefaultForce = true, want false")
	}
	if !cfg.SkipDetailIfPresent {
		t.Errorf("SkipDetailIfPresent = false, want true")
	}
	if cfg.RequireDetails {
		t.Errorf("RequireDetails = true, want false")
	}
	if cfg.MaxConcurrency != 2 {
		t.Errorf("MaxConcurrency = %d, want 2", cfg.MaxConcurrency)
	}
	if cfg.DefaultModel != "" {
		t.Errorf("DefaultModel = %q, want ''", cfg.DefaultModel)
	}
	if cfg.DefaultEffort != "" {
		t.Errorf("DefaultEffort = %q, want ''", cfg.DefaultEffort)
	}
	if cfg.ConfirmThreshold != 5 {
		t.Errorf("ConfirmThreshold = %d, want 5", cfg.ConfirmThreshold)
	}
	if cfg.WaitTimeoutSeconds != 60 {
		t.Errorf("WaitTimeoutSeconds = %d, want 60", cfg.WaitTimeoutSeconds)
	}
	if !cfg.WebUIEnabled {
		t.Errorf("WebUIEnabled = false, want true")
	}
	if cfg.WebSessionTTLMinutes != 720 {
		t.Errorf("WebSessionTTLMinutes = %d, want 720", cfg.WebSessionTTLMinutes)
	}
}

func TestResolveEnrichmentConfig_ValidOverridesAndJSONTags(t *testing.T) {
	clearEnrichmentEnv(t)
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "50")
	t.Setenv("ENRICHMENT_DEFAULT_MODE", "ai_only")
	t.Setenv("ENRICHMENT_DEFAULT_FORCE", "true")
	t.Setenv("ENRICHMENT_SKIP_DETAIL_IF_PRESENT", "false")
	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "true")
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "4")
	t.Setenv("ENRICHMENT_DEFAULT_MODEL", "gemini-4-neon")
	t.Setenv("ENRICHMENT_DEFAULT_EFFORT", "low")
	t.Setenv("ENRICHMENT_CONFIRM_THRESHOLD", "0")
	t.Setenv("ENRICHMENT_WAIT_TIMEOUT_SECONDS", "120")
	t.Setenv("WEB_UI_ENABLED", "false")
	t.Setenv("WEB_SESSION_TTL_MINUTES", "1440")

	cfg := ResolveEnrichmentConfig()
	if cfg.MaxBatchSize != 50 || cfg.DefaultMode != "ai_only" || !cfg.DefaultForce ||
		cfg.SkipDetailIfPresent || !cfg.RequireDetails || cfg.MaxConcurrency != 4 ||
		cfg.DefaultModel != "gemini-4-neon" || cfg.DefaultEffort != "low" ||
		cfg.ConfirmThreshold != 0 || cfg.WaitTimeoutSeconds != 120 ||
		cfg.WebUIEnabled || cfg.WebSessionTTLMinutes != 1440 {
		t.Fatalf("unexpected resolved overrides: %+v", cfg)
	}

	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal config map: %v", err)
	}

	wantKeys := []string{
		"max_batch_size",
		"default_mode",
		"default_force",
		"skip_detail_if_present",
		"require_details",
		"max_concurrency",
		"default_model",
		"default_effort",
		"confirm_threshold",
		"wait_timeout_seconds",
		"web_ui_enabled",
		"web_session_ttl_minutes",
	}
	for _, k := range wantKeys {
		if _, ok := m[k]; !ok {
			t.Errorf("expected JSON key %q to always be present (no omitempty), got %s", k, string(raw))
		}
	}

	// Also verify zero/false/empty defaults serialize all 12 keys.
	clearEnrichmentEnv(t)
	rawDef, err := json.Marshal(ResolveEnrichmentConfig())
	if err != nil {
		t.Fatalf("marshal default config: %v", err)
	}
	var mDef map[string]any
	if err := json.Unmarshal(rawDef, &mDef); err != nil {
		t.Fatalf("unmarshal default config map: %v", err)
	}
	for _, k := range wantKeys {
		if _, ok := mDef[k]; !ok {
			t.Errorf("expected default JSON key %q to be present, got %s", k, string(rawDef))
		}
	}
}

func TestResolveEnrichmentConfig_ClampingBounds(t *testing.T) {
	tests := []struct {
		name   string
		envKey string
		envVal string
		get    func(EnrichmentConfig) int
		want   int
	}{
		{"batch min", "ENRICHMENT_MAX_BATCH_SIZE", "1", func(c EnrichmentConfig) int { return c.MaxBatchSize }, 1},
		{"batch max", "ENRICHMENT_MAX_BATCH_SIZE", "100", func(c EnrichmentConfig) int { return c.MaxBatchSize }, 100},
		{"batch below min zero", "ENRICHMENT_MAX_BATCH_SIZE", "0", func(c EnrichmentConfig) int { return c.MaxBatchSize }, 1},
		{"batch below min neg", "ENRICHMENT_MAX_BATCH_SIZE", "-5", func(c EnrichmentConfig) int { return c.MaxBatchSize }, 1},
		{"batch above max", "ENRICHMENT_MAX_BATCH_SIZE", "999", func(c EnrichmentConfig) int { return c.MaxBatchSize }, 100},

		{"concurrency min", "ENRICHMENT_MAX_CONCURRENCY", "1", func(c EnrichmentConfig) int { return c.MaxConcurrency }, 1},
		{"concurrency max", "ENRICHMENT_MAX_CONCURRENCY", "4", func(c EnrichmentConfig) int { return c.MaxConcurrency }, 4},
		{"concurrency below min", "ENRICHMENT_MAX_CONCURRENCY", "-2", func(c EnrichmentConfig) int { return c.MaxConcurrency }, 1},
		{"concurrency above max", "ENRICHMENT_MAX_CONCURRENCY", "10", func(c EnrichmentConfig) int { return c.MaxConcurrency }, 4},

		{"confirm min", "ENRICHMENT_CONFIRM_THRESHOLD", "0", func(c EnrichmentConfig) int { return c.ConfirmThreshold }, 0},
		{"confirm max", "ENRICHMENT_CONFIRM_THRESHOLD", "100", func(c EnrichmentConfig) int { return c.ConfirmThreshold }, 100},
		{"confirm below min", "ENRICHMENT_CONFIRM_THRESHOLD", "-1", func(c EnrichmentConfig) int { return c.ConfirmThreshold }, 0},
		{"confirm above max", "ENRICHMENT_CONFIRM_THRESHOLD", "101", func(c EnrichmentConfig) int { return c.ConfirmThreshold }, 100},

		{"wait min", "ENRICHMENT_WAIT_TIMEOUT_SECONDS", "5", func(c EnrichmentConfig) int { return c.WaitTimeoutSeconds }, 5},
		{"wait max", "ENRICHMENT_WAIT_TIMEOUT_SECONDS", "180", func(c EnrichmentConfig) int { return c.WaitTimeoutSeconds }, 180},
		{"wait below min", "ENRICHMENT_WAIT_TIMEOUT_SECONDS", "4", func(c EnrichmentConfig) int { return c.WaitTimeoutSeconds }, 5},
		{"wait above max", "ENRICHMENT_WAIT_TIMEOUT_SECONDS", "181", func(c EnrichmentConfig) int { return c.WaitTimeoutSeconds }, 180},

		{"ttl min", "WEB_SESSION_TTL_MINUTES", "5", func(c EnrichmentConfig) int { return c.WebSessionTTLMinutes }, 5},
		{"ttl max", "WEB_SESSION_TTL_MINUTES", "10080", func(c EnrichmentConfig) int { return c.WebSessionTTLMinutes }, 10080},
		{"ttl below min", "WEB_SESSION_TTL_MINUTES", "1", func(c EnrichmentConfig) int { return c.WebSessionTTLMinutes }, 5},
		{"ttl above max", "WEB_SESSION_TTL_MINUTES", "99999", func(c EnrichmentConfig) int { return c.WebSessionTTLMinutes }, 10080},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearEnrichmentEnv(t)
			t.Setenv(tc.envKey, tc.envVal)
			cfg := ResolveEnrichmentConfig()
			if got := tc.get(cfg); got != tc.want {
				t.Fatalf("%s=%q -> got %d, want %d", tc.envKey, tc.envVal, got, tc.want)
			}
		})
	}
}

func TestResolveEnrichmentConfig_InvalidFallbacks(t *testing.T) {
	clearEnrichmentEnv(t)
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "abc")
	t.Setenv("ENRICHMENT_DEFAULT_MODE", "bogus")
	t.Setenv("ENRICHMENT_DEFAULT_FORCE", "maybe")
	t.Setenv("ENRICHMENT_SKIP_DETAIL_IF_PRESENT", "2")
	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "enable")
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "2.5")
	t.Setenv("ENRICHMENT_DEFAULT_EFFORT", "ultra")
	t.Setenv("ENRICHMENT_CONFIRM_THRESHOLD", "25px")
	t.Setenv("ENRICHMENT_WAIT_TIMEOUT_SECONDS", "nan")
	t.Setenv("WEB_UI_ENABLED", "nope_invalid")
	t.Setenv("WEB_SESSION_TTL_MINUTES", "12h")

	cfg := ResolveEnrichmentConfig()
	if cfg.MaxBatchSize != 25 || cfg.DefaultMode != "full" || cfg.DefaultForce ||
		!cfg.SkipDetailIfPresent || cfg.RequireDetails || cfg.MaxConcurrency != 2 ||
		cfg.DefaultEffort != "" || cfg.ConfirmThreshold != 5 || cfg.WaitTimeoutSeconds != 60 ||
		!cfg.WebUIEnabled || cfg.WebSessionTTLMinutes != 720 {
		t.Fatalf("expected invalid values to fall back to defaults, got %+v", cfg)
	}
}

func TestResolveEnrichmentConfig_TrimmingAndCaseInsensitivity(t *testing.T) {
	clearEnrichmentEnv(t)
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "  42 ")
	t.Setenv("ENRICHMENT_DEFAULT_MODE", "  DETAIL_ONLY \t")
	t.Setenv("ENRICHMENT_DEFAULT_FORCE", "  YES ")
	t.Setenv("ENRICHMENT_SKIP_DETAIL_IF_PRESENT", " Off ")
	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "1")
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "   ")
	t.Setenv("ENRICHMENT_DEFAULT_MODEL", "  gpt-oss:120b  ")
	t.Setenv("ENRICHMENT_DEFAULT_EFFORT", " XHigh ")
	t.Setenv("WEB_UI_ENABLED", " FALSE ")

	cfg := ResolveEnrichmentConfig()
	if cfg.MaxBatchSize != 42 {
		t.Errorf("MaxBatchSize = %d, want 42", cfg.MaxBatchSize)
	}
	if cfg.DefaultMode != "detail_only" {
		t.Errorf("DefaultMode = %q, want 'detail_only'", cfg.DefaultMode)
	}
	if !cfg.DefaultForce {
		t.Errorf("DefaultForce = false, want true")
	}
	if cfg.SkipDetailIfPresent {
		t.Errorf("SkipDetailIfPresent = true, want false")
	}
	if !cfg.RequireDetails {
		t.Errorf("RequireDetails = false, want true")
	}
	if cfg.MaxConcurrency != 2 {
		t.Errorf("MaxConcurrency = %d, want 2 (whitespace fallback)", cfg.MaxConcurrency)
	}
	if cfg.DefaultModel != "gpt-oss:120b" {
		t.Errorf("DefaultModel = %q, want 'gpt-oss:120b'", cfg.DefaultModel)
	}
	if cfg.DefaultEffort != "xhigh" {
		t.Errorf("DefaultEffort = %q, want 'xhigh'", cfg.DefaultEffort)
	}
	if cfg.WebUIEnabled {
		t.Errorf("WebUIEnabled = true, want false")
	}

	t.Setenv("ENRICHMENT_DEFAULT_MODEL", "   ")
	if cfg2 := ResolveEnrichmentConfig(); cfg2.DefaultModel != "" {
		t.Errorf("whitespace-only DefaultModel = %q, want ''", cfg2.DefaultModel)
	}
}

func TestEnrichmentConfig_HelpersAndZeroValueSafety(t *testing.T) {
	if m, ok := ParseEnrichmentMode(" FULL "); !ok || m != "full" {
		t.Errorf("ParseEnrichmentMode(' FULL ') = (%q, %v)", m, ok)
	}
	if _, ok := ParseEnrichmentMode("invalid"); ok {
		t.Errorf("expected invalid mode to return false")
	}
	if e, ok := ParseEnrichmentEffort(" MeDiUm "); !ok || e != "medium" {
		t.Errorf("ParseEnrichmentEffort(' MeDiUm ') = (%q, %v)", e, ok)
	}
	if _, ok := ParseEnrichmentEffort(""); ok {
		t.Errorf("expected empty effort to return false")
	}

	zero := EnrichmentConfig{}
	if zero.EffectiveMaxBatchSize() != 25 {
		t.Errorf("zero.EffectiveMaxBatchSize() = %d, want 25", zero.EffectiveMaxBatchSize())
	}
	if zero.EffectiveMaxConcurrency() != 2 {
		t.Errorf("zero.EffectiveMaxConcurrency() = %d, want 2", zero.EffectiveMaxConcurrency())
	}
	if zero.EffectiveMode() != "full" {
		t.Errorf("zero.EffectiveMode() = %q, want 'full'", zero.EffectiveMode())
	}
	if zero.WaitTimeout() != 60*time.Second {
		t.Errorf("zero.WaitTimeout() = %v, want 60s", zero.WaitTimeout())
	}
	if zero.WebSessionTTL() != 720*time.Minute {
		t.Errorf("zero.WebSessionTTL() = %v, want 720m", zero.WebSessionTTL())
	}

	over := EnrichmentConfig{
		MaxBatchSize:         500,
		MaxConcurrency:       99,
		DefaultMode:          "AI_ONLY",
		WaitTimeoutSeconds:   300,
		WebSessionTTLMinutes: 99999,
	}
	if over.EffectiveMaxBatchSize() != 100 {
		t.Errorf("over.EffectiveMaxBatchSize() = %d, want 100", over.EffectiveMaxBatchSize())
	}
	if over.EffectiveMaxConcurrency() != 4 {
		t.Errorf("over.EffectiveMaxConcurrency() = %d, want 4", over.EffectiveMaxConcurrency())
	}
	if over.EffectiveMode() != "ai_only" {
		t.Errorf("over.EffectiveMode() = %q, want 'ai_only'", over.EffectiveMode())
	}
	if over.WaitTimeout() != 180*time.Second {
		t.Errorf("over.WaitTimeout() = %v, want 180s", over.WaitTimeout())
	}
	if over.WebSessionTTL() != 10080*time.Minute {
		t.Errorf("over.WebSessionTTL() = %v, want 10080m", over.WebSessionTTL())
	}
}
