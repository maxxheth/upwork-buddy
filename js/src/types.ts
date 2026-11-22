/**
 * Core type definitions for Upwork Buddy
 */

export type ApiTransport = (url: string, init?: RequestInit) => Promise<Response>;

// ── Environment-aware configuration ──────────────────────────────────

export type EnvironmentName = 'development' | 'staging' | 'production';

export interface EnvironmentConfig {
  apiBaseUrl: string;
  profileApiEndpoint: string;
  jobsApiEndpoint: string;
}

export interface Config {
  apiBaseUrl: string;
  profileApiEndpoint: string;
  jobsApiEndpoint: string;
  profileStorageKey: string;
  defaultProfile: string;
  defaultSkills: string;
  env: EnvironmentName;
}

/** Per-environment endpoint overrides */
const ENVIRONMENTS: Record<EnvironmentName, EnvironmentConfig> = {
  development: {
    apiBaseUrl: 'http://127.0.0.1:9090',
    profileApiEndpoint: 'http://127.0.0.1:9090/api/profile',
    jobsApiEndpoint: 'http://127.0.0.1:9090/api/jobs',
  },
  staging: {
    apiBaseUrl: 'https://staging-api.upworkbuddy.app',
    profileApiEndpoint: 'https://staging-api.upworkbuddy.app/api/profile',
    jobsApiEndpoint: 'https://staging-api.upworkbuddy.app/api/jobs',
  },
  production: {
    apiBaseUrl: 'https://api.upworkbuddy.app',
    profileApiEndpoint: 'https://api.upworkbuddy.app/api/profile',
    jobsApiEndpoint: 'https://api.upworkbuddy.app/api/jobs',
  },
};

/** Defaults shared across every environment */
const DEFAULTS: Omit<Config, keyof EnvironmentConfig> = {
  profileStorageKey: 'upworkBuddyProfileData',
  defaultProfile:
    'Experienced full-stack developer with 10+ years in web development, specializing in Go, React, and PostgreSQL. Strong background in building scalable APIs and database-driven applications.',
  defaultSkills:
    'Go, JavaScript, TypeScript, React, Node.js, PostgreSQL, MySQL, Docker, Git, RESTful APIs, GraphQL, AWS, CI/CD',
  env: 'development',
};

/**
 * Normalize an environment name string to a valid EnvironmentName.
 * Treats "local" as an alias for "development".
 */
function normalizeEnvName(raw: string): EnvironmentName | null {
  const lower = raw.toLowerCase().trim();
  if (lower === 'local' || lower === 'development') return 'development';
  if (lower === 'staging' || lower === 'preprod') return 'staging';
  if (lower === 'production' || lower === 'prod') return 'production';
  if (lower in ENVIRONMENTS) return lower as EnvironmentName;
  return null;
}

interface ExtensionManifestLike {
  upwork_buddy_env?: unknown;
}

interface GlobalRuntimeLike {
  chrome?: {
    runtime?: {
      id?: string;
      getManifest?: () => ExtensionManifestLike;
    };
  };
  location?: {
    hostname?: string;
  };
}

/**
 * Detect which environment we are running in.
 *
 * Strategy (highest priority first):
 *  1. Explicit env override stored in localStorage (set by user or APP_ENV).
 *  2. Chrome extension manifest `upwork_buddy_env` field (set during packaging).
 *  3. Hostname / extension-runtime inference (www.upwork.com & extension runtime default to "development").
 *  4. Fall back to "development".
 */
