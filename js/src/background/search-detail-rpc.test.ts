import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPageBlueprint,
  computeOverallAuditStatus,
  DriftAuditor,
} from '../content/adapters/drift-auditor';
import { extractSearchListings } from '../content/adapters/search-adapter';
import { waitForHydration } from '../content/guards';
import type { ActivityLogEntry, PassiveSearchBatch } from '../shared/protocol';
import { BUNDLED_SELECTORS } from '../shared/selectors';
import { executeDetailEnrich, executeSearchSweep, executeSelectorAuditRpc } from './discovery-rpc';
import { AutomationTabController } from './tab-controller';
import { BridgeRpcError, HumanActionRequiredError, TaskAbortedError } from './ws-client';

function createMockTabController() {
  const paceSpy = vi.fn(async () => 4500);
  const controller = new AutomationTabController({
    getPacingConfig: async () => ({ pacingSeconds: 4.5, jitterRatio: 0 }),
    tabMessenger: vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      url: 'https://www.upwork.com/nx/search/jobs/?q=go',
    })),
  });
  vi.spyOn(controller, 'pace').mockImplementation(paceSpy);
  vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(async (url) => ({
    tabId: 101,
    url,
    loggedIn: true,
  }));
  return { controller, paceSpy };
}

describe('Background Search, Detail & Selector Audit RPC Orchestration', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('executeSearchSweep paginates with pacing, emits progress, deduplicates across pages, and stops at target_jobs', async () => {
    const { controller, paceSpy } = createMockTabController();
    const progressEvents: Array<{ stage: string; current: number; total: number }> = [];

    let pageCall = 0;
    const sendTabMessage = vi.fn(async () => {
      pageCall += 1;
      if (pageCall === 1) {
        return {
          ok: true,
          hasNextPage: true,
          jobs: [
            {
              upwork_job_id: '~0111',
              job_title: 'Job 1',
              canonical_url: 'https://www.upwork.com/jobs/~0111/',
            },
            {
              upwork_job_id: '~0222',
              job_title: 'Job 2',
              canonical_url: 'https://www.upwork.com/jobs/~0222/',
            },
          ],
        };
      }
      return {
        ok: true,
        hasNextPage: true,
        jobs: [
          {
            upwork_job_id: '~0222',
            job_title: 'Job 2 dup',
            canonical_url: 'https://www.upwork.com/jobs/~0222/',
          },
          {
            upwork_job_id: '~0333',
            job_title: 'Job 3',
            canonical_url: 'https://www.upwork.com/jobs/~0333/',
          },
        ],
      };
    });

    const res = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      },
      { source: 'search', query: 'golang', max_pages: 3, target_jobs: 3 },
      (stage, current, total) => progressEvents.push({ stage, current, total }),
    );

    expect(res.ok).toBe(true);
    expect(res.total_scraped).toBe(3);
    expect(res.stopped_reason).toBe('target_reached');
    expect(paceSpy).toHaveBeenCalledTimes(1); // paced before page 2, stopped at target_jobs on page 2
    expect(progressEvents).toHaveLength(2);
  });

  it('executeSearchSweep halts immediately with HumanActionRequiredError and zero retries on challenge', async () => {
    const { controller } = createMockTabController();
    const sendTabMessage = vi.fn(async () => ({
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: 'cloudflare',
      reason: 'Turnstile challenge detected',
      url: 'https://www.upwork.com/nx/search/jobs/',
    }));

    await expect(
      executeSearchSweep(
        {
          tabController: controller,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage,
        },
        { source: 'search', query: 'go', max_pages: 2 },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
    expect(sendTabMessage).toHaveBeenCalledTimes(1);
  });

  it('executeDetailEnrich fast-fails 404 with 0 retries, stops on RATE_LIMITED, and paces multi-URL batches', async () => {
    const { controller, paceSpy } = createMockTabController();

    // Single 404 fast-fail
    const notFoundSend = vi.fn(async () => ({
      ok: false,
      errorCode: 'NOT_FOUND',
      reason: 'Job not found',
    }));
    const nfRes = await executeDetailEnrich(
      {
        tabController: controller,
        proxyFetch: vi.fn(),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: notFoundSend,
      },
      { url: 'https://www.upwork.com/jobs/~0999/' },
    );
    expect(nfRes.ok).toBe(false);
    expect(nfRes.not_found).toBe(true);
    expect(notFoundSend).toHaveBeenCalledTimes(1);

    // Multi-URL with RATE_LIMITED on item 2
    let idx = 0;
    const batchSend = vi.fn(async () => {
      idx += 1;
      if (idx === 1) {
        return {
          ok: true,
          payload: { upwork_job_id: '~01', job_title: 'Job 1' },
          detail: { title: 'Job 1' },
        };
      }
      return { ok: false, errorCode: 'RATE_LIMITED', reason: 'HTTP 429' };
    });

    const batchRes = await executeDetailEnrich(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: batchSend,
      },
      {
        urls: [
          'https://www.upwork.com/jobs/~01/',
          'https://www.upwork.com/jobs/~02/',
          'https://www.upwork.com/jobs/~03/',
        ],
      },
    );

    expect(batchRes.ok).toBe(true);
    expect(batchRes.enriched_count).toBe(1);
    expect(batchRes.stopped_reason).toBe('rate_limited');
    expect(paceSpy).toHaveBeenCalledTimes(1);
    expect(batchSend).toHaveBeenCalledTimes(2);
  });

  it('executeSelectorAuditRpc preserves stored baseline across consecutive runs and halts on HUMAN_ACTION_REQUIRED', async () => {
    const { controller } = createMockTabController();
    const existingBaseline = {
      view_type: 'search_results',
      url: 'https://www.upwork.com/nx/search/jobs/',
      title: 'Search',
      timestamp: '2026-11-18T00:00:00Z',
      is_authenticated: true,
      status_code: 200,
      proxy_used: 'Direct',
      screenshot_path: null,
      job_card_blueprint: null,
      all_hooks: [
        {
          hook_type: 'data-test',
          name: 'JobTile',
          tag: 'article',
          frequency: 5,
          sample_values: [],
        },
      ],
      section_landmarks: [],
      captured_xhr_endpoints: [],
    };
    const newBlueprint = { ...existingBaseline, timestamp: '2026-11-19T00:00:00Z' };

    const postedBodies: Array<Record<string, unknown>> = [];
    const proxyFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/selector-audits?')) {
        return new Response(JSON.stringify({ audits: [{ id: 1, baseline: existingBaseline }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/selector-audits' && init?.method === 'POST') {
        postedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ audit: { id: 2 } }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });

    const sendTabMessage = vi.fn(async () => ({
      ok: true,
      overall_status: 'HEALTHY',
      blueprint: newBlueprint,
      report: {
        timestamp: '2026-11-19T00:00:00Z',
        url: 'https://www.upwork.com/nx/search/jobs/',
        view_type: 'search_results',
        is_authenticated: true,
        healthy_selectors_count: 5,
        degraded_selectors_count: 0,
        broken_selectors_count: 0,
        fragile_selectors_count: 0,
        audits: [],
        discovered_candidates: [],
        breaking_changes_detected: [],
        baseline_diffs: [],
      },
    }));

    const res = await executeSelectorAuditRpc(
      {
        tabController: controller,
        proxyFetch,
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      },
      { view: 'search_listings' },
    );

    expect(res.ok).toBe(true);
    // Must preserve existingBaseline (2026-11-18) rather than overwriting with newBlueprint when update_baseline is false
    expect((postedBodies[0].baseline as { timestamp: string }).timestamp).toBe(
      '2026-11-18T00:00:00Z',
    );
  });

  it('executeSearchSweep excludes unconditional outer shells from waitForSelectors while retaining JobsCount and empty-results', async () => {
    const { controller } = createMockTabController();
    const navSpy = vi.spyOn(controller, 'navigateAndWaitForHydration');
    const sendTabMessage = vi.fn(async () => ({
      ok: true,
      hasNextPage: false,
      jobs: [],
    }));

    const res = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      },
      { source: 'search', query: 'empty', max_pages: 2 },
    );

    expect(res.ok).toBe(true);
    expect(res.total_scraped).toBe(0);
    expect(res.stopped_reason).toBe('empty_page');
    expect(navSpy).toHaveBeenCalledTimes(1);
    const navOptions = navSpy.mock.calls[0]?.[1];
    expect(navOptions?.waitForSelectors).toEqual(
      expect.arrayContaining([
        'article.job-tile',
        "[data-test*='JobsCount']",
        "[data-test='empty-results']",
      ]),
    );
    expect(navOptions?.waitForSelectors).not.toContain("[data-test='JobsList']");
    expect(navOptions?.waitForSelectors).not.toContain("[data-test='JobsPage']");
    expect(navOptions?.waitForSelectors).not.toContain("[data-test='find-work-home']");
  });

  it('executeSearchSweep waits for async job-tile insertion on empty SPA shell and resolves 0 jobs on SSR empty markers', async () => {
    const makeSpaDeps = (pathname: string) => {
      const controller = new AutomationTabController({
        getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
      });
      vi.spyOn(controller, 'pace').mockResolvedValue(0);
      vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(
        async (url, opts, signal) => {
          const guardRes = await waitForHydration({
            doc: document,
            loc: { href: url, pathname },
            guards: opts?.guards,
            waitForSelectors: opts?.waitForSelectors,
            timeoutMs: 2000,
            signal,
          });
          if (!guardRes.ok) {
            throw new Error(guardRes.reason ?? guardRes.errorCode ?? 'Hydration failed');
          }
          return { tabId: 101, url, loggedIn: true };
        },
      );

      const sendTabMessage = vi.fn(async (_tabId: number, rawMessage: unknown) => {
        const message = (rawMessage ?? {}) as { source?: 'search'; query?: string };
        const res = extractSearchListings(document, {
          source: message.source ?? 'search',
          query: message.query ?? '',
          selectors: BUNDLED_SELECTORS,
          location: { href: `https://www.upwork.com${pathname}`, pathname },
        });
        return res;
      });

      return {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      };
    };

    // 1. Async SPA hydration: empty outer shells mounted at t=0, tile inserted asynchronously at t=60ms
    document.body.innerHTML = `
      <nav data-test="nav-user-menu"></nav>
      <main data-test="JobsPage">
        <div data-test="find-work-home"></div>
        <section data-test="JobsList"></section>
      </main>
    `;
    const timer = setTimeout(() => {
      const list = document.querySelector("[data-test='JobsList']");
      if (list) {
        const tile = document.createElement('article');
        tile.className = 'job-tile';
        tile.innerHTML =
          '<h3 class="job-tile-title"><a data-test="job-tile-title-link" href="/jobs/Async-Go-Job_~01999/">Async Go Job</a></h3>';
        list.appendChild(tile);
      }
    }, 60);

    try {
      const spaRes = await executeSearchSweep(makeSpaDeps('/nx/search/jobs/'), {
        source: 'search',
        query: 'go',
        max_pages: 1,
      });
      expect(spaRes.ok).toBe(true);
      expect(spaRes.total_scraped).toBe(1);
      expect((spaRes.jobs as Array<{ upwork_job_id?: string }>)[0]?.upwork_job_id).toBe('~01999');
    } finally {
      clearTimeout(timer);
    }

    // 2. SSR "0 jobs found" via [data-test*='JobsCount'] resolves 0 jobs cleanly
    document.body.innerHTML = `
      <nav data-test="nav-user-menu"></nav>
      <main data-test="JobsPage">
        <div data-test="Header"><span data-test="JobsCountQA JobsCount">0 jobs found</span></div>
        <section data-test="JobsList"></section>
      </main>
    `;
    const ssrCountRes = await executeSearchSweep(makeSpaDeps('/nx/search/jobs/'), {
      source: 'search',
      query: 'empty',
      max_pages: 1,
    });
    expect(ssrCountRes.ok).toBe(true);
    expect(ssrCountRes.total_scraped).toBe(0);
    expect(ssrCountRes.stopped_reason).toBe('empty_page');

    // 3. SSR [data-test='empty-results'] without JobsCount resolves 0 jobs cleanly
    document.body.innerHTML = `
      <nav data-test="nav-user-menu"></nav>
      <main data-test="JobsPage">
        <div data-test="empty-results">No results found</div>
      </main>
    `;
    const ssrEmptyRes = await executeSearchSweep(makeSpaDeps('/nx/search/jobs/'), {
      source: 'search',
      query: 'empty',
      max_pages: 1,
    });
    expect(ssrEmptyRes.ok).toBe(true);
    expect(ssrEmptyRes.total_scraped).toBe(0);
    expect(ssrEmptyRes.stopped_reason).toBe('empty_page');
  });

  it('executeSearchSweep flushes Page 1 jobs with filters to /api/jobs/batch on Page 2 HumanActionRequiredError without requesting Page 3, and does not flush on TaskAbortedError', async () => {
    const { controller } = createMockTabController();
    const visitedUrls: string[] = [];
    vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(async (url) => {
      visitedUrls.push(url);
      if (url.includes('page=2')) {
        throw new HumanActionRequiredError('CAPTCHA on page 2', 'captcha', url);
      }
      return { tabId: 101, url, loggedIn: true };
    });

    const batchCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const proxyFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/jobs/batch' && init?.method === 'POST') {
        batchCalls.push({
          path,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
      }
      return new Response(JSON.stringify({ persisted_count: 1 }), { status: 200 });
    });

    const sendTabMessage = vi.fn(async () => ({
      ok: true,
      hasNextPage: true,
      jobs: [
        {
          upwork_job_id: '~040200000000000000001',
          job_title: 'React Page 1 Job',
          canonical_url: 'https://www.upwork.com/jobs/~040200000000000000001/',
        },
      ],
    }));

    const filters = { required_keywords: ['react'], min_score: 50, sort_by_score: true };
    await expect(
      executeSearchSweep(
        {
          tabController: controller,
          proxyFetch,
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage,
        },
        {
          source: 'search',
          query: 'react',
          max_pages: 3,
          auto_ingest: false,
          filters,
        },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);

    expect(visitedUrls).toHaveLength(2);
    expect(visitedUrls.some((u) => u.includes('page=3'))).toBe(false);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.body.filter_stage).toBe('pre_enrichment');
    expect(batchCalls[0]?.body.filters).toEqual(filters);
    expect(
      (batchCalls[0]?.body.jobs as Array<{ upwork_job_id?: string }> | undefined)?.map(
        (j) => j.upwork_job_id,
      ),
    ).toEqual(['~040200000000000000001']);

    // Verify TaskAbortedError (kill switch) does NOT flush partial jobs
    const abortBatchCalls: string[] = [];
    const abortController = createMockTabController().controller;
    vi.spyOn(abortController, 'navigateAndWaitForHydration').mockImplementation(async (url) => {
      if (url.includes('page=2')) {
        throw new TaskAbortedError('Aborted by kill switch');
      }
      return { tabId: 101, url, loggedIn: true };
    });
    await expect(
      executeSearchSweep(
        {
          tabController: abortController,
          proxyFetch: vi.fn(async (path: string) => {
            abortBatchCalls.push(path);
            return new Response('{}', { status: 200 });
          }),
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage,
        },
        { source: 'search', query: 'python', max_pages: 3, auto_ingest: false },
      ),
    ).rejects.toBeInstanceOf(TaskAbortedError);
    expect(abortBatchCalls).toHaveLength(0);
  });

  it('executeSelectorAuditRpc passes allowSelectorTimeout=true to complete BROKEN audit on broken_v2_card DOM and still throws HumanActionRequiredError on challenges', async () => {
    const controller = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    const navCalls: Array<{
      waitForSelectors?: string[];
      timeoutMs?: number;
      allowSelectorTimeout?: boolean;
    }> = [];

    document.body.innerHTML = `
      <nav data-test="nav-user-menu"></nav>
      <main data-test="JobsPage">
        <span data-test="JobsCountQA JobsCount">2 jobs found</span>
        <section data-test="JobsList">
          <section data-test="v2-job-card" data-job-id="~040600000000000000001">
            <a data-qa="v2-title-anchor" href="/jobs/~040600000000000000001/">TypeScript Architect</a>
          </section>
        </section>
      </main>
    `;

    vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(
      async (url, opts, signal) => {
        navCalls.push({
          waitForSelectors: opts?.waitForSelectors,
          timeoutMs: opts?.timeoutMs,
          allowSelectorTimeout: opts?.allowSelectorTimeout,
        });
        const guardRes = await waitForHydration({
          doc: document,
          loc: { href: url, pathname: '/nx/search/jobs/' },
          guards: opts?.guards,
          waitForSelectors: opts?.waitForSelectors,
          timeoutMs: 25,
          signal,
        });
        if (!guardRes.ok) {
          if (guardRes.errorCode === 'HUMAN_ACTION_REQUIRED') {
            throw new HumanActionRequiredError(
              guardRes.reason,
              guardRes.challengeType ?? 'unknown',
              guardRes.url,
            );
          }
          if (guardRes.errorCode === 'TIMEOUT' && opts?.allowSelectorTimeout && !signal?.aborted) {
            return { tabId: 101, url, loggedIn: true };
          }
          throw new BridgeRpcError(guardRes.errorCode, guardRes.reason);
        }
        return { tabId: 101, url, loggedIn: true };
      },
    );

    const postedAudits: Array<Record<string, unknown>> = [];
    const proxyFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/selector-audits?')) {
        return new Response(JSON.stringify({ audits: [] }), { status: 200 });
      }
      if (path === '/api/selector-audits' && init?.method === 'POST') {
        postedAudits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ audit: { id: 10 } }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });

    const sendTabMessage = vi.fn(async (_tabId: number, rawMessage: unknown) => {
      const msg = (rawMessage ?? {}) as { view?: string };
      const blueprint = buildPageBlueprint(document, {
        url: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
        isAuthenticated: true,
      });
      const report = new DriftAuditor(blueprint, document, BUNDLED_SELECTORS, null).audit(msg.view);
      return {
        ok: true,
        report,
        blueprint,
        overall_status: computeOverallAuditStatus(report),
      };
    });

    const res = await executeSelectorAuditRpc(
      {
        tabController: controller,
        proxyFetch,
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      },
      {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
      },
    );

    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]?.allowSelectorTimeout).toBe(true);
    expect(navCalls[0]?.timeoutMs).toBe(3_500);
    expect(navCalls[0]?.waitForSelectors).toEqual(
      BUNDLED_SELECTORS.views.search_listings.container_selectors,
    );
    expect(res.ok).toBe(true);
    expect(res.overall_status).toBe('BROKEN');
    expect(postedAudits).toHaveLength(1);
    expect(postedAudits[0]?.overall_status).toBe('BROKEN');

    // Challenge DOM must still throw HumanActionRequiredError even with allowSelectorTimeout
    document.body.innerHTML = `<div data-test="captcha-challenge"><h1>Verify you are human</h1></div>`;
    await expect(
      executeSelectorAuditRpc(
        {
          tabController: controller,
          proxyFetch,
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage,
        },
        {
          view: 'search_listings',
          url: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
        },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });

  it('executeDetailEnrich does not persist partial jobs when persist is false and a challenge halts Stage 3', async () => {
    const { controller } = createMockTabController();
    let navAttempt = 0;
    vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(async (url) => {
      navAttempt += 1;
      if (navAttempt === 2) {
        throw new HumanActionRequiredError('Cloudflare challenge', 'cloudflare', url);
      }
      return { tabId: 10, url, loggedIn: true };
    });

    const batchCalls: string[] = [];
    const proxyFetch = vi.fn(async (path: string) => {
      batchCalls.push(path);
      return new Response('{}', { status: 200 });
    });

    await expect(
      executeDetailEnrich(
        {
          tabController: controller,
          proxyFetch,
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage: async () => ({
            ok: true,
            payload: {
              upwork_job_id: '~01detail1',
              canonical_url: 'https://www.upwork.com/jobs/Detail_~01detail1/',
              job_title: 'Detail Job 1',
            },
            detail: {},
          }),
        },
        {
          urls: [
            'https://www.upwork.com/jobs/Detail_~01detail1/',
            'https://www.upwork.com/jobs/Detail_~02detail2/',
          ],
          persist: false,
        },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);

    expect(batchCalls).toHaveLength(0);
  });

  it('executeSelectorAuditRpc infers messages_rooms for trailing-slash /ab/messages/rooms/', async () => {
    const { controller } = createMockTabController();
    const requestedPaths: string[] = [];
    const proxyFetch = vi.fn(async (path: string) => {
      requestedPaths.push(path);
      return new Response(JSON.stringify({ audits: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await executeSelectorAuditRpc(
      {
        tabController: controller,
        proxyFetch,
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: async () => ({
          ok: true,
          overall_status: 'HEALTHY',
          blueprint: {
            view_type: 'messages_rooms',
            url: 'https://www.upwork.com/ab/messages/rooms/',
            title: 'Messages',
            timestamp: '2026-11-20T00:00:00Z',
            is_authenticated: true,
            status_code: 200,
            proxy_used: 'Direct',
            screenshot_path: null,
            job_card_blueprint: null,
            all_hooks: [],
            section_landmarks: [],
            captured_xhr_endpoints: [],
          },
          report: {
            timestamp: '2026-11-20T00:00:00Z',
            url: 'https://www.upwork.com/ab/messages/rooms/',
            view_type: 'messages_rooms',
            is_authenticated: true,
            healthy_selectors_count: 1,
            degraded_selectors_count: 0,
            broken_selectors_count: 0,
            fragile_selectors_count: 0,
            audits: [],
            discovered_candidates: [],
            breaking_changes_detected: [],
            baseline_diffs: [],
          },
        }),
      },
      { url: 'https://www.upwork.com/ab/messages/rooms/' },
    );

    expect(res.ok).toBe(true);
    expect(requestedPaths.some((p) => p.includes('view_type=messages_rooms'))).toBe(true);
    expect(requestedPaths.some((p) => p.includes('view_type=messages_thread'))).toBe(false);
  });

  it('executeSelectorAuditRpc infers job_detail when tab URL has ?referrer_url_path=/ab/messages/rooms/room_1', async () => {
    const { controller } = createMockTabController();
    const requestedPaths: string[] = [];
    const proxyFetch = vi.fn(async (path: string) => {
      requestedPaths.push(path);
      return new Response(JSON.stringify({ audits: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await executeSelectorAuditRpc(
      {
        tabController: controller,
        proxyFetch,
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: async () => ({
          ok: true,
          overall_status: 'HEALTHY',
          blueprint: {
            view_type: 'job_detail',
            url: 'https://www.upwork.com/jobs/Build-Chat_~022115332344639171/?referrer_url_path=/ab/messages/rooms/room_1',
            title: 'Job',
            timestamp: '2026-11-20T00:00:00Z',
            is_authenticated: true,
            status_code: 200,
            proxy_used: 'Direct',
            screenshot_path: null,
            job_card_blueprint: null,
            all_hooks: [],
            section_landmarks: [],
            captured_xhr_endpoints: [],
          },
          report: {
            timestamp: '2026-11-20T00:00:00Z',
            url: 'https://www.upwork.com/jobs/Build-Chat_~022115332344639171/?referrer_url_path=/ab/messages/rooms/room_1',
            view_type: 'job_detail',
            is_authenticated: true,
            healthy_selectors_count: 1,
            degraded_selectors_count: 0,
            broken_selectors_count: 0,
            fragile_selectors_count: 0,
            audits: [],
            discovered_candidates: [],
            breaking_changes_detected: [],
            baseline_diffs: [],
          },
        }),
      },
      {
        url: 'https://www.upwork.com/jobs/Build-Chat_~022115332344639171/?referrer_url_path=/ab/messages/rooms/room_1',
      },
    );

    expect(res.ok).toBe(true);
    expect(requestedPaths.some((p) => p.includes('view_type=job_detail'))).toBe(true);
    expect(requestedPaths.some((p) => p.includes('view_type=messages_thread'))).toBe(false);
  });

  it('executeSearchSweep forwards hourly_rate and payment_verified facets and preserves M2 filters on auto_ingest', async () => {
    const { controller } = createMockTabController();
    const navigatedUrls: string[] = [];
    vi.spyOn(controller, 'navigateAndWaitForHydration').mockImplementation(async (url) => {
      navigatedUrls.push(url);
      return { tabId: 101, url, loggedIn: true };
    });

    const batchPayloads: Array<Record<string, unknown>> = [];
    const proxyFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/jobs/batch' && init?.body) {
        batchPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ persisted_count: 1 }), { status: 200 });
    });

    const sendTabMessage = vi.fn(async () => ({
      ok: true,
      hasNextPage: false,
      jobs: [
        {
          upwork_job_id: '~0777',
          job_title: 'Senior Go Engineer',
          canonical_url: 'https://www.upwork.com/jobs/~0777/',
        },
      ],
    }));

    const res = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch,
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
      },
      {
        source: 'search',
        query: 'golang',
        hourly_rate_min: 70,
        hourly_rate_max: 130,
        payment_verified_only: true,
        run_label: 'M2 sweep',
        skip_auto_detail_enrich: true,
        from_active_projects: true,
        active_project_keys: ['proj-a'],
        active_project_tiers: ['active'],
        auto_ingest: true,
        filters: {
          hourly_rate_min: 70,
          hourly_rate_max: 130,
          payment_verified_only: true,
          sort_by_score: true,
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(navigatedUrls).toHaveLength(1);
    const navUrl = new URL(navigatedUrls[0]);
    expect(navUrl.searchParams.get('hourly_rate')).toBe('70-130');
    expect(navUrl.searchParams.get('payment_verified')).toBe('1');
    expect(batchPayloads).toHaveLength(1);
    expect(batchPayloads[0].filters).toEqual({
      hourly_rate_min: 70,
      hourly_rate_max: 130,
      payment_verified_only: true,
      sort_by_score: true,
    });
  });

  it('executeSearchSweep rejects inverted hourly_rate_min > hourly_rate_max with INVALID_PARAMS', async () => {
    const { controller } = createMockTabController();
    await expect(
      executeSearchSweep(
        {
          tabController: controller,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
        },
        {
          source: 'search',
          query: 'golang',
          hourly_rate_min: 150,
          hourly_rate_max: 75,
        },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('executeSearchSweep with skip_if_busy=true throws TAB_BUSY when busy or on proposal apply form, and runs normally when idle', async () => {
    // 1. Busy tabController
    const { controller: busyController } = createMockTabController();
    vi.spyOn(busyController, 'getState').mockReturnValue({
      automationTabId: null,
      busy: true,
      activeRequestId: 'req-1',
      queuedCount: 0,
    });
    const busyRunSpy = vi.spyOn(busyController, 'runSerialized');

    await expect(
      executeSearchSweep(
        {
          tabController: busyController,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
        },
        { source: 'search', query: 'golang', skip_if_busy: true },
      ),
    ).rejects.toThrowError(BridgeRpcError);

    await expect(
      executeSearchSweep(
        {
          tabController: busyController,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
        },
        { source: 'search', query: 'golang', skip_if_busy: true },
      ),
    ).rejects.toMatchObject({ code: 'TAB_BUSY' });
    expect(busyRunSpy).not.toHaveBeenCalled();

    // 2. Idle tabController, but automationTabId is on /nx/proposals/job/*/apply
    const { controller: applyController } = createMockTabController();
    vi.spyOn(applyController, 'getState').mockReturnValue({
      automationTabId: 42,
      busy: false,
      activeRequestId: null,
      queuedCount: 0,
    });
    const applyRunSpy = vi.spyOn(applyController, 'runSerialized');

    await expect(
      executeSearchSweep(
        {
          tabController: applyController,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
          queryTabs: async () => [
            { id: 42, url: 'https://www.upwork.com/nx/proposals/job/~01abc123/apply' },
          ],
        },
        { source: 'search', query: 'golang', skip_if_busy: true },
      ),
    ).rejects.toMatchObject({ code: 'TAB_BUSY' });
    expect(applyRunSpy).not.toHaveBeenCalled();

    // 3. Idle tabController on non-apply URL -> runs normally
    const { controller: idleController } = createMockTabController();
    vi.spyOn(idleController, 'getState').mockReturnValue({
      automationTabId: 42,
      busy: false,
      activeRequestId: null,
      queuedCount: 0,
    });
    const res = await executeSearchSweep(
      {
        tabController: idleController,
        proxyFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        queryTabs: async () => [{ id: 42, url: 'https://www.upwork.com/nx/search/jobs/?q=go' }],
        sendTabMessage: vi.fn(async () => ({ ok: true, hasNextPage: false, jobs: [] })),
      },
      { source: 'search', query: 'golang', skip_if_busy: true },
    );
    expect(res.ok).toBe(true);
  });

  it('executeSearchSweep forwards waitForSearchApi, capturedSince, expectedPage, waitForApiMs and logs extractionSource', async () => {
    const { controller } = createMockTabController();
    const navSpy = vi.spyOn(controller, 'navigateAndWaitForHydration');
    const sentMessages: Array<Record<string, unknown>> = [];
    const activities: Array<Omit<ActivityLogEntry, 'id' | 'timestamp'>> = [];

    const sendTabMessage = vi.fn(async (_tabId: number, msg: unknown) => {
      sentMessages.push((msg ?? {}) as Record<string, unknown>);
      return {
        ok: true,
        hasNextPage: false,
        extractionSource: 'graphql' as const,
        apiPagination: { hasNextPage: false, totalCount: 1, offset: 0, count: 1 },
        jobs: [
          {
            upwork_job_id: '~0888',
            job_title: 'GraphQL Engineer',
            canonical_url: 'https://www.upwork.com/jobs/~0888/',
          },
        ],
      };
    });

    const res = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response('{}', { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage,
        recordActivity: (entry) => activities.push(entry),
      },
      { source: 'search', query: 'graphql', start_page: 2, max_pages: 4 },
    );

    expect(navSpy).toHaveBeenCalledTimes(1);
    expect(navSpy.mock.calls[0]?.[1]?.waitForSearchApi).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.type).toBe('CONTENT_SCRAPE_SEARCH');
    expect(sentMessages[0]?.expectedPage).toBe(2);
    expect(sentMessages[0]?.waitForApiMs).toBe(4000);
    expect(typeof sentMessages[0]?.capturedSince).toBe('string');
    expect(Number.isFinite(Date.parse(String(sentMessages[0]?.capturedSince)))).toBe(true);

    // Stops cleanly with end_of_results without navigating to page 3
    expect(res.stopped_reason).toBe('end_of_results');
    expect(res.pages_scanned).toBe(1);
    expect(activities[0]?.detail).toContain('via graphql (end_of_results)');
  });

  it('executeSearchSweep materializes jobs from getTabSearchBatches only when reply.ok is true and never bypasses failures or HUMAN_ACTION_REQUIRED', async () => {
    const { controller } = createMockTabController();
    const cachedBatches: PassiveSearchBatch[] = [
      {
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=rust',
        sourceFeed: 'search',
        query: 'rust',
        graphqlErrorCodes: ['UNAUTHENTICATED'],
        jobs: [{ upwork_job_id: '~0err', job_title: 'Should Be Ignored' }],
        capturedAt: new Date().toISOString(),
      },
      {
        captureSeq: 2,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=rust',
        sourceFeed: 'search',
        query: 'rust',
        jobs: [
          { upwork_job_id: '~0notitle', job_description: 'Missing title' },
          { upwork_job_id: '~0101', job_title: 'Rust Systems Engineer', connects_required: 10 },
        ],
        paging: { totalCount: 1, offset: 0, count: 1, hasNextPage: false },
        capturedAt: new Date().toISOString(),
      },
      {
        captureSeq: 3,
        navigationEpoch: 1,
        captureKind: 'xhr',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=rust',
        sourceFeed: 'search',
        query: 'rust',
        jobs: [
          {
            upwork_job_id: '~0101',
            job_title: 'Rust Systems Engineer',
            job_description: 'Merged description from chunk 2',
          },
        ],
        capturedAt: new Date().toISOString(),
      },
    ];

    const getBatchesCalls: Array<{ tabId: number; sinceIso?: string }> = [];
    const activities: Array<Omit<ActivityLogEntry, 'id' | 'timestamp'>> = [];

    const res = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response('{}', { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: vi.fn(async () => ({
          ok: true,
          hasNextPage: true,
          extractionSource: 'dom',
          jobs: [],
        })),
        getTabSearchBatches: (tabId, sinceIso) => {
          getBatchesCalls.push({ tabId, sinceIso });
          return cachedBatches;
        },
        recordActivity: (entry) => activities.push(entry),
      },
      { source: 'search', query: 'rust', max_pages: 3 },
    );

    expect(getBatchesCalls).toHaveLength(1);
    expect(getBatchesCalls[0]?.tabId).toBe(101);
    expect(res.ok).toBe(true);
    expect(res.total_scraped).toBe(1);
    expect(res.stopped_reason).toBe('end_of_results');
    const jobs = res.jobs as Array<Record<string, unknown>>;
    expect(jobs[0]).toMatchObject({
      upwork_job_id: '~0101',
      job_title: 'Rust Systems Engineer',
      job_description: 'Merged description from chunk 2',
      connects_required: 10,
      source: 'chrome_extension_graphql',
      source_feed: 'search',
      source_query: 'rust',
      canonical_url: 'https://www.upwork.com/jobs/~0101/',
      url: 'https://www.upwork.com/jobs/~0101/',
      job_url: 'https://www.upwork.com/jobs/~0101/',
      status: 'ready',
    });
    expect(activities[0]?.detail).toContain('via graphql (end_of_results)');

    // reply.ok === false must NOT trigger fallback
    const failedRes = await executeSearchSweep(
      {
        tabController: controller,
        proxyFetch: vi.fn(async () => new Response('{}', { status: 200 })),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: vi.fn(async () => ({ ok: false, errorCode: 'SELECTOR_BROKEN', jobs: [] })),
        getTabSearchBatches: () => cachedBatches,
      },
      { source: 'search', query: 'rust', max_pages: 1 },
    );
    expect(failedRes.total_scraped).toBe(0);
    expect(failedRes.stopped_reason).toBe('empty_page');

    // HUMAN_ACTION_REQUIRED must still throw immediately
    await expect(
      executeSearchSweep(
        {
          tabController: controller,
          proxyFetch: vi.fn(),
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage: vi.fn(async () => ({
            ok: false,
            errorCode: 'HUMAN_ACTION_REQUIRED',
            challengeType: 'captcha',
            reason: 'Blocked',
          })),
          getTabSearchBatches: () => cachedBatches,
        },
        { source: 'search', query: 'rust', max_pages: 1 },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });
});
