/**
 * Core type definitions for Upwork Buddy
 */

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

export interface Config {
  apiBaseUrl: string;
  profileApiEndpoint: string;
  profileStorageKey: string;
  defaultProfile: string;
  defaultSkills: string;
}

export const CONFIG: Config = {
  apiBaseUrl: 'http://localhost:9090',
  profileApiEndpoint: 'http://localhost:9090/api/profile',
  profileStorageKey: 'upworkBuddyProfileData',
  defaultProfile: 'Experienced full-stack developer with 10+ years in web development, specializing in Go, React, and PostgreSQL. Strong background in building scalable APIs and database-driven applications.',
  defaultSkills: 'Go, JavaScript, TypeScript, React, Node.js, PostgreSQL, MySQL, Docker, Git, RESTful APIs, GraphQL, AWS, CI/CD'
};
