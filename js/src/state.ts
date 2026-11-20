/**
 * State management for profile and analyzed jobs cache
 */

import { ApiClient } from './api';
import { StorageAdapter } from './storage';
import type {
  AnalysisCache,
  AnalysisResponse,
  JobInfo,
  ProfileState,
  SavedJob,
  SaveJobRequest,
  SyncedProfile,
} from './types';
import { CONFIG } from './types';

export interface StateManagerDependencies {
  apiClient?: ApiClient;
  storage?: StorageAdapter;
}

/** Internal wrapper that tracks sync metadata alongside the profile */
interface ProfileWithSync {
  profile: ProfileState;
  lastSyncedAt: string | null;
  isDirty: boolean;
}

export class StateManager {
  private profileWithSync: ProfileWithSync;
  private analyzedJobs: Map<string, AnalysisCache>;
  private savedJobs: SavedJob[];
  private apiClient: ApiClient;
  private storage: StorageAdapter;

  constructor(deps?: StateManagerDependencies) {
    this.profileWithSync = {
      profile: {
        description: CONFIG.defaultProfile,
        skills: CONFIG.defaultSkills,
        portfolioItems: [],
      },
      lastSyncedAt: null,
      isDirty: false,
    };
    this.analyzedJobs = new Map();
    this.savedJobs = [];
    this.apiClient = deps?.apiClient ?? new ApiClient();
    this.storage = deps?.storage ?? new StorageAdapter();
  }

  /**
   * Hydrate local state from extension/bookmarklet storage.
   */
  async initializeStorage(): Promise<void> {
    await this.loadCacheFromStorage();

    const storedProfile = (await this.storage.getProfile()) as SyncedProfile | null;
    if (storedProfile) {
      // Separate profile data from sync metadata
      const { lastSyncedAt, isDirty, ...profileData } = storedProfile;
      this.profileWithSync.profile = profileData;
      this.profileWithSync.lastSyncedAt = lastSyncedAt ?? null;
      this.profileWithSync.isDirty = isDirty ?? false;
    }

    // If the profile is dirty (unsynced), attempt a background sync
    if (this.profileWithSync.isDirty) {
      console.log('🔄 Profile has unsynced changes — attempting background sync');
      this.attemptSync().catch((err) => {
        console.warn('⚠️ Background sync failed, will retry later', err);
      });
    }
  }

  /**
   * Get current profile state
   */
  getProfile(): ProfileState {
    return { ...this.profileWithSync.profile };
  }

  /**
   * Update profile state (marks as dirty)
   */
  setProfile(profile: ProfileState): void {
    this.profileWithSync.profile = profile;
    this.profileWithSync.isDirty = true;
  }

  /**
   * Whether the profile has unsynced local changes
   */
  isProfileDirty(): boolean {
    return this.profileWithSync.isDirty;
  }

  /**
   * When the profile was last successfully synced with the server
   */
  getProfileLastSyncedAt(): string | null {
    return this.profileWithSync.lastSyncedAt;
  }

  /**
   * Load profile from API or localStorage with sync awareness.
   *
   * Strategy:
   *  1. Try the API first — if it responds, it's the source of truth.
   *  2. If the API fails, fall back to storage.
   *  3. After a successful API load, clear the isDirty flag.
   */
  async loadProfile(): Promise<void> {
    const apiProfile = await this.apiClient.loadProfile();
    if (apiProfile) {
      const { lastSyncedAt, isDirty, ...profileData } = apiProfile as SyncedProfile;
      this.profileWithSync = {
        profile: profileData,
        lastSyncedAt: lastSyncedAt ?? new Date().toISOString(),
        isDirty: false,
      };
      await this.persistProfile(this.profileWithSync.profile);
      return;
    }

    const storedProfile = (await this.storage.getProfile()) as SyncedProfile | null;
    if (storedProfile) {
      const { lastSyncedAt, isDirty, ...profileData } = storedProfile;
      this.profileWithSync = {
        profile: profileData,
        lastSyncedAt: lastSyncedAt ?? null,
        isDirty: isDirty ?? false,
      };
    }
  }

  /**
   * Save profile to API and localStorage.
   * On success, clears the isDirty flag and updates lastSyncedAt.
   */
  async saveProfile(profile: ProfileState): Promise<ProfileState> {
    const saved = await this.apiClient.saveProfile(profile);
    this.profileWithSync = {
      profile: saved,
      lastSyncedAt: new Date().toISOString(),
      isDirty: false,
    };
    await this.persistProfile(saved);
    return saved;
  }