export function detectEnvironment(): EnvironmentName {
  // 1. localStorage override — allows APP_ENV override to take effect on any hostname
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem) {
      const stored = localStorage.getItem('upwork_buddy_env');
      if (stored) {
        const env = normalizeEnvName(stored);
        if (env) return env;
      }
    }
  } catch {
    // localStorage not available (e.g. SSR) — continue
  }

  const runtimeGlobal = globalThis as unknown as GlobalRuntimeLike;

  // 2. Chrome extension manifest override
  try {
    const manifest = runtimeGlobal.chrome?.runtime?.getManifest?.();
    if (manifest && typeof manifest.upwork_buddy_env === 'string') {
      const env = normalizeEnvName(manifest.upwork_buddy_env);
      if (env) return env;
    }
  } catch {
    // Not in extension context — continue to next strategy
  }

  // 3. Hostname / extension runtime detection
  try {
    const hostname = runtimeGlobal.location?.hostname ?? '';
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname === 'www.upwork.com' ||
      hostname.endsWith('.upwork.com')
    ) {
      return 'development';
    }
    if (
      hostname.includes('staging') ||
      hostname.includes('preprod') ||
      hostname.endsWith('.staging')
    ) {
      return 'staging';
    }
    if (runtimeGlobal.chrome?.runtime?.id) {
      return 'development';
    }
    if (hostname !== '') {
      // Any other non-empty hostname that isn't localhost, upwork.com, or staging
      return 'production';
    }
  } catch {
    // location not available
  }

  // 4. Fallback
  return 'development';
}

/** Custom config overrides stored by the user (via StorageAdapter) */
export interface CustomConfigOverrides {
  apiBaseUrl?: string;
  profileApiEndpoint?: string;
  jobsApiEndpoint?: string;
}

/**
 * Build the fully-resolved Config for the given (or detected) environment,
 * optionally applying custom overrides.
 */
export function loadConfig(env?: string, overrides?: CustomConfigOverrides): Config {
  const envName = (env as EnvironmentName) ?? detectEnvironment();
  const envConfig = ENVIRONMENTS[envName] ?? ENVIRONMENTS.development;

  const merged: Config = {
    apiBaseUrl: overrides?.apiBaseUrl ?? envConfig.apiBaseUrl,
    profileApiEndpoint: overrides?.profileApiEndpoint ?? envConfig.profileApiEndpoint,
    jobsApiEndpoint: overrides?.jobsApiEndpoint ?? envConfig.jobsApiEndpoint,
    ...DEFAULTS,
    env: envName,
  };

  return merged;
}

// ── Backward-compatible active config ─────────────────────────────────
// Existing code that references `CONFIG.apiBaseUrl` etc. continues to work.
// At runtime this will be overwritten by `loadConfig()` in main.ts, but the
// defaults here guarantee the module is importable without calling loadConfig.

export const CONFIG: Config = loadConfig();

// ── Domain types ──────────────────────────────────────────────────────

/**
 * Contract type distinguishes hourly from fixed-price engagements.
 * - "hourly"  → rate_min / rate_max are populated; budget is derived
 * - "fixed"   → budget_amount is populated; budget is derived
 * - ""        → unknown / not yet detected
 */
export type ContractType = 'hourly' | 'fixed' | '';

export interface JobInfo {
  title: string;
  description: string;
  /** Contract type detected from the Upwork DOM */
  contractType: ContractType;
  /** Hourly rate range (e.g. "$25.00 - $100.00") — set when contractType is "hourly" */
  rateRange: string;
  /** Minimum hourly rate — set when contractType is "hourly" */
  rateMin: string;
  /** Maximum hourly rate — set when contractType is "hourly" */
  rateMax: string;
  /** Fixed-price budget (e.g. "$1,000.00") — set when contractType is "fixed" */
  budgetAmount: string;
  /**
   * Human-readable budget string for backward compatibility:
   *  - Hourly: "$25.00 - $100.00/hr"
   *  - Fixed:  "$1,000.00 fixed"
   *  - Unknown: "Not specified"
   */
  budget: string;
  /** Experience level (e.g. "Expert", "Intermediate", "Entry") */
  experienceLevel: string;
  /** Comma-separated skill names */
  skills: string;
}

export interface PortfolioItem {
  title: string;
  link: string;
  description: string;
}

