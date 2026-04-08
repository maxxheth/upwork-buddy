import { describe, it, expect, vi } from 'vitest';
import { StateManager } from './state';
import type { ProfileState, AnalysisResponse, JobInfo } from './types';

const defaultProfile: ProfileState = {
  description: 'Experienced full-stack developer with 10+ years in web development, specializing in Go, React, and PostgreSQL. Strong background in building scalable APIs and database-driven applications.',
  skills: 'Go, JavaScript, TypeScript, React, Node.js, PostgreSQL, MySQL, Docker, Git, RESTful APIs, GraphQL, AWS, CI/CD',
  portfolioItems: []
};

const sampleJobInfo: JobInfo = {
  title: 'Build a Website',
  description: 'We need a responsive website built with React and TypeScript for our e-commerce platform. The site should include a product catalog, shopping cart, and checkout flow.',
  budget: '$5000',
  skills: 'React, TypeScript, Node.js'
};

const sampleAnalysis: AnalysisResponse = {
  proposal: 'Dear Client, I am excited to apply...',
  time_estimate: '2-3 weeks',
  spec_sheet_prompt: 'Build a responsive e-commerce website'
};

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    loadProfile: vi.fn().mockResolvedValue(null),
    saveProfile: vi.fn().mockImplementation((p: ProfileState) => Promise.resolve(p)),
    analyzeJob: vi.fn(),
    ...overrides
  } as any;
}