  /**
   * Sync the profile between local storage and the API.
   *
   * Conflict resolution strategy:
   *  - If the local profile is dirty AND the server has a newer lastSyncedAt,
   *    the server version wins (it was saved more recently from another device).
   *  - If the local profile is dirty but the server hasn't been updated since
   *    our last sync, push the local version to the server.
   *  - If neither side has changes, do nothing.
   */
  async syncProfile(): Promise<'pushed' | 'pulled' | 'no-change' | 'conflict-server-wins'> {
    const apiProfile = await this.apiClient.loadProfile();

    // No server profile — push local if dirty
    if (!apiProfile) {
      if (this.profileWithSync.isDirty) {
        console.log('🔄 No server profile — pushing local changes');
        await this.saveProfile(this.profileWithSync.profile);
        return 'pushed';
      }
      return 'no-change';
    }

    const { lastSyncedAt: serverSyncTime, ...serverData } = apiProfile as SyncedProfile;
    const localSyncTime = this.profileWithSync.lastSyncedAt;

    // Local profile is clean — just pull from server
    if (!this.profileWithSync.isDirty) {
      if (serverSyncTime && serverSyncTime !== localSyncTime) {
        console.log('🔄 Local profile is clean — pulling from server');
        this.profileWithSync = {
          profile: serverData,
          lastSyncedAt: serverSyncTime ?? new Date().toISOString(),
          isDirty: false,
        };
        await this.persistProfile(serverData);
        return 'pulled';
      }
      return 'no-change';
    }

    // Both sides have changes — compare timestamps
    const serverTime = serverSyncTime ? new Date(serverSyncTime).getTime() : 0;
    const localTime = localSyncTime ? new Date(localSyncTime).getTime() : 0;

    if (serverTime > localTime) {
      // Server is newer — server wins
      console.log('⚠️ Conflict detected — server profile is newer, pulling');
      this.profileWithSync = {
        profile: serverData,
        lastSyncedAt: serverSyncTime,
        isDirty: false,
      };
      await this.persistProfile(serverData);
      return 'conflict-server-wins';
    }

    // Local is newer or same — push to server
    console.log('🔄 Pushing local profile — it is newer than server');
    await this.saveProfile(this.profileWithSync.profile);
    return 'pushed';
  }

  /**
   * Attempt a background sync if the profile is dirty.
   * Non-throwing — errors are logged but not propagated.
   */
  async attemptSync(): Promise<void> {
    if (!this.profileWithSync.isDirty) {
      return;
    }

    try {
      await this.syncProfile();
      console.log('✅ Background sync completed');
    } catch (error) {
      console.warn('⚠️ Background sync failed:', error);
    }
  }

  private async persistProfile(profile: ProfileState): Promise<void> {
    try {
      const synced: SyncedProfile = {
        ...profile,
        lastSyncedAt: this.profileWithSync.lastSyncedAt,
        isDirty: this.profileWithSync.isDirty,
      };
      await this.storage.saveProfile(synced as ProfileState);
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
      cacheKey,
    });

