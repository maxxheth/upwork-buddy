/**
 * Core type definitions for Upwork Buddy
 */

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
  time_estimate?: string;
  workload_division?: string;
  questions_for_client?: string;
  tips_and_advice?: string;
  tone_analysis?: string;
  [key: string]: unknown;
}

export interface AnalysisCache {
  jobInfo: JobInfo;
  analysis: AnalysisResponse;
  timestamp: string;
  cacheKey: string;
}

export interface SavedJob {
  id: number;
  job_title: string;
  job_description: string;
  contract_type: string;
  budget: string;
  rate_range: string;
  rate_min: string;
  rate_max: string;
  budget_amount: string;
  experience_level: string;
  skills: string;
  proposal: string;
  time_estimate: string;
  execution_prompt: string;
  tone_analysis: string;
  created_at: string;
}

export interface SavedJobsResponse {
  jobs: SavedJob[];
}

export interface SaveJobRequest {
  job_title: string;
  job_description: string;
  contract_type: string;
  budget: string;
  rate_range: string;
  rate_min: string;
  rate_max: string;
  budget_amount: string;
  experience_level: string;
  skills: string;
  proposal: string;
  time_estimate: string;
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
  content: string;
  template_name: string;
  format: string;
  generated_at: string;
}

export interface GenerateAgentsResponse {
  agents: GeneratedAgent[];
}

export interface DownloadAgentsRequest {
  agent_names: string[];
}
