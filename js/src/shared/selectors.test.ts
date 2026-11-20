import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionProxyTransport } from '../api';
import { handleApiProxyMessage } from '../background/api-proxy';
import {
  BUNDLED_SELECTORS,
  fetchAndCacheSelectors,
  getCachedSelectors,
  loadActiveSelectors,
} from './selectors';
import { apiUrlItem, authTokenItem, selectorsCacheItem, selectorsEtagItem } from './storage-items';

describe('Selector ETag Caching & Proxy Header Forwarding', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('suppresses If-None-Match when cache is empty or corrupt so 304 never strands empty cache', async () => {
    await selectorsEtagItem.setValue('"stale-etag-1"');
    await selectorsCacheItem.setValue(null);

    const seenHeaders: Array<Record<string, string>> = [];
    const mockFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      seenHeaders.push((init?.headers as Record<string, string>) ?? {});
      return new Response(JSON.stringify({ ...BUNDLED_SELECTORS, version: '2.1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"fresh-etag-2"' },
      });
    });

    const cfg = await fetchAndCacheSelectors(mockFetch);
    expect(seenHeaders[0]['If-None-Match']).toBeUndefined();
    expect(cfg.version).toBe('2.1');
    expect((await getCachedSelectors()).version).toBe('2.1');
    expect(await selectorsEtagItem.getValue()).toBe('"fresh-etag-2"');
  });

  it('sends If-None-Match when cache is valid and returns cached config on 304', async () => {
    const cachedCfg = { ...BUNDLED_SELECTORS, version: '2.5' };
    await selectorsCacheItem.setValue(cachedCfg);
    await selectorsEtagItem.setValue('"etag-25"');

    let capturedIfNoneMatch = '';
    const mockFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      capturedIfNoneMatch = h['If-None-Match'] ?? '';
      return new Response(null, { status: 304, statusText: 'Not Modified' });
    });

    const result = await fetchAndCacheSelectors(mockFetch);
    expect(capturedIfNoneMatch).toBe('"etag-25"');
    expect(result.version).toBe('2.5');
  });

  it('forwards ETag and X-Selector-Version through handleApiProxyMessage and createExtensionProxyTransport', async () => {
    await apiUrlItem.setValue('http://127.0.0.1:41234');
    await authTokenItem.setValue('tok-123');

    const mockFetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(BUNDLED_SELECTORS), {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': 'application/json',
          ETag: '"proxy-etag-99"',
          'X-Selector-Version': '2.0',
        },
      });
    }) as unknown as typeof fetch;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      return handleApiProxyMessage(msg as never, { fetchImpl: mockFetchImpl });
    });

    const transport = createExtensionProxyTransport();
    const res = await transport('/api/selectors?format=json', { method: 'GET' });
    expect(res.headers.get('ETag')).toBe('"proxy-etag-99"');
    expect(res.headers.get('X-Selector-Version')).toBe('2.0');
  });

  it('loadActiveSelectors queries BG_SELECTORS_GET and falls back to cached/bundled selectors', async () => {
    const sendSpy = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      ok: true,
      selectors: { ...BUNDLED_SELECTORS, version: '2.9' },
    }));

    const loaded = await loadActiveSelectors(true);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'BG_SELECTORS_GET', forceRefresh: true });
    expect(loaded.version).toBe('2.9');

    sendSpy.mockRejectedValueOnce(new Error('Background asleep'));
    const fallback = await loadActiveSelectors();
    expect(fallback.version).toBe('2.0');
  });

  it('includes standalone [data-test="captcha-challenge"], 2FA selectors, and search/feed client-spend selectors', () => {
    const challengeSelectors = BUNDLED_SELECTORS.auth_and_challenge_guards?.challenge_selectors;
    expect(challengeSelectors).toContain("[data-test='captcha-challenge']");
    expect(challengeSelectors).toContain("[data-test='two-factor-challenge']");
    expect(challengeSelectors).toContain("input[name^='deviceAuth']");

    for (const viewName of ['search_listings', 'best_matches', 'most_recent', 'saved_jobs']) {
      const spendSelectors =
        BUNDLED_SELECTORS.views[viewName]?.fields.client_spent?.selectors ?? [];
      expect(spendSelectors[0]).toBe("[data-qa='client-spend']");
      expect(spendSelectors[1]).toBe("[data-test='client-spend']");
    }
  });
});
