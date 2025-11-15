/**
 * State management for profile and analyzed jobs cache
 */

import type { ProfileState, AnalysisCache, AnalysisResponse, JobInfo } from './types';
import { CONFIG } from './types';
import { ApiClient } from './api';

export class StateManager {
  private currentProfile: ProfileState;
  private analyzedJobs: Map<string, AnalysisCache>;
  private apiClient: ApiClient;

  constructor() {
    this.currentProfile = {
      description: CONFIG.defaultProfile,
      skills: CONFIG.defaultSkills,
      portfolioItems: []
    };
    this.analyzedJobs = new Map();
    this.apiClient = new ApiClient();
    this.loadCacheFromStorage();
  }

  /**
   * Get current profile state
   */
  getProfile(): ProfileState {
    return { ...this.currentProfile };
  }

  /**
   * Update profile state
   */
  setProfile(profile: ProfileState): void {
    this.currentProfile = profile;
  }

  /**
   * Load profile from API or localStorage
   */
  async loadProfile(): Promise<void> {
    const apiProfile = await this.apiClient.loadProfile();
    if (apiProfile) {
      this.currentProfile = apiProfile;
      this.persistProfileLocally(apiProfile);
      return;
    }

    const storedProfile = this.loadProfileFromStorage();
    if (storedProfile) {
      this.currentProfile = storedProfile;
    }
  }

  /**
   * Save profile to API and localStorage
   */
  async saveProfile(profile: ProfileState): Promise<ProfileState> {
    const saved = await this.apiClient.saveProfile(profile);
    this.currentProfile = saved;
    this.persistProfileLocally(saved);
    return saved;
  }

  /**
   * Persist profile to localStorage
   */
  private persistProfileLocally(profile: ProfileState): void {
    try {
      localStorage.setItem(CONFIG.profileStorageKey, JSON.stringify(profile));
    } catch (error) {
      console.warn('Failed to persist profile locally', error);
    }
  }

  /**
   * Load profile from localStorage
   */
  private loadProfileFromStorage(): ProfileState | null {
    try {
      const stored = localStorage.getItem(CONFIG.profileStorageKey);
      if (!stored) return null;

      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object') return null;

      return {
        description: parsed.description || '',
        skills: parsed.skills || '',
        portfolioItems: Array.isArray(parsed.portfolioItems) ? parsed.portfolioItems : []
      };
    } catch (error) {
      console.warn('Failed to read profile from storage', error);
      return null;
    }
  }

  /**
   * Generate cache key for a job
   */
  private generateCacheKey(jobInfo: JobInfo): string {
    return `${jobInfo.title}||${jobInfo.description.substring(0, 100)}`;
  }

  /**
   * Check if job is cached
   */
  hasCachedAnalysis(jobInfo: JobInfo): boolean {
    const key = this.generateCacheKey(jobInfo);
    return this.analyzedJobs.has(key);
  }

  /**
   * Get cached analysis
   */
  getCachedAnalysis(jobInfo: JobInfo): AnalysisResponse | null {
    const key = this.generateCacheKey(jobInfo);
    const cached = this.analyzedJobs.get(key);
    return cached ? { ...cached.analysis, _cached: true } : null;
  }

  /**
   * Cache analysis result
   */
  cacheAnalysis(jobInfo: JobInfo, analysis: AnalysisResponse): void {
    const cacheKey = this.generateCacheKey(jobInfo);
    this.analyzedJobs.set(cacheKey, {
      jobInfo,
      analysis,
      timestamp: new Date().toISOString(),
      cacheKey
    });

    console.log('✅ Cached analysis. New cache size:', this.analyzedJobs.size);
    this.persistCacheLocally();
  }

  /**
   * Get all cached jobs
   */
  getAllCachedJobs(): AnalysisCache[] {
    return Array.from(this.analyzedJobs.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Get cached job by cache key
   */
  getCachedJobByKey(cacheKey: string): AnalysisCache | null {
    return this.analyzedJobs.get(cacheKey) || null;
  }

  /**
   * Clear all cached analyses
   */
  clearCache(): void {
    this.analyzedJobs.clear();
    this.persistCacheLocally();
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.analyzedJobs.size;
  }

  /**
   * Persist cache to localStorage
   */
  private persistCacheLocally(): void {
    try {
      const cacheArray = Array.from(this.analyzedJobs.entries());
      localStorage.setItem('upworkBuddyCachedJobs', JSON.stringify(cacheArray));
    } catch (error) {
      console.warn('Failed to persist cache locally', error);
    }
  }

  /**
   * Load cache from localStorage
   */
  private loadCacheFromStorage(): void {
    try {
      const stored = localStorage.getItem('upworkBuddyCachedJobs');
      if (!stored) return;

      const cacheArray = JSON.parse(stored);
      if (Array.isArray(cacheArray)) {
        this.analyzedJobs = new Map(cacheArray);
        console.log('✅ Loaded', this.analyzedJobs.size, 'cached analyses from storage');
      }
    } catch (error) {
      console.warn('Failed to load cache from storage', error);
    }
  }
}