export interface ProfileState {
  description: string;
  skills: string;
  portfolioItems: PortfolioItem[];
}

/** Profile extended with sync metadata for persistence */
export interface SyncedProfile extends ProfileState {
  lastSyncedAt: string | null;
  isDirty: boolean;
}

export interface ProfileApiResponse {
  description?: string;
  skills?: string;
  portfolio_items?: PortfolioItem[];
  portfolioItems?: PortfolioItem[];
  updated_at?: string;
  last_synced_at?: string;
  lastSyncedAt?: string;
}

export interface AnalysisResponse {
  proposal?: string;
  execution_prompt?: string;
  time_estimate?: string | string[] | Record<string, unknown>;
  workload_division?: string | string[] | Record<string, unknown>;
  questions_for_client?: string | string[] | Record<string, unknown>;
  tips_and_advice?: string | string[] | Record<string, unknown>;
  tone_analysis?: string;
  [key: string]: unknown;
}

export interface AnalysisCache {
  jobInfo: JobInfo;
  analysis: AnalysisResponse;
  timestamp: string;
  cacheKey: string;
}

export type AIEnrichmentStatus =
  | 'none'
  | 'queued'
  | 'scraping_details'
  | 'analyzing'
  | 'completed'
  | 'failed';

export interface PortfolioReferenceEntry {
  source: 'portfolio' | 'active_project' | string;
  display_name: string;
  visibility: 'public' | 'anonymized' | string;
  link?: string;
  summary?: string;
  activity_tier?: string;
  tech_stack?: string[];
}

export interface ScoreBreakdownData {
  rate_budget?: number;
  skill_match?: number;
  client_spend?: number;
  client_hires?: number;
  proposal_count?: number;
  recency?: number;
  description_quality?: number;
  payment_verified_mod?: number;
  client_hire_rate_mod?: number;
  connects_mod?: number;
  matched_skills?: string[];
  matched_portfolio?: string[];
  matched_active_projects?: string[];
  [key: string]: unknown;
}

