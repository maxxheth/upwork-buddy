/**
 * State management for profile and analyzed jobs cache
 */

import type { ProfileState, AnalysisCache, AnalysisResponse, JobInfo } from './types';
import { CONFIG } from './types';
import { ApiClient } from './api';
import { StorageAdapter } from './storage';

export class StateManager {
  private currentProfile: ProfileState;
  private analyzedJobs: Map<string, AnalysisCache>;
  private apiClient: ApiClient;
  private storage: StorageAdapter;

  constructor() {
    this.currentProfile = {
      description: CONFIG.defaultProfile,
      skills: CONFIG.defaultSkills,
      portfolioItems: []
    };
    this.analyzedJobs = new Map();
    this.apiClient = new ApiClient();
    this.storage = new StorageAdapter();
  }

  /**
   * Hydrate local state from extension/bookmarklet storage.
   */
  async initializeStorage(): Promise<void> {
    await this.loadCacheFromStorage();

    const storedProfile = await this.storage.getProfile();
    if (storedProfile) {
      this.currentProfile = storedProfile;
    }
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
      await this.persistProfile(apiProfile);
      return;
    }

    const storedProfile = await this.storage.getProfile();
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
    await this.persistProfile(saved);
    return saved;
  }

  private async persistProfile(profile: ProfileState): Promise<void> {
    try {
      await this.storage.saveProfile(profile);
    } catch (error) {
      console.warn('Failed to persist profile', error);
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
  async cacheAnalysis(jobInfo: JobInfo, analysis: AnalysisResponse): Promise<void> {
    const cacheKey = this.generateCacheKey(jobInfo);
    this.analyzedJobs.set(cacheKey, {
      jobInfo,
      analysis,
      timestamp: new Date().toISOString(),
      cacheKey
    });

    console.log('✅ Cached analysis. New cache size:', this.analyzedJobs.size);
    await this.persistCache();
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
  async clearCache(): Promise<void> {
    this.analyzedJobs.clear();
    await this.persistCache();
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
  private async persistCache(): Promise<void> {
    try {
      const cacheArray = Array.from(this.analyzedJobs.entries());
      await this.storage.saveCache(cacheArray);
    } catch (error) {
      console.warn('Failed to persist cache', error);
    }
  }

  /**
   * Load cache from persistent storage
   */
  private async loadCacheFromStorage(): Promise<void> {
    try {
      const cacheArray = await this.storage.getCache();
      if (Array.isArray(cacheArray)) {
        this.analyzedJobs = new Map(cacheArray);
        console.log('✅ Loaded', this.analyzedJobs.size, 'cached analyses from storage');
      }
    } catch (error) {
      console.warn('Failed to load cache from storage', error);
    }
  }
}
