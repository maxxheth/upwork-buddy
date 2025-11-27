import type { AnalysisCache, ProfileState } from './types';
import { CONFIG } from './types';

// Declare ambient globals for browser extension runtimes.
declare const chrome: {
  storage?: {
    sync?: ChromeStorageArea;
    local?: ChromeStorageArea;
  };
  runtime?: {
    lastError?: { message?: string };
  };
} | undefined;

declare const browser: {
  storage?: {
    sync?: BrowserStorageArea;
    local?: BrowserStorageArea;
  };
} | undefined;

type ChromeStorageArea = {
  get: (keys?: StorageKeys, callback?: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, callback?: () => void) => void;
  remove?: (keys: StorageKeys, callback?: () => void) => void;
};

type BrowserStorageArea = {
  get: (keys?: StorageKeys) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

type StorageKeys = string | string[] | Record<string, unknown> | undefined;

type PromisifiedStorageArea = {
  get: (keys?: StorageKeys) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

const PROFILE_STORAGE_KEY = CONFIG.profileStorageKey;
const CACHE_STORAGE_KEY = 'upworkBuddyCachedJobs';

/**
 * StorageAdapter centralizes persistence so the content script can use
 * chrome.storage/browser.storage when running as an extension while still
 * falling back to localStorage when injected as a bookmarklet or during tests.
 */
export class StorageAdapter {
  private readonly extensionStorage: PromisifiedStorageArea | null;

  constructor() {
    this.extensionStorage = resolveExtensionStorage();
  }

  async saveProfile(profile: ProfileState): Promise<void> {
    if (this.extensionStorage) {
      await this.extensionStorage.set({ [PROFILE_STORAGE_KEY]: profile });
      return;
    }
    persistWithLocalStorage(PROFILE_STORAGE_KEY, profile);
  }

  async getProfile(): Promise<ProfileState | null> {
    if (this.extensionStorage) {
      const result = await this.extensionStorage.get(PROFILE_STORAGE_KEY);
      return (result?.[PROFILE_STORAGE_KEY] as ProfileState) ?? null;
    }
    return readFromLocalStorage<ProfileState>(PROFILE_STORAGE_KEY);
  }

  async saveCache(entries: Array<[string, AnalysisCache]>): Promise<void> {
    if (this.extensionStorage) {
      await this.extensionStorage.set({ [CACHE_STORAGE_KEY]: entries });
      return;
    }
    persistWithLocalStorage(CACHE_STORAGE_KEY, entries);
  }

  async getCache(): Promise<Array<[string, AnalysisCache]> | null> {
    if (this.extensionStorage) {
      const result = await this.extensionStorage.get(CACHE_STORAGE_KEY);
      return (result?.[CACHE_STORAGE_KEY] as Array<[string, AnalysisCache]>) ?? null;
    }
    return readFromLocalStorage<Array<[string, AnalysisCache]>>(CACHE_STORAGE_KEY);
  }

  async clearCache(): Promise<void> {
    if (this.extensionStorage) {
      await this.extensionStorage.set({ [CACHE_STORAGE_KEY]: [] });
      return;
    }
    persistWithLocalStorage(CACHE_STORAGE_KEY, []);
  }
}

function resolveExtensionStorage(): PromisifiedStorageArea | null {
  const browserApi = typeof browser === 'undefined' ? undefined : browser;
  const chromeApi = typeof chrome === 'undefined' ? undefined : chrome;

  const browserArea = browserApi?.storage?.sync ?? browserApi?.storage?.local;
  if (browserArea) {
    return browserArea;
  }

  const chromeArea = chromeApi?.storage?.sync ?? chromeApi?.storage?.local;
  if (chromeArea) {
    return wrapChromeStorage(chromeArea);
  }

  return null;
}

function wrapChromeStorage(area: ChromeStorageArea): PromisifiedStorageArea {
  return {
    get: (keys?: StorageKeys) => new Promise(resolve => {
      area.get(keys, items => {
        const chromeApi = typeof chrome === 'undefined' ? undefined : chrome;
        if (chromeApi?.runtime?.lastError) {
          console.warn('Chrome storage get failed', chromeApi.runtime.lastError.message);
          resolve({});
          return;
        }
        resolve(items ?? {});
      });
    }),
    set: (items: Record<string, unknown>) => new Promise((resolve, reject) => {
      area.set(items, () => {
        const chromeApi = typeof chrome === 'undefined' ? undefined : chrome;
        if (chromeApi?.runtime?.lastError) {
          const message = chromeApi.runtime.lastError.message ?? 'Unknown chrome.storage error';
          console.warn('Chrome storage set failed', message);
          reject(new Error(message));
          return;
        }
        resolve();
      });
    })
  };
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
