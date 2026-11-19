import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import type { AnalysisCache, CustomConfigOverrides, ProfileState } from './types';
import { CONFIG } from './types';

export const PROFILE_STORAGE_KEY = CONFIG.profileStorageKey;
export const CACHE_STORAGE_KEY = 'upworkBuddyCachedJobs';
export const CUSTOM_CONFIG_STORAGE_KEY = 'upworkBuddyCustomConfig';
export const ENV_OVERRIDE_STORAGE_KEY = 'upwork_buddy_env';

export const profileItem = storage.defineItem<ProfileState>(`local:${PROFILE_STORAGE_KEY}`);
export const cacheItem = storage.defineItem<Array<[string, AnalysisCache]>>(
  `local:${CACHE_STORAGE_KEY}`,
);
export const customConfigItem = storage.defineItem<CustomConfigOverrides>(
  `local:${CUSTOM_CONFIG_STORAGE_KEY}`,
);
export const envOverrideItem = storage.defineItem<string>(`local:${ENV_OVERRIDE_STORAGE_KEY}`);

function hasExtensionStorage(): boolean {
  try {
    return Boolean(browser?.storage?.local);
  } catch {
    return false;
  }
}

/**
 * StorageAdapter centralizes persistence using @wxt-dev/storage (`wxt/utils/storage`)
 * in extension / WxtVitest runtimes, with a localStorage fallback for plain web contexts.
 */
export class StorageAdapter {
  async saveProfile(profile: ProfileState): Promise<void> {
    if (hasExtensionStorage()) {
      await profileItem.setValue(profile);
      return;
    }
    persistWithLocalStorage(PROFILE_STORAGE_KEY, profile);
  }

  async getProfile(): Promise<ProfileState | null> {
    if (hasExtensionStorage()) {
      return await profileItem.getValue();
    }
    return readFromLocalStorage<ProfileState>(PROFILE_STORAGE_KEY);
  }

  async saveCache(entries: Array<[string, AnalysisCache]>): Promise<void> {
    if (hasExtensionStorage()) {
      await cacheItem.setValue(entries);
      return;
    }
    persistWithLocalStorage(CACHE_STORAGE_KEY, entries);
  }

  async getCache(): Promise<Array<[string, AnalysisCache]> | null> {
    if (hasExtensionStorage()) {
      return await cacheItem.getValue();
    }
    return readFromLocalStorage<Array<[string, AnalysisCache]>>(CACHE_STORAGE_KEY);
  }

  async clearCache(): Promise<void> {
    if (hasExtensionStorage()) {
      await cacheItem.setValue([]);
      return;
    }
    persistWithLocalStorage(CACHE_STORAGE_KEY, []);
  }

  async getCustomConfig(): Promise<CustomConfigOverrides | null> {
    if (hasExtensionStorage()) {
      return await customConfigItem.getValue();
    }
    return readFromLocalStorage<CustomConfigOverrides>(CUSTOM_CONFIG_STORAGE_KEY);
  }

  async saveCustomConfig(overrides: CustomConfigOverrides): Promise<void> {
    if (hasExtensionStorage()) {
      await customConfigItem.setValue(overrides);
      return;
    }
    persistWithLocalStorage(CUSTOM_CONFIG_STORAGE_KEY, overrides);
  }

  async getEnvOverride(): Promise<string | null> {
    if (hasExtensionStorage()) {
      return await envOverrideItem.getValue();
    }
    return readFromLocalStorage<string>(ENV_OVERRIDE_STORAGE_KEY);
  }

  async saveEnvOverride(env: string | null): Promise<void> {
    if (env === null) {
      if (hasExtensionStorage()) {
        await envOverrideItem.removeValue();
        return;
      }
      localStorage.removeItem(ENV_OVERRIDE_STORAGE_KEY);
      return;
    }
    if (hasExtensionStorage()) {
      await envOverrideItem.setValue(env);
      return;
    }
    persistWithLocalStorage(ENV_OVERRIDE_STORAGE_KEY, env);
  }
}

function persistWithLocalStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('Local storage write failed', error);
  }
}

function readFromLocalStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn('Local storage read failed', error);
    return null;
  }
}
