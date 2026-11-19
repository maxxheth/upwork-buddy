import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { StateManager } from './state';
import {
  CACHE_STORAGE_KEY,
  CUSTOM_CONFIG_STORAGE_KEY,
  ENV_OVERRIDE_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  StorageAdapter,
} from './storage';
import type { AnalysisCache, CustomConfigOverrides, ProfileState } from './types';

describe('StorageAdapter (WXT @wxt-dev/storage + fakeBrowser)', () => {
  let storage: StorageAdapter;

  beforeEach(() => {
    fakeBrowser.reset();
    storage = new StorageAdapter();
  });

  it('saveProfile and getProfile round-trip via browser.storage.local', async () => {
    const profile: ProfileState = {
      description: 'Senior Go & TS Engineer',
      skills: 'Go, TypeScript, WXT',
      portfolioItems: [
        { title: 'Upwork Buddy', link: 'https://example.com', description: 'AI extension' },
      ],
    };

    expect(await storage.getProfile()).toBeNull();
    await storage.saveProfile(profile);

    const loaded = await storage.getProfile();
    expect(loaded).toEqual(profile);

    const raw = await fakeBrowser.storage.local.get(PROFILE_STORAGE_KEY);
    expect(raw[PROFILE_STORAGE_KEY]).toEqual(profile);
  });

  it('saveCache, getCache, and clearCache persist and clear entries', async () => {
    const entry: AnalysisCache = {
      cacheKey: 'Build App||Need a React developer',
      timestamp: '2026-11-19T12:00:00Z',
      jobInfo: {
        title: 'Build App',
        description: 'Need a React developer',
        contractType: 'fixed',
        rateRange: '',
        rateMin: '',
        rateMax: '',
        budgetAmount: '$2000',
        budget: '$2000 fixed',
        experienceLevel: 'Expert',
        skills: 'React',
      },
      analysis: { proposal: 'Hello' },
    };

    expect(await storage.getCache()).toBeNull();
    await storage.saveCache([[entry.cacheKey, entry]]);

    const loaded = await storage.getCache();
    expect(loaded).toHaveLength(1);
    expect(loaded?.[0]?.[0]).toBe(entry.cacheKey);

    const raw = await fakeBrowser.storage.local.get(CACHE_STORAGE_KEY);
    expect(raw[CACHE_STORAGE_KEY]).toHaveLength(1);

    await storage.clearCache();
    expect(await storage.getCache()).toEqual([]);
  });

  it('getCustomConfig returns null when no overrides have been saved', async () => {
    const result = await storage.getCustomConfig();
    expect(result).toBeNull();
  });

  it('saveCustomConfig persists overrides and getCustomConfig retrieves them', async () => {
    const overrides: CustomConfigOverrides = {
      apiBaseUrl: 'http://custom-host:8080',
      profileApiEndpoint: 'http://custom-host:8080/api/profile',
    };

    await storage.saveCustomConfig(overrides);
    const retrieved = await storage.getCustomConfig();

    expect(retrieved).toEqual(overrides);
    const raw = await fakeBrowser.storage.local.get(CUSTOM_CONFIG_STORAGE_KEY);
    expect(raw[CUSTOM_CONFIG_STORAGE_KEY]).toEqual(overrides);
  });

  it('saveCustomConfig overwrites previous overrides', async () => {
    await storage.saveCustomConfig({ apiBaseUrl: 'http://old:9090' });
    await storage.saveCustomConfig({ apiBaseUrl: 'http://new:9090' });

    const result = await storage.getCustomConfig();
    expect(result?.apiBaseUrl).toBe('http://new:9090');
  });

  it('saves and retrieves overrides with all optional fields', async () => {
    const overrides: CustomConfigOverrides = {
      apiBaseUrl: 'http://all-fields:9090',
      profileApiEndpoint: 'http://all-fields:9090/api/profile',
      jobsApiEndpoint: 'http://all-fields:9090/api/jobs',
    };

    await storage.saveCustomConfig(overrides);
    expect(await storage.getCustomConfig()).toEqual(overrides);
  });

  it('handles partial overrides (only apiBaseUrl)', async () => {
    const overrides: CustomConfigOverrides = { apiBaseUrl: 'http://partial:3000' };
    await storage.saveCustomConfig(overrides);

    const result = await storage.getCustomConfig();
    expect(result?.apiBaseUrl).toBe('http://partial:3000');
    expect(result?.profileApiEndpoint).toBeUndefined();
    expect(result?.jobsApiEndpoint).toBeUndefined();
  });

  it('saveEnvOverride sets and removes the key cleanly when null is passed', async () => {
    expect(await storage.getEnvOverride()).toBeNull();

    await storage.saveEnvOverride('staging');
    expect(await storage.getEnvOverride()).toBe('staging');

    await storage.saveEnvOverride(null);
    expect(await storage.getEnvOverride()).toBeNull();

    const raw = await fakeBrowser.storage.local.get(ENV_OVERRIDE_STORAGE_KEY);
    expect(raw[ENV_OVERRIDE_STORAGE_KEY]).toBeUndefined();
    const all = await fakeBrowser.storage.local.get(null);
    expect(ENV_OVERRIDE_STORAGE_KEY in all).toBe(false);
  });

  it('hydrates StateManager from real StorageAdapter persistence', async () => {
    const profile: ProfileState = {
      description: 'Hydrated Profile',
      skills: 'Go, WXT',
      portfolioItems: [],
    };
    await storage.saveProfile(profile);

    const sm = new StateManager({ storage: new StorageAdapter() });
    await sm.initializeStorage();

    expect(sm.getProfile()).toEqual(profile);
  });
});