    console.log('✅ Cached analysis. New cache size:', this.analyzedJobs.size);
    await this.persistCache();
  }

  /**
   * Get all cached jobs
   */
  getAllCachedJobs(): AnalysisCache[] {
    return Array.from(this.analyzedJobs.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  /**
   * Raw snapshot of the cache in insertion order (used for export)
   */
  getCacheSnapshot(): AnalysisCache[] {
    return Array.from(this.analyzedJobs.values());
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
   * Load saved jobs from the backend API and store locally
   */
  async loadSavedJobs(): Promise<SavedJob[]> {
    this.savedJobs = await this.apiClient.loadJobs();
    return this.savedJobs;
  }

  /**
   * Get locally cached saved jobs
   */
  getSavedJobs(): SavedJob[] {
    return [...this.savedJobs];
  }

  /**
   * Save a job analysis to history
   */
  async saveJobToHistory(job: SaveJobRequest): Promise<SavedJob> {
    const result = await this.apiClient.saveJob(job);
    const savedJob: SavedJob = {
      id: result.id,
      job_title: job.job_title,
      job_description: job.job_description,
      ...(job.url ? { url: job.url } : {}),
      ...(job.upwork_job_id ? { upwork_job_id: job.upwork_job_id } : {}),
      ...(job.canonical_url ? { canonical_url: job.canonical_url } : {}),
      contract_type: job.contract_type,
      budget: job.budget,
      rate_range: job.rate_range,
      rate_min: job.rate_min,
      rate_max: job.rate_max,
      budget_amount: job.budget_amount,
      experience_level: job.experience_level,
      skills: job.skills,
      proposal: job.proposal,
      time_estimate: job.time_estimate,
      execution_prompt: job.execution_prompt,
      tone_analysis: job.tone_analysis,
      created_at: result.created_at,
    };
    this.savedJobs.unshift(savedJob);
    return savedJob;
  }

  /**
   * Delete a job from history
   */
  async deleteJobFromHistory(id: number): Promise<void> {
    await this.apiClient.deleteJob(id);
    this.savedJobs = this.savedJobs.filter((j) => j.id !== id);
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.analyzedJobs.size;
  }

  /**
   * Replace cache contents with entries loaded from disk/JSON file
   */
  async importCacheFromJson(rawData: unknown): Promise<number> {
    const normalizedEntries = this.normalizeCacheEntries(rawData);
    if (normalizedEntries.length === 0) {
      console.warn('Import cache: no valid entries detected');
      return 0;
    }

    const nextMap = new Map<string, AnalysisCache>();
    for (const entry of normalizedEntries) {
      nextMap.set(entry.cacheKey, entry);
    }

    this.analyzedJobs = nextMap;
    await this.persistCache();
    console.log(`✅ Imported ${this.analyzedJobs.size} cached analyses from file`);
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

  private normalizeCacheEntries(rawData: unknown): AnalysisCache[] {
    const rows = this.extractEntriesArray(rawData);
    if (!rows) {
      return [];
    }

    const normalized: AnalysisCache[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }

      const candidate = row as Partial<AnalysisCache> & {
        jobInfo?: Partial<JobInfo>;
        analysis?: AnalysisResponse;
      };
      const jobInfo = candidate.jobInfo;
      if (!jobInfo || typeof jobInfo !== 'object') {
        continue;
      }

      const rawJob = jobInfo as unknown as Record<string, unknown>;
      const title = typeof rawJob.title === 'string' ? rawJob.title : 'Unknown Title';
      const description =
        typeof rawJob.description === 'string' ? rawJob.description : 'No description available';
      const contractType =
        typeof rawJob.contractType === 'string'
          ? (rawJob.contractType as JobInfo['contractType'])
          : '';
      const rateRange = typeof rawJob.rateRange === 'string' ? rawJob.rateRange : '';
      const rateMin = typeof rawJob.rateMin === 'string' ? rawJob.rateMin : '';
      const rateMax = typeof rawJob.rateMax === 'string' ? rawJob.rateMax : '';
      const budgetAmount = typeof rawJob.budgetAmount === 'string' ? rawJob.budgetAmount : '';
      const experienceLevel =
        typeof rawJob.experienceLevel === 'string' ? rawJob.experienceLevel : '';
      const budget = typeof rawJob.budget === 'string' ? rawJob.budget : 'Not specified';
      const skills = typeof rawJob.skills === 'string' ? rawJob.skills : 'Not specified';

      const fullJobInfo: JobInfo = {
        title,
        description,
        contractType,
        rateRange,
        rateMin,
        rateMax,
        budgetAmount,
        experienceLevel,
        budget,
        skills,
      };

      const cacheKey =
        typeof candidate.cacheKey === 'string' && candidate.cacheKey.trim().length > 0
          ? candidate.cacheKey
          : this.generateCacheKey(fullJobInfo);
      const timestamp =
        typeof candidate.timestamp === 'string' ? candidate.timestamp : new Date().toISOString();
      const analysis =
        candidate.analysis && typeof candidate.analysis === 'object' ? candidate.analysis : {};

      normalized.push({
        jobInfo: fullJobInfo,
        analysis: analysis as AnalysisResponse,
        timestamp,
        cacheKey,
      });
    }

    return normalized;
  }

  private extractEntriesArray(
    rawData: unknown,
  ): Array<AnalysisCache | Record<string, unknown>> | null {
    if (Array.isArray(rawData)) {
      return rawData as Array<AnalysisCache | Record<string, unknown>>;
    }

    if (rawData && typeof rawData === 'object') {
      const withItems = rawData as { items?: unknown };
      if (Array.isArray(withItems.items)) {
        return withItems.items as Array<AnalysisCache | Record<string, unknown>>;
      }
    }

    return null;
  }
}
