import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ApiClient, type ApiProxyRequestMessage, type ApiProxyResponseMessage } from './api';
import type {
  AnalysisResponse,
  JobInfo,
  ProfileApiResponse,
  ProfileState,
  SyncedProfile,
} from './types';

describe('ApiClient', () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fakeBrowser.reset();
    client = new ApiClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper to mock fetch
  function mockFetch(
    response: { ok: boolean; status: number; statusText?: string; json?: () => Promise<unknown> },
    rejectWith?: Error,
  ) {
    if (rejectWith) {
      globalThis.fetch = vi.fn().mockRejectedValue(rejectWith);
    } else {
      globalThis.fetch = vi.fn().mockResolvedValue(response);
    }
  }

  describe('analyzeJob', () => {
    const jobInfo: JobInfo = {
      title: 'Build a React App',
      description: 'Need a professional React application with TypeScript',
      contractType: 'fixed',
      rateRange: '',
      rateMin: '',
      rateMax: '',
      budgetAmount: '$3000',
      experienceLevel: '',
      budget: '$3000 fixed',
      skills: 'React, TypeScript',
    };

    const successResponse: AnalysisResponse = {
      proposal: 'Dear Client, I would love to help...',
      execution_prompt: 'Create a React app with TypeScript',
      time_estimate: '2-3 weeks',
      workload_division: 'Split into components',
      questions_for_client: 'Do you have design files?',
      tips_and_advice: 'Use Next.js for SSR',
      tone_analysis: 'Professional',
    };

    it('should return analysis on success', async () => {
      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve(successResponse),
      });

      const result = await client.analyzeJob(jobInfo, 'senior dev', 'React, TypeScript');
      expect(result.proposal).toBe('Dear Client, I would love to help...');
      expect(result.time_estimate).toBe('2-3 weeks');
      expect(result.tone_analysis).toBe('Professional');
    });

    it('should send correct payload in request body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(successResponse),
      });
      globalThis.fetch = fetchSpy;

      await client.analyzeJob(jobInfo, 'senior dev', 'React');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/analyze-job');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.job_title).toBe('Build a React App');
      expect(body.job_description).toBe('Need a professional React application with TypeScript');
      expect(body.contract_type).toBe('fixed');
      expect(body.budget).toBe('$3000 fixed');
      expect(body.skills).toBe('React, TypeScript');
      expect(body.user_profile).toBe('senior dev');
      expect(body.user_skills).toBe('React');
    });

    it('should throw on non-200 response', async () => {
      mockFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      });

      await expect(client.analyzeJob(jobInfo, 'senior dev', 'React')).rejects.toThrow(
        'API error: 500 Internal Server Error',
      );
    });

    it('should throw on 401 response', async () => {
      mockFetch({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({}),
      });

      await expect(client.analyzeJob(jobInfo, 'senior dev', 'React')).rejects.toThrow(
        'API error: 401 Unauthorized',
      );
    });

    it('should throw on network error', async () => {
      mockFetch({ ok: false, status: 0 }, new Error('Network error'));

      await expect(client.analyzeJob(jobInfo, 'senior dev', 'React')).rejects.toThrow(
        'Network error',
      );
    });
  });

  describe('loadProfile', () => {
    it('should return mapped profile on success', async () => {
      const apiResponse: ProfileApiResponse = {
        description: 'Senior developer',
        skills: 'React, Go',
        portfolio_items: [
          { title: 'Project 1', link: 'https://example.com', description: 'A great project' },
        ],
      };

      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve(apiResponse),
      });

      const result = await client.loadProfile();
      expect(result).not.toBeNull();
      expect(result!.description).toBe('Senior developer');
      expect(result!.skills).toBe('React, Go');
      expect(result!.portfolioItems).toHaveLength(1);
      expect(result!.portfolioItems[0].title).toBe('Project 1');
    });

    it('should handle portfolioItems (camelCase) field', async () => {
      const apiResponse: ProfileApiResponse = {
        description: 'Dev',
        skills: 'Python',
        portfolioItems: [{ title: 'Proj', link: 'https://x.com', description: 'Desc' }],
      };

      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve(apiResponse),
      });

      const result = await client.loadProfile();
      expect(result!.portfolioItems).toHaveLength(1);
    });

    it('should return null on non-OK response', async () => {
      mockFetch({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });

      const result = await client.loadProfile();
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      mockFetch({ ok: false, status: 0 }, new Error('Failed to fetch'));

      const result = await client.loadProfile();
      expect(result).toBeNull();
    });

    it('should handle empty response payload', async () => {
      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      const result = await client.loadProfile();
      expect(result).not.toBeNull();
      expect(result!.description).toBe('');
      expect(result!.skills).toBe('');
      expect(result!.portfolioItems).toEqual([]);
    });

    it('should handle missing portfolio items gracefully', async () => {
      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ description: 'No portfolio' }),
      });

      const result = await client.loadProfile();
      expect(result!.portfolioItems).toEqual([]);
    });
  });

  describe('saveProfile', () => {
    const profile: ProfileState = {
      description: 'Full-stack developer',
      skills: 'Go, React',
      portfolioItems: [
        { title: 'My Project', link: 'https://example.com', description: 'Great project' },
      ],
    };

    it('should save and return mapped profile on success', async () => {
      const apiResponse: ProfileApiResponse = {
        description: 'Full-stack developer',
        skills: 'Go, React',
        portfolio_items: [
          { title: 'My Project', link: 'https://example.com', description: 'Great project' },
        ],
      };

      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve(apiResponse),
      });

      const result = await client.saveProfile(profile);
      expect(result.description).toBe('Full-stack developer');
      expect(result.skills).toBe('Go, React');
      expect(result.portfolioItems).toHaveLength(1);
    });

    it('should send correct payload', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            description: 'Full-stack developer',
            skills: 'Go, React',
            portfolio_items: [],
          }),
      });
      globalThis.fetch = fetchSpy;

      await client.saveProfile(profile);

      const [_url, options] = fetchSpy.mock.calls[0];
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.description).toBe('Full-stack developer');
      expect(body.skills).toBe('Go, React');
      expect(body.portfolio_items).toHaveLength(1);
    });

    it('should throw on non-OK response', async () => {
      mockFetch({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({}),
      });

      await expect(client.saveProfile(profile)).rejects.toThrow(
        'Profile save failed: 400 Bad Request',
      );
    });

    it('should throw on 500 response', async () => {
      mockFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      });

      await expect(client.saveProfile(profile)).rejects.toThrow(
        'Profile save failed: 500 Internal Server Error',
      );
    });
  });

  describe('M1 Bug 9 & MV3 background proxy transport', () => {
    it('maps last_synced_at and updated_at into lastSyncedAt on loadProfile', async () => {
      const apiResponse: ProfileApiResponse = {
        description: 'Synced dev',
        skills: 'Go',
        portfolio_items: [],
        updated_at: '2026-11-19T12:00:00Z',
        last_synced_at: '2026-11-19T12:05:00Z',
      };

      mockFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve(apiResponse),
      });

      const result = (await client.loadProfile()) as SyncedProfile | null;
      expect(result).not.toBeNull();
      expect(result?.lastSyncedAt).toBe('2026-11-19T12:05:00Z');
      expect(result?.isDirty).toBe(false);
    });

    it('proxies API requests through browser.runtime.sendMessage when on https://www.upwork.com', async () => {
      const originalLocation = globalThis.location;
      Object.defineProperty(globalThis, 'location', {
        value: { protocol: 'https:', hostname: 'www.upwork.com' },
        writable: true,
        configurable: true,
      });

      const sendSpy = vi
        .spyOn(fakeBrowser.runtime, 'sendMessage')
        .mockImplementation(async (msg) => {
          const req = msg as unknown as ApiProxyRequestMessage;
          expect(req.type).toBe('API_PROXY_REQUEST');
          expect(req.method).toBe('GET');
          const payload = JSON.stringify({
            description: 'Proxied',
            skills: 'WXT',
            portfolio_items: [],
            lastSyncedAt: '2026-11-19T12:10:00Z',
          });
          const reply: ApiProxyResponseMessage = {
            ok: true,
            status: 200,
            statusText: 'OK',
            contentType: 'application/json',
            bodyBase64: Buffer.from(payload, 'utf8').toString('base64'),
          };
          return reply;
        });

      try {
        const loaded = (await client.loadProfile()) as SyncedProfile | null;
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(loaded?.description).toBe('Proxied');
        expect(loaded?.lastSyncedAt).toBe('2026-11-19T12:10:00Z');
      } finally {
        Object.defineProperty(globalThis, 'location', {
          value: originalLocation,
          writable: true,
          configurable: true,
        });
      }
    });

    it('downloadAgents returns a Blob on success', async () => {
      const zipBytes = new Uint8Array([80, 75, 3, 4]);
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(zipBytes, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        }),
      );

      const blob = await client.downloadAgents(['eloquent-model-agent']);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(4);
    });
  });
});