function createMockStorage(overrides: Record<string, unknown> = {}) {
  return {
    getProfile: vi.fn().mockResolvedValue(null),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    getCache: vi.fn().mockResolvedValue(null),
    saveCache: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as any;
}

describe('StateManager', () => {
  describe('Constructor', () => {
    it('should initialize with correct default profile', () => {
      const sm = new StateManager();
      const profile = sm.getProfile();
      expect(profile.description).toBe(defaultProfile.description);
      expect(profile.skills).toBe(defaultProfile.skills);
      expect(profile.portfolioItems).toEqual([]);
    });

    it('should start with empty cache', () => {
      const sm = new StateManager();
      expect(sm.getCacheSize()).toBe(0);
    });
  });

  describe('Profile operations', () => {
    it('should return a copy of the profile from getProfile', () => {
      const sm = new StateManager();
      const profile1 = sm.getProfile();
      const profile2 = sm.getProfile();
      expect(profile1).toEqual(profile2);
      expect(profile1).not.toBe(profile2);
    });

    it('should update profile via setProfile', () => {
      const sm = new StateManager();
      const newProfile: ProfileState = {
        description: 'New description',
        skills: 'Python, Django',
        portfolioItems: [{ title: 'Project1', link: 'https://example.com', description: 'A project' }]
      };
      sm.setProfile(newProfile);
      expect(sm.getProfile()).toEqual(newProfile);
    });

    it('should load profile from API when available', async () => {
      const apiProfile: ProfileState = {
        description: 'API profile',
        skills: 'Rust, WASM',
        portfolioItems: []
      };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(apiProfile) });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      await sm.loadProfile();
      expect(sm.getProfile().description).toBe('API profile');
    });

    it('should fall back to storage when API returns null', async () => {
      const storedProfile: ProfileState = {
        description: 'Stored profile',
        skills: 'Java, Spring',
        portfolioItems: []
      };
      const mockStorage = createMockStorage({ getProfile: vi.fn().mockResolvedValue(storedProfile) });
      const sm = new StateManager({ apiClient: createMockApi(), storage: mockStorage });
      await sm.loadProfile();
      expect(sm.getProfile().description).toBe('Stored profile');
    });

    it('should save profile via API and persist to storage', async () => {
      const newProfile: ProfileState = {
        description: 'Saved profile',
        skills: 'Go, Kubernetes',
        portfolioItems: []
      };
      const mockApi = createMockApi();
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      const result = await sm.saveProfile(newProfile);
      expect(result.description).toBe('Saved profile');
      expect(mockStorage.saveProfile).toHaveBeenCalled();
    });
  });

  describe('Job analysis caching', () => {
    it('should cache and retrieve analysis', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      expect(sm.hasCachedAnalysis(sampleJobInfo)).toBe(true);
      const cached = sm.getCachedAnalysis(sampleJobInfo);
      expect(cached).toBeTruthy();
      expect(cached!._cached).toBe(true);
    });

    it('should return null for uncached job', () => {
      const sm = new StateManager();
      expect(sm.hasCachedAnalysis(sampleJobInfo)).toBe(false);
      expect(sm.getCachedAnalysis(sampleJobInfo)).toBeNull();
    });

    it('should increment cache size', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      expect(sm.getCacheSize()).toBe(0);
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      expect(sm.getCacheSize()).toBe(1);
    });

    it('should clear cache', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      expect(sm.getCacheSize()).toBe(1);
      await sm.clearCache();
      expect(sm.getCacheSize()).toBe(0);
      expect(sm.hasCachedAnalysis(sampleJobInfo)).toBe(false);
    });

    it('should persist cache to storage', async () => {
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: createMockApi(), storage: mockStorage });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      expect(mockStorage.saveCache).toHaveBeenCalled();
    });

    it('should return all cached jobs sorted by timestamp', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const job1: JobInfo = { ...sampleJobInfo, title: 'Job 1' };
      const job2: JobInfo = { ...sampleJobInfo, title: 'Job 2' };
      await sm.cacheAnalysis(job1, sampleAnalysis);
      await new Promise(r => setTimeout(r, 10));
      await sm.cacheAnalysis(job2, sampleAnalysis);
      const all = sm.getAllCachedJobs();
      expect(all.length).toBe(2);
      expect(all[0].jobInfo.title).toBe('Job 2');
      expect(all[1].jobInfo.title).toBe('Job 1');
    });

    it('should get cached job by cache key', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      const all = sm.getAllCachedJobs();
      const key = all[0].cacheKey;
      const found = sm.getCachedJobByKey(key);
      expect(found).toBeTruthy();
      expect(found!.jobInfo.title).toBe('Build a Website');
    });

    it('should return null for unknown cache key', () => {
      const sm = new StateManager();
      expect(sm.getCachedJobByKey('nonexistent')).toBeNull();
    });
  });

  describe('Import/Export', () => {
    it('should import cache from JSON array', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const importData = [{
        jobInfo: sampleJobInfo,
        analysis: sampleAnalysis,
        timestamp: new Date().toISOString(),
        cacheKey: 'Build a Website||We need a responsive website built with React and TypeScript for our e-commerce platfor'
      }];
      const count = await sm.importCacheFromJson(importData);
      expect(count).toBe(1);
      expect(sm.getCacheSize()).toBe(1);
    });

    it('should import cache from object with items array', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const importData = {
        items: [{
          jobInfo: sampleJobInfo,
          analysis: sampleAnalysis,
          timestamp: new Date().toISOString(),
          cacheKey: 'some-key'
        }]
      };
      const count = await sm.importCacheFromJson(importData);
      expect(count).toBe(1);
    });

    it('should return 0 for empty array', async () => {
      const sm = new StateManager();
      const count = await sm.importCacheFromJson([]);
      expect(count).toBe(0);
    });

    it('should return 0 for null', async () => {
      const sm = new StateManager();
      const count = await sm.importCacheFromJson(null);
      expect(count).toBe(0);
    });

    it('should return 0 for invalid data', async () => {
      const sm = new StateManager();
      const count = await sm.importCacheFromJson('not an object');
      expect(count).toBe(0);
    });

    it('should handle entries with missing fields by providing defaults', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const importData = [{
        jobInfo: { title: 'Only Title' },
        analysis: { proposal: 'test' },
        timestamp: '2026-01-01T00:00:00Z',
        cacheKey: 'my-key'
      }];
      const count = await sm.importCacheFromJson(importData);
      expect(count).toBe(1);
      const cached = sm.getCachedJobByKey('my-key');
      expect(cached).toBeTruthy();
      expect(cached!.jobInfo.description).toBe('No description available');
      expect(cached!.jobInfo.budget).toBe('Not specified');
      expect(cached!.jobInfo.skills).toBe('Not specified');
    });

    it('should generate cacheKey when missing', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const importData = [{
        jobInfo: { title: 'My Job', description: 'A job description that is here', budget: '100', skills: 'React' },
        analysis: { proposal: 'test' },
        timestamp: '2026-01-01T00:00:00Z'
      }];
      const count = await sm.importCacheFromJson(importData);
      expect(count).toBe(1);
      expect(sm.getCacheSize()).toBe(1);
    });

    it('should skip entries without jobInfo', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      const importData = [
        { analysis: { proposal: 'test' }, timestamp: '2026-01-01T00:00:00Z', cacheKey: 'key1' },
        { jobInfo: { title: 'Valid' }, analysis: { proposal: 'test' }, timestamp: '2026-01-01T00:00:00Z', cacheKey: 'key2' }
      ];
      const count = await sm.importCacheFromJson(importData);
      expect(count).toBe(1);
    });

    it('should replace existing cache on import', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      expect(sm.getCacheSize()).toBe(1);
      const importData = [{
        jobInfo: { title: 'New Job', description: 'New description', budget: '$1000', skills: 'Vue' },
        analysis: { proposal: 'new proposal' },
        timestamp: new Date().toISOString(),
        cacheKey: 'new-key'
      }];
      await sm.importCacheFromJson(importData);
      expect(sm.getCacheSize()).toBe(1);
      expect(sm.getCachedJobByKey('new-key')).toBeTruthy();
      expect(sm.hasCachedAnalysis(sampleJobInfo)).toBe(false);
    });

    it('should get cache snapshot', async () => {
      const sm = new StateManager({ apiClient: createMockApi(), storage: createMockStorage() });
      await sm.cacheAnalysis(sampleJobInfo, sampleAnalysis);
      const snapshot = sm.getCacheSnapshot();
      expect(snapshot.length).toBe(1);
      expect(snapshot[0].jobInfo.title).toBe('Build a Website');
    });
  });

  describe('initializeStorage', () => {
    it('should load cache and profile from storage', async () => {
      const storedProfile: ProfileState = {
        description: 'Stored',
        skills: 'Skills',
        portfolioItems: []
      };
      const mockStorage = createMockStorage({
        getProfile: vi.fn().mockResolvedValue(storedProfile),
        getCache: vi.fn().mockResolvedValue([])
      });
      const sm = new StateManager({ apiClient: createMockApi(), storage: mockStorage });
      await sm.initializeStorage();
      expect(sm.getProfile().description).toBe('Stored');
    });

    it('should keep defaults when storage is empty', async () => {
      const mockStorage = createMockStorage({
        getProfile: vi.fn().mockResolvedValue(null),
        getCache: vi.fn().mockResolvedValue(null)
      });
      const sm = new StateManager({ apiClient: createMockApi(), storage: mockStorage });
      await sm.initializeStorage();
      expect(sm.getProfile().description).toBe(defaultProfile.description);
    });
  });

  describe('Profile sync', () => {
    it('should mark profile as dirty when setProfile is called', () => {
      const sm = new StateManager();
      expect(sm.isProfileDirty()).toBe(false);
      sm.setProfile({ description: 'New', skills: 'Skills', portfolioItems: [] });
      expect(sm.isProfileDirty()).toBe(true);
    });

    it('should clear isDirty after successful saveProfile', async () => {
      const mockApi = createMockApi();
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      sm.setProfile({ description: 'Updated', skills: 'Skills', portfolioItems: [] });
      expect(sm.isProfileDirty()).toBe(true);
      await sm.saveProfile(sm.getProfile());
      expect(sm.isProfileDirty()).toBe(false);
    });

    it('should update lastSyncedAt after successful saveProfile', async () => {
      const mockApi = createMockApi();
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      expect(sm.getProfileLastSyncedAt()).toBeNull();
      await sm.saveProfile({ description: 'Test', skills: 'Skills', portfolioItems: [] });
      expect(sm.getProfileLastSyncedAt()).not.toBeNull();
    });

    it('should clear isDirty after successful loadProfile from API', async () => {
      const apiProfile: ProfileState = { description: 'API', skills: 'Skills', portfolioItems: [] };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(apiProfile) });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      sm.setProfile({ description: 'Local', skills: 'Skills', portfolioItems: [] });
      expect(sm.isProfileDirty()).toBe(true);
      await sm.loadProfile();
      expect(sm.isProfileDirty()).toBe(false);
    });

    it('should keep isDirty when loadProfile falls back to storage', async () => {
      const storedProfile = { description: 'Stored', skills: 'Skills', portfolioItems: [], lastSyncedAt: '2026-01-01T00:00:00Z', isDirty: true };
      const mockStorage = createMockStorage({ getProfile: vi.fn().mockResolvedValue(storedProfile) });
      const sm = new StateManager({ apiClient: createMockApi(), storage: mockStorage });
      await sm.loadProfile();
      expect(sm.isProfileDirty()).toBe(true);
    });

    it('syncProfile should push local changes when dirty and server is older', async () => {
      const serverProfile = { description: 'Old Server', skills: 'Old Skills', portfolioItems: [], lastSyncedAt: '2025-01-01T00:00:00Z' };
      const mockApi = createMockApi({
        loadProfile: vi.fn().mockResolvedValue(serverProfile),
        saveProfile: vi.fn().mockImplementation((p: ProfileState) => Promise.resolve(p))
      });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      // Set local as dirty with a later sync time
      sm.setProfile({ description: 'New Local', skills: 'Skills', portfolioItems: [] });
      (sm as any).profileWithSync.lastSyncedAt = '2025-06-01T00:00:00Z';
      const result = await sm.syncProfile();
      expect(result).toBe('pushed');
      expect(mockApi.saveProfile).toHaveBeenCalled();
    });

    it('syncProfile should pull from server when server is newer', async () => {
      const serverProfile = { description: 'New Server', skills: 'New Skills', portfolioItems: [], lastSyncedAt: '2026-06-01T00:00:00Z' };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(serverProfile) });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      sm.setProfile({ description: 'Old Local', skills: 'Old', portfolioItems: [] });
      (sm as any).profileWithSync.lastSyncedAt = '2025-01-01T00:00:00Z';
      const result = await sm.syncProfile();
      expect(result).toBe('conflict-server-wins');
      expect(sm.getProfile().description).toBe('New Server');
    });

    it('syncProfile should return no-change when neither side changed', async () => {
      const serverProfile = { description: 'Same', skills: 'Same', portfolioItems: [], lastSyncedAt: '2026-01-01T00:00:00Z' };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(serverProfile) });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      // Not dirty, same sync time
      (sm as any).profileWithSync.lastSyncedAt = '2026-01-01T00:00:00Z';
      const result = await sm.syncProfile();
      expect(result).toBe('no-change');
    });

    it('syncProfile should push when no server profile and local is dirty', async () => {
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(null) });
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      sm.setProfile({ description: 'Only Local', skills: 'Skills', portfolioItems: [] });
      const result = await sm.syncProfile();
      expect(result).toBe('pushed');
    });

    it('syncProfile should pull when local is clean but server updated', async () => {
      const serverProfile = { description: 'Updated Server', skills: 'Skills', portfolioItems: [], lastSyncedAt: '2026-03-01T00:00:00Z' };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(serverProfile) });
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      (sm as any).profileWithSync.lastSyncedAt = '2026-01-01T00:00:00Z';
      const result = await sm.syncProfile();
      expect(result).toBe('pulled');
      expect(sm.getProfile().description).toBe('Updated Server');
    });

    it('attemptSync should do nothing when profile is not dirty', async () => {
      const mockApi = createMockApi();
      const sm = new StateManager({ apiClient: mockApi, storage: createMockStorage() });
      await sm.attemptSync();
      expect(mockApi.loadProfile).not.toHaveBeenCalled();
    });

    it('attemptSync should sync when profile is dirty', async () => {
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(null) });
      const mockStorage = createMockStorage();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      sm.setProfile({ description: 'Local', skills: 'Skills', portfolioItems: [] });
      await sm.attemptSync();
      expect(mockApi.loadProfile).toHaveBeenCalled();
    });

    it('initializeStorage should attempt background sync when profile is dirty', async () => {
      const storedProfile = { description: 'Stored', skills: 'Skills', portfolioItems: [], lastSyncedAt: '2026-01-01T00:00:00Z', isDirty: true };
      const mockApi = createMockApi({ loadProfile: vi.fn().mockResolvedValue(null) });
      const mockStorage = createMockStorage({
        getProfile: vi.fn().mockResolvedValue(storedProfile),
        getCache: vi.fn().mockResolvedValue([])
      });
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      await sm.initializeStorage();
      // Give the background sync a moment
      await new Promise(r => setTimeout(r, 50));
      expect(mockApi.loadProfile).toHaveBeenCalled();
    });

    it('should persist sync metadata alongside profile', async () => {
      const mockStorage = createMockStorage();
      const mockApi = createMockApi();
      const sm = new StateManager({ apiClient: mockApi, storage: mockStorage });
      await sm.saveProfile({ description: 'Test', skills: 'Skills', portfolioItems: [] });
      const savedCall = mockStorage.saveProfile.mock.calls[0];
      const savedData = savedCall[0];
      expect(savedData.lastSyncedAt).toBeDefined();
      expect(savedData.isDirty).toBe(false);
    });
  });
});