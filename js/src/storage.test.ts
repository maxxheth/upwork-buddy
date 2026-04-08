import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageAdapter } from './storage';

/**
 * The jsdom test environment doesn't provide a functional localStorage
 * (only getItem/setItem), so we mock the StorageAdapter methods directly
 * to test the custom config persistence logic.
 */

describe('StorageAdapter custom config', () => {
  let storage: StorageAdapter;
  const store: Record<string, string> = {};

  beforeEach(() => {
    // Mock the StorageAdapter instance methods to use an in-memory store
    storage = Object.create(StorageAdapter.prototype) as StorageAdapter;

    storage.getCustomConfig = vi.fn(async () => {
      const raw = store['upworkBuddyCustomConfig'];
      return raw ? JSON.parse(raw) : null;
    });

    storage.saveCustomConfig = vi.fn(async (overrides: Record<string, string>) => {
      store['upworkBuddyCustomConfig'] = JSON.stringify(overrides);
    });

    // Clear the store between tests
    for (const key of Object.keys(store)) {
      delete store[key];
    }
  });

  it('getCustomConfig returns null when no overrides have been saved', async () => {
    const result = await storage.getCustomConfig();
    expect(result).toBeNull();
  });

  it('saveCustomConfig persists overrides and getCustomConfig retrieves them', async () => {
    const overrides = {
      apiBaseUrl: 'http://custom-host:8080',
      profileApiEndpoint: 'http://custom-host:8080/api/profile',
    };

    await storage.saveCustomConfig(overrides);
    const retrieved = await storage.getCustomConfig();

    expect(retrieved).not.toBeNull();
    expect(retrieved!.apiBaseUrl).toBe('http://custom-host:8080');
    expect(retrieved!.profileApiEndpoint).toBe('http://custom-host:8080/api/profile');
  });

  it('saveCustomConfig overwrites previous overrides', async () => {
    await storage.saveCustomConfig({ apiBaseUrl: 'http://old:9090' });
    await storage.saveCustomConfig({ apiBaseUrl: 'http://new:9090' });

    const result = await storage.getCustomConfig();
    expect(result!.apiBaseUrl).toBe('http://new:9090');
  });

  it('saves and retrieves overrides with all optional fields', async () => {
    const overrides = {
      apiBaseUrl: 'http://all-fields:9090',
      profileApiEndpoint: 'http://all-fields:9090/api/profile',
      jobsApiEndpoint: 'http://all-fields:9090/api/jobs',
    };

    await storage.saveCustomConfig(overrides);
    const result = await storage.getCustomConfig();

    expect(result).toEqual(overrides);
  });

  it('handles partial overrides (only apiBaseUrl)', async () => {
    const overrides = { apiBaseUrl: 'http://partial:3000' };
    await storage.saveCustomConfig(overrides);

    const result = await storage.getCustomConfig();
    expect(result!.apiBaseUrl).toBe('http://partial:3000');
    expect(result!.profileApiEndpoint).toBeUndefined();
    expect(result!.jobsApiEndpoint).toBeUndefined();
  });
});