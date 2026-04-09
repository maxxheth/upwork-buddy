import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectEnvironment,
  loadConfig,
  CONFIG,
  type CustomConfigOverrides,
} from './types';

// Minimal localStorage mock for detectEnvironment tests
const localStorageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = value; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};

describe('detectEnvironment', () => {
  // Save originals so we can restore after each test
  const originalLocation = globalThis.location;
  const originalChrome = (globalThis as any).chrome;

  afterEach(() => {
    // Clean up localStorage mock
    mockLocalStorage.clear();
    // Restore location
    if (originalLocation === undefined) {
      delete (globalThis as any).location;
    } else {
      (globalThis as any).location = originalLocation;
    }
    // Restore chrome
    if (originalChrome === undefined) {
      delete (globalThis as any).chrome;
    } else {
      (globalThis as any).chrome = originalChrome;
    }
  });

  it('returns "development" when hostname is localhost', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('returns "development" when hostname is 127.0.0.1', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: '127.0.0.1' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('returns "development" when hostname ends with .local', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'myproj.local' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('returns "staging" when hostname contains "staging"', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'staging.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('staging');
  });

  it('returns "staging" when hostname contains "preprod"', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'preprod.example.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('staging');
  });

  it('returns "staging" when hostname ends with .staging', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'api.staging' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('staging');
  });

  it('returns "production" for any other non-empty hostname', () => {
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'www.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('production');
  });

  it('returns "development" as fallback when location is unavailable', () => {
    mockLocalStorage.clear();
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    delete (globalThis as any).location;
    expect(detectEnvironment()).toBe('development');
  });

  // ── localStorage override ────────────────────────────────────────────

  it('returns "development" when localStorage has "local"', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'local');
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'www.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('returns "development" when localStorage has "development"', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'development');
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'www.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('returns "staging" when localStorage has "staging"', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'staging');
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'www.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('staging');
  });

  it('returns "production" when localStorage has "production"', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'production');
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    // localStorage override takes priority over hostname
    expect(detectEnvironment()).toBe('production');
  });

  it('localStorage override takes priority over chrome manifest', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'development');
    vi.stubGlobal('localStorage', mockLocalStorage);
    (globalThis as any).chrome = {
      runtime: {
        getManifest: () => ({ upwork_buddy_env: 'production' }),
      },
    };
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'www.upwork.com' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('ignores invalid localStorage value and falls through to hostname', () => {
    mockLocalStorage.setItem('upwork_buddy_env', 'nonsense');
    vi.stubGlobal('localStorage', mockLocalStorage);
    delete (globalThis as any).chrome;
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });

  it('uses chrome manifest upwork_buddy_env when available', () => {
    (globalThis as any).chrome = {
      runtime: {
        getManifest: () => ({ upwork_buddy_env: 'production' }),
      },
    };
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    // Manifest takes priority over hostname
    expect(detectEnvironment()).toBe('production');
  });

  it('ignores invalid chrome manifest env value', () => {
    (globalThis as any).chrome = {
      runtime: {
        getManifest: () => ({ upwork_buddy_env: 'invalid_env' }),
      },
    };
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    // Falls back to hostname-based detection
    expect(detectEnvironment()).toBe('development');
  });

  it('handles chrome.runtime.getManifest throwing', () => {
    (globalThis as any).chrome = {
      runtime: {
        getManifest: () => { throw new Error('not in extension context'); },
      },
    };
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    expect(detectEnvironment()).toBe('development');
  });
});

describe('loadConfig', () => {
  it('returns development config by default', () => {
    const config = loadConfig('development');
    expect(config.apiBaseUrl).toBe('http://localhost:9090');
    expect(config.env).toBe('development');
  });

  it('returns staging config when env is staging', () => {
    const config = loadConfig('staging');
    expect(config.apiBaseUrl).toBe('https://staging-api.upworkbuddy.app');
    expect(config.env).toBe('staging');
  });

  it('returns production config when env is production', () => {
    const config = loadConfig('production');
    expect(config.apiBaseUrl).toBe('https://api.upworkbuddy.app');
    expect(config.env).toBe('production');
  });

  it('falls back to development config for unknown env', () => {
    const config = loadConfig('unknown');
    expect(config.apiBaseUrl).toBe('http://localhost:9090');
    expect(config.env).toBe('unknown');
  });

  it('uses detected environment when env param is omitted', () => {
    // In jsdom the hostname is typically 'localhost'
    const config = loadConfig();
    expect(config.apiBaseUrl).toBe('http://localhost:9090');
    expect(config.env).toBe('development');
  });

  it('applies custom overrides for apiBaseUrl', () => {
    const overrides: CustomConfigOverrides = {
      apiBaseUrl: 'http://custom-host:8080',
    };
    const config = loadConfig('development', overrides);
    expect(config.apiBaseUrl).toBe('http://custom-host:8080');
    // Other fields should still come from the environment config
    expect(config.profileApiEndpoint).toBe('http://localhost:9090/api/profile');
  });

  it('applies all custom overrides', () => {
    const overrides: CustomConfigOverrides = {
      apiBaseUrl: 'http://custom:9090',
      profileApiEndpoint: 'http://custom:9090/api/profile',
      jobsApiEndpoint: 'http://custom:9090/api/jobs',
    };
    const config = loadConfig('production', overrides);
    expect(config.apiBaseUrl).toBe('http://custom:9090');
    expect(config.profileApiEndpoint).toBe('http://custom:9090/api/profile');
    expect(config.jobsApiEndpoint).toBe('http://custom:9090/api/jobs');
  });

  it('preserves defaults regardless of environment', () => {
    const config = loadConfig('production');
    expect(config.profileStorageKey).toBe('upworkBuddyProfileData');
    expect(config.defaultProfile).toContain('full-stack developer');
    expect(config.defaultSkills).toContain('Go');
  });
});

describe('CONFIG export (backward compatibility)', () => {
  it('has all required fields', () => {
    expect(CONFIG.apiBaseUrl).toBeDefined();
    expect(CONFIG.profileApiEndpoint).toBeDefined();
    expect(CONFIG.jobsApiEndpoint).toBeDefined();
    expect(CONFIG.profileStorageKey).toBeDefined();
    expect(CONFIG.defaultProfile).toBeDefined();
    expect(CONFIG.defaultSkills).toBeDefined();
    expect(CONFIG.env).toBeDefined();
  });

  it('defaults to development environment', () => {
    expect(CONFIG.apiBaseUrl).toBe('http://localhost:9090');
  });

  it('can be patched with Object.assign for runtime resolution', () => {
    const original = CONFIG.apiBaseUrl;
    Object.assign(CONFIG, { apiBaseUrl: 'http://patched:9999' });
    expect(CONFIG.apiBaseUrl).toBe('http://patched:9999');
    // Restore
    Object.assign(CONFIG, { apiBaseUrl: original });
  });
});