export interface SavedJob {
  id: number;
  job_title: string;
  job_description: string;
  url?: string;
  upwork_job_id?: string;
  canonical_url?: string;
  source?: string;
  source_feed?: string;
  source_query?: string;
  status?: string;
  contract_type: string;
  budget: string;
  rate_range: string;
  rate_min: string;
  rate_max: string;
  budget_amount: string;
  experience_level: string;
  duration?: string;
  hours_per_week?: string;
  skills: string;
  posted_text?: string;
  posted_at_est?: string | null;
  proposals_tier?: string;
  proposals_count?: number | null;
  connects_required?: number | null;
  screening_questions?: Array<{ index: number; prompt: string; required?: boolean }>;
  attachments?: Array<{ filename: string; url: string }>;
  qualifications?: Array<{ name: string; value: string; met?: boolean | null }>;
  proposal: string;
  proposal_subject?: string;
  proposal_tone?: string;
  proposal_json?: unknown;
  portfolio_references?: PortfolioReferenceEntry[];
  time_estimate: string;
  workload_division?: unknown;
  questions_for_client?: unknown;
  tips_and_advice?: unknown;
  execution_prompt: string;
  tone_analysis: string;
  score?: number | null;
  score_breakdown?: ScoreBreakdownData;
  score_reasoning?: string;
  fit_label?: string;
  fit_assessment?: string;
  client_country?: string;
  client_rating?: number | null;
  client_reviews?: number | null;
  client_spent?: string;
  client_spent_usd?: number | null;
  client_hires?: number | null;
  client_hire_rate?: number | null;
  payment_verified?: boolean | null;
  client_activity?: {
    interviewing?: number;
    invites_sent?: number;
    unanswered_invites?: number;
    last_viewed?: string;
    avg_hourly_rate_paid?: string;
  };
  last_enriched_at?: string | null;
  ai_enrichment_status?: AIEnrichmentStatus | string;
  ai_enriched_at?: string | null;
  ai_enrichment_error?: string;
  ai_model?: string;
  ai_effort?: string;
  ai_tokens_used?: number | null;
  last_search_run_id?: number | null;
  applied_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface SavedJobsResponse {
  jobs: SavedJob[];
  total?: number;
}

export interface SaveJobRequest {
  job_title: string;
  job_description: string;
  url?: string;
  job_url?: string;
  upwork_job_id?: string;
  canonical_url?: string;
  source?: string;
  source_feed?: string;
  source_query?: string;
  status?: string;
  contract_type: string;
  budget: string;
  rate_range: string;
  rate_min: string;
  rate_max: string;
  budget_amount: string;
  experience_level: string;
  duration?: string;
  hours_per_week?: string;
  skills: string;
  posted_text?: string;
  proposals_tier?: string;
  proposals_count?: number | null;
  connects_required?: number | null;
  screening_questions?: Array<{ index: number; prompt: string; required?: boolean }>;
  attachments?: Array<{ filename: string; url: string }>;
  qualifications?: Array<{ name: string; value: string; met?: boolean | null }>;
  client_country?: string;
  client_rating?: number | null;
  client_reviews?: number | null;
  client_spent?: string;
  client_spent_usd?: number | null;
  client_hires?: number | null;
  client_hire_rate?: number | null;
  payment_verified?: boolean | null;
  client_avg_hourly?: string;
  client_activity?: {
    interviewing?: number;
    invites_sent?: number;
    unanswered_invites?: number;
    last_viewed?: string;
    avg_hourly_rate_paid?: string;
  };
  last_enriched_at?: string | null;
  proposal: string;
  time_estimate: string;
  workload_division?: unknown;
  questions_for_client?: unknown;
  tips_and_advice?: unknown;
  execution_prompt: string;
  tone_analysis: string;
}

// ── Template Agent System ──────────────────────────────────────

export interface DocRef {
  url: string;
  label: string;
}

export interface AgentBlueprint {
  name: string;
  title: string;
  description: string;
}

export interface TemplateCategory {
  name: string;
  display_name: string;
  description: string;
  icon: string;
  docs: DocRef[];
  agent_blueprints: AgentBlueprint[];
}

export interface TemplatesListResponse {
  templates: {
    name: string;
    display_name: string;
    description: string;
    icon: string;
    agent_count: number;
  }[];
}

export interface GenerateAgentsRequest {
  template_name: string;
  agent_names: string[];
  format?: string; // "goose" | "claude" | "codex" | "copilot" — defaults to "claude"
}

export interface GeneratedAgent {
  file_name: string;
  blueprint_name?: string;
  content: string;
  template_name: string;
  format: string;
  job_id?: number;
  generated_at: string;
}

export interface GenerateAgentsResponse {
  agents: GeneratedAgent[];
}

export interface DownloadAgentsRequest {
  agent_names: string[];
  template_name?: string;
  format?: string;
}

// ── Search Runs, Async Batch Enrichment & Dashboard DTOs ──────────────

export type EnrichmentMode = 'full' | 'ai_only' | 'detail_only';
export type AIEffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh';

export interface EnrichmentConfig {
  max_batch_size: number;
  default_mode: EnrichmentMode;
  default_force: boolean;
  skip_detail_if_present: boolean;
  require_details: boolean;
  max_concurrency: number;
  default_model: string;
  default_effort: AIEffortLevel;
  confirm_threshold: number;
  wait_timeout_seconds: number;
  web_ui_enabled: boolean;
  web_session_ttl_minutes: number;
}

export interface SearchRunSummary {
  id: number;
  label: string;
  source: string;
  triggered_by: string;
  profile_id?: number;
  project_keys: string[];
  queries: string[];
  criteria?: unknown;
  total_scraped: number;
  filtered_count: number;
  persisted_count: number;
  detail_enriched_count: number;
  stopped_reason: string;
  created_at: string;
}

export interface SearchRunsListResponse {
  search_runs: SearchRunSummary[];
  total: number;
}

export interface SearchRunDetailResponse {
  search_run: SearchRunSummary;
  jobs: SavedJob[];
}

export type EnrichmentBatchStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'canceled'
  | 'failed';

export type EnrichmentBatchItemStatus =
  | 'queued'
  | 'scraping_details'
  | 'analyzing'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'canceled';

export interface EnrichmentBatchSummary {
  id: number;
  mode: EnrichmentMode | string;
  triggered_by: string;
  model?: string;
  effort?: string;
  force: boolean;
  status: EnrichmentBatchStatus | string;
  total_count: number;
  queued_count: number;
  running_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
  canceled_count: number;
  total_tokens_used: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
}

export interface EnrichmentBatchItemEntry {
  id: number;
  batch_id: number;
  job_id: number;
  status: EnrichmentBatchItemStatus | string;
  detail_fetched: boolean;
  llm_invoked: boolean;
  model?: string;
  effort?: string;
  input_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  total_tokens: number;
  error_code?: string;
  error_message?: string;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnrichmentBatchesListResponse {
  batches: EnrichmentBatchSummary[];
  total: number;
}

export interface EnrichmentBatchDetailResponse {
  batch: EnrichmentBatchSummary;
  items: EnrichmentBatchItemEntry[];
  dashboard_url?: string;
}

export interface BatchEnrichRequest {
  job_ids: Array<number | string>;
  mode?: EnrichmentMode;
  force?: boolean;
  skip_detail_if_present?: boolean;
  require_details?: boolean;
  model?: string;
  effort?: AIEffortLevel | string;
  max_concurrency?: number;
  wait?: boolean;
  wait_timeout_seconds?: number;
  triggered_by?: string;
}

export interface ActiveProjectEntry {
  id: number;
  project_key: string;
  slug: string;
  name: string;
  path: string;
  group_name: string;
  activity_tier: 'active' | 'recent' | 'paused' | 'archived' | string;
  status: string;
  client: string;
  proposal_visibility: 'public' | 'anonymized' | 'private' | string;
  public_alias: string;
  tech_stack: string[];
  summary: string;
  pinned: boolean;
  last_activity_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ActiveProjectsListResponse {
  projects: ActiveProjectEntry[];
  count: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AnalyzeSavedJobResponse {
  job: SavedJob;
  score: number;
  fit_label: string;
  score_breakdown: ScoreBreakdownData;
  reasons: string[];
  matched_projects?: PortfolioReferenceEntry[];
  llm_analysis?: AnalysisResponse;
  llm_error?: string;
  usage?: TokenUsage;
  ai_enriched_at?: string | null;
  ai_model?: string;
  ai_effort?: string;
  ai_tokens_used?: number | null;
}

export interface ProposalEntry {
  id: number;
  job_id?: number | null;
  upwork_job_id: string;
  job_title?: string;
  cover_letter: string;
  bid_type: string;
  bid_amount?: number | null;
  rate_increase?: string;
  connects_required?: number | null;
  boost_connects?: number | null;
  total_connects: number;
  portfolio_refs_json?: unknown;
  status: string;
  approval_token?: string;
  approved_at?: string | null;
  submitted_at?: string | null;
  upwork_proposal_url?: string;
  created_at: string;
  updated_at: string;
}

export interface SaveProposalRequest {
  job_id?: number | string;
  upwork_job_id?: string;
  cover_letter: string;
  bid_type?: 'hourly' | 'fixed' | '';
  bid_amount?: number | null;
  rate_increase?: string;
  connects_required?: number | null;
  portfolio_refs?: PortfolioReferenceEntry[] | unknown;
  status?: string;
}

export interface WebTicketResponse {
  ticket: string;
  dashboard_url: string;
  expires_at: string;
}

export interface WebSessionExchangeResponse {
  session_token: string;
  expires_at: string;
}
