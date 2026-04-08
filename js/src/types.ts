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
    apiBaseUrl: 'http://localhost:9090',
    profileApiEndpoint: 'http://localhost:9090/api/profile',
    jobsApiEndpoint: 'http://localhost:9090/api/jobs',
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
 * Detect which environment we are running in.
 *
 * Strategy:
 *  1. If running as a Chrome extension, check the manifest for a custom
 *     `upwork_buddy_env` field set during packaging.
 *  2. If `window.location` is available, infer from hostname.
 *  3. Fall back to "development".
 */
export function detectEnvironment(): EnvironmentName {
  // 1. Chrome extension manifest override
  try {
    const manifest = (globalThis as any).chrome?.runtime?.getManifest?.();
    if (manifest && typeof manifest.upwork_buddy_env === 'string') {
      const env = manifest.upwork_buddy_env;
      if (env in ENVIRONMENTS) {
        return env as EnvironmentName;
      }
    }
  } catch {
    // Not in extension context — continue to next strategy
  }

  // 2. Hostname-based detection
  try {
    const hostname = (globalThis as any).location?.hostname ?? '';
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
      return 'development';
    }
    if (hostname.includes('staging') || hostname.includes('preprod') || hostname.endsWith('.staging')) {
      return 'staging';
    }
    if (hostname !== '') {
      // Any non-empty hostname that isn't localhost or staging is likely production
      return 'production';
    }
  } catch {
    // location not available
  }

  // 3. Fallback
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

export interface JobInfo {
  title: string;
  description: string;
  budget: string;
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
}

export interface AnalysisResponse {
  proposal?: string;
  spec_sheet_prompt?: string;
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
  budget: string;
  skills: string;
  proposal: string;
  time_estimate: string;
  spec_sheet_prompt: string;
  tone_analysis: string;
  created_at: string;
}

export interface SavedJobsResponse {
  jobs: SavedJob[];
}

export interface SaveJobRequest {
  job_title: string;
  job_description: string;
  budget: string;
  skills: string;
  proposal: string;
  time_estimate: string;
  spec_sheet_prompt: string;
  tone_analysis: string;
}
