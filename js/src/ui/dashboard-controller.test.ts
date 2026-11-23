import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport, EnrichmentBatchDetailResponse, SavedJob } from '../types';
import { DashboardController } from './dashboard-controller';

function makeJob(id: number, enriched = false): SavedJob {
  return {
    id,
    job_title: `Job Title ${id}`,
    job_description: `Description ${id}`,
    contract_type: 'fixed',
    budget: `$${1000 + id * 100}.00`,
    rate_range: '',
    rate_min: '',
    rate_max: '',
    budget_amount: `$${1000 + id * 100}.00`,
    experience_level: 'Expert',
    skills: 'Go, PostgreSQL',
    proposal: enriched ? `Proposal ${id}` : '',
    time_estimate: '',
    execution_prompt: '',
    tone_analysis: '',
    score: 85,
    fit_label: 'hot',
    created_at: '2026-11-20T12:00:00Z',
    ai_enrichment_status: enriched ? 'completed' : 'none',
    ai_enriched_at: enriched ? '2026-11-20T13:00:00Z' : null,
  };
}

describe('DashboardController', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root') as HTMLElement;
    window.history.replaceState(null, '', '/dashboard/?fit=hot&q=Job');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('enforces confirmation threshold, preserves filter-query focus across 2s polling, and cancels running batch', async () => {
    const jobs = [makeJob(1, true), makeJob(2), makeJob(3), makeJob(4), makeJob(5)];
    let batchStatus = 'running';
    let enrichPostCount = 0;
    let cancelPostCount = 0;
    let searchPostCount = 0;
    let batchPollCount = 0;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 2,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: 1,
                project_key: 'p/one',
                slug: 'one',
                name: 'Project One',
                path: '/tmp/one',
                group_name: 'g',
                activity_tier: 'active',
                status: 'active',
                proposal_visibility: 'public',
                public_alias: '',
                tech_stack: ['Go'],
                summary: 's',
                pinned: false,
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs, total: jobs.length }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        enrichPostCount += 1;
        const detail: EnrichmentBatchDetailResponse = {
          batch: {
            id: 77,
            mode: 'full',
            triggered_by: 'ui',
            force: false,
            status: batchStatus,
            total_count: 4,
            queued_count: 2,
            running_count: 2,
            completed_count: 0,
            skipped_count: 1,
            failed_count: 0,
            canceled_count: 0,
            total_tokens_used: 0,
            created_at: '2026-11-20T12:00:00Z',
            updated_at: '2026-11-20T12:00:00Z',
          },
          items: [],
        };
        return new Response(JSON.stringify(detail), { status: 202 });
      }
      if (url === '/api/enrichment-batches/77') {
        batchPollCount += 1;
        return new Response(
          JSON.stringify({
            batch: {
              id: 77,
              mode: 'full',
              triggered_by: 'ui',
              force: false,
              status: batchStatus,
              total_count: 4,
              queued_count: 1,
              running_count: 1,
              completed_count: 1,
              skipped_count: 1,
              failed_count: 0,
              canceled_count: batchStatus === 'canceled' ? 2 : 0,
              total_tokens_used: 850,
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:02Z',
            },
            items: [],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/enrichment-batches/77/cancel' && init?.method === 'POST') {
        cancelPostCount += 1;
        batchStatus = 'canceled';
        return new Response(
          JSON.stringify({
            batch: {
              id: 77,
              mode: 'full',
              triggered_by: 'ui',
              force: false,
              status: 'canceled',
              total_count: 4,
              queued_count: 0,
              running_count: 0,
              completed_count: 1,
              skipped_count: 1,
              failed_count: 0,
              canceled_count: 2,
              total_tokens_used: 850,
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:03Z',
            },
            items: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/enrichment-batches')) {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/search' && init?.method === 'POST') {
        searchPostCount += 1;
        return new Response(
          JSON.stringify({ search_run_id: 9, jobs, stopped_reason: 'completed' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();

    // URL params populated filter inputs
    const filterInput = root.querySelector<HTMLInputElement>('[data-testid="filter-query-input"]');
    expect(filterInput?.value).toBe('Job');
    expect(root.querySelector('[data-testid="active-projects-pill"]')?.textContent).toContain(
      '1 active',
    );

    // Select all 5 rows (1 enriched + 4 unenriched > confirm_threshold 2)
    root.querySelector<HTMLInputElement>('[data-testid="select-all-page-checkbox"]')?.click();
    expect(root.querySelector('[data-testid="bulk-selection-summary"]')?.textContent).toBe(
      '5 selected (1 already AI-enriched; 4 will run)',
    );

    // Clicking Enrich Selected opens confirmation dialog; Cancel makes 0 POST /api/jobs/enrich
    root.querySelector<HTMLButtonElement>('[data-testid="enrich-selected-btn"]')?.click();
    const dialog = root.querySelector<HTMLElement>('[data-testid="confirm-enrich-dialog"]');
    expect(dialog?.closest('.dash-modal-overlay')?.hasAttribute('hidden')).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-testid="confirm-enrich-cancel-btn"]')?.click();
    expect(enrichPostCount).toBe(0);

    // Confirm dispatches POST /api/jobs/enrich and starts 2s polling
    root.querySelector<HTMLButtonElement>('[data-testid="enrich-selected-btn"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-testid="confirm-enrich-proceed-btn"]')?.click();
    await vi.waitFor(() => expect(enrichPostCount).toBe(1));

    // Focus filter input and advance across a 2s poll tick -> activeElement must NOT be lost
    filterInput?.focus();
    expect(document.activeElement).toBe(filterInput);
    await vi.advanceTimersByTimeAsync(2200);
    expect(batchPollCount).toBeGreaterThanOrEqual(1);
    expect(document.activeElement).toBe(filterInput);

    // Cancel Remaining stops batch
    root.querySelector<HTMLButtonElement>('[data-testid="cancel-batch-btn"]')?.click();
    await vi.waitFor(() => expect(cancelPostCount).toBe(1));

    // Collapsible 0-token search panel submits with skip_auto_detail_enrich: true
    root.querySelector<HTMLButtonElement>('[data-testid="toggle-search-panel-btn"]')?.click();
    expect(root.querySelector('[data-testid="search-panel"]')?.textContent).toContain(
      '0 LLM tokens',
    );
    const matchCb = root.querySelector<HTMLInputElement>(
      '[data-testid="match-active-projects-checkbox"]',
    );
    if (matchCb) matchCb.checked = true;
    root
      .querySelector<HTMLFormElement>('#dash-search-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(searchPostCount).toBe(1));

    controller.destroy();
  });

  it('preserves pagination on Page 2 across 2s batch polling and requests active-projects?limit=500', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    const jobs = Array.from({ length: 60 }, (_, idx) => makeJob(idx + 1));
    const seenUrls: string[] = [];

    const transport: ApiTransport = vi.fn(async (url) => {
      seenUrls.push(url);
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs, total: jobs.length }), { status: 200 });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(
          JSON.stringify({
            batches: [
              {
                id: 99,
                mode: 'full',
                triggered_by: 'ui',
                force: false,
                status: 'running',
                total_count: 2,
                queued_count: 1,
                running_count: 1,
                completed_count: 0,
                skipped_count: 0,
                failed_count: 0,
                canceled_count: 0,
                total_tokens_used: 0,
                created_at: '2026-11-20T12:00:00Z',
                updated_at: '2026-11-20T12:00:00Z',
              },
            ],
            total: 1,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/enrichment-batches/99') {
        return new Response(
          JSON.stringify({
            batch: {
              id: 99,
              mode: 'full',
              triggered_by: 'ui',
              force: false,
              status: 'running',
              total_count: 2,
              queued_count: 1,
              running_count: 1,
              completed_count: 0,
              skipped_count: 0,
              failed_count: 0,
              canceled_count: 0,
              total_tokens_used: 0,
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:00Z',
            },
            items: [],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();

    expect(seenUrls).toContain('/api/active-projects?limit=500');
    root.querySelector<HTMLButtonElement>('button[data-action="next-page"]')?.click();
    expect(root.querySelector('.dash-page-info')?.textContent).toBe('Page 2 of 2');

    await vi.advanceTimersByTimeAsync(2200);
    expect(root.querySelector('.dash-page-info')?.textContent).toBe('Page 2 of 2');

    controller.destroy();
  });

  it('aborts phase-2 init requests when a phase-1 401 triggers destroy()', async () => {
    const seenUrls: string[] = [];
    let controller!: DashboardController;

    const transport: ApiTransport = vi.fn(async (url) => {
      seenUrls.push(url);
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    controller = new DashboardController({
      root,
      transport,
      surface: 'web',
      onUnauthorized: () => {
        controller.destroy();
      },
    });
    await controller.init();

    expect(seenUrls.some((u) => u.startsWith('/api/jobs'))).toBe(false);
    expect(seenUrls.some((u) => u.startsWith('/api/enrichment-batches'))).toBe(false);
  });

  it('escapes and normalizes XSS payloads, null queries, and non-finite/out-of-range batch counts in searchRuns and batchBanner', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    const jobs = [makeJob(1)];

    const transport: ApiTransport = vi.fn(async (url) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(
          JSON.stringify({
            search_runs: [
              {
                id: '"><img src=x onerror=window.__xss=1>',
                label: '<svg onload="window.__xss=2">XSS Run</svg>',
                source: 'search',
                triggered_by: 'ui',
                project_keys: [],
                queries: null,
                total_scraped: 1,
                filtered_count: 1,
                persisted_count: '<img src=x onerror=window.__xss=3>',
                detail_enriched_count: 0,
                stopped_reason: 'completed',
                created_at: '2026-11-20T12:00:00Z',
              },
            ],
            total: 1,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs, total: 1 }), { status: 200 });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(
          JSON.stringify({
            batches: [{ id: 88, status: 'running' }],
            total: 1,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/enrichment-batches/88') {
        return new Response(
          JSON.stringify({
            batch: {
              id: '"><img src=x onerror=window.__xss=4>',
              mode: 'full<script>window.__xss=5</script>',
              triggered_by: 'ui',
              force: false,
              status: 'running',
              total_count: 10,
              queued_count: 0,
              running_count: 0,
              completed_count: 15, // > total_count to test clamping to 100%
              skipped_count: '<img src=x onerror=window.__xss=6>',
              failed_count: 0,
              canceled_count: 0,
              total_tokens_used: '99<img src=x onerror=window.__xss=7>',
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:00Z',
            },
            items: [
              {
                id: 1,
                batch_id: 88,
                job_id: '<img src=x onerror=window.__xss=8>',
                status: 'failed<svg onload=window.__xss=9>',
                detail_fetched: false,
                llm_invoked: false,
                input_tokens: 0,
                output_tokens: 0,
                thought_tokens: 0,
                total_tokens: '<img src=x onerror=window.__xss=10>',
                error_message: '<img src=x onerror=window.__xss=11>',
                created_at: '2026-11-20T12:00:00Z',
                updated_at: '2026-11-20T12:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();

    // Toggle batch items open
    root.querySelector<HTMLButtonElement>('[data-testid="batch-items-toggle"]')?.click();

    expect(root.querySelectorAll('img, svg, script, [onerror], [onload]').length).toBe(0);
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();

    // Search run option rendered safely with normalized id/count and null queries handled
    const runOpt = root.querySelector<HTMLOptionElement>(
      '#dash-search-run-select option[value="0"]',
    );
    expect(runOpt?.textContent).toContain('#0 ·');
    expect(runOpt?.textContent).toContain('XSS Run');
    expect(runOpt?.textContent).toContain('(0)');

    // Progress clamped to [0, 100]
    const banner = root.querySelector<HTMLElement>('#dash-batch-banner');
    expect(banner?.textContent).toContain('15/10 (100%)');
    const fill = root.querySelector<HTMLElement>('.dash-progress-fill');
    expect(fill?.style.width).toBe('100%');

    // Also verify NaN / Infinity batch metrics clamp to 0%
    (
      controller as unknown as {
        trackedBatches: Map<number, EnrichmentBatchDetailResponse>;
      }
    ).trackedBatches = new Map([
      [
        1,
        {
          batch: {
            id: Number.NaN,
            mode: 'full',
            triggered_by: 'ui',
            force: false,
            status: 'running',
            total_count: Number.POSITIVE_INFINITY,
            queued_count: 0,
            running_count: 0,
            completed_count: Number.NaN,
            skipped_count: 0,
            failed_count: 0,
            canceled_count: 0,
            total_tokens_used: Number.POSITIVE_INFINITY,
            created_at: '2026-11-20T12:00:00Z',
            updated_at: '2026-11-20T12:00:00Z',
          },
          items: [],
        },
      ],
    ]);
    (controller as unknown as { renderBatchBanner: () => void }).renderBatchBanner();
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain('0/0 (0%)');
    expect(root.querySelector<HTMLElement>('.dash-progress-fill')?.style.width).toBe('0%');

    controller.destroy();
  });

  it('ignores in-flight action 401 responses after destroy() without firing onUnauthorized or mutating errorBanner', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveEnrich!: (res: Response) => void;
    let resolveSearch!: (res: Response) => void;
    let resolvePatch!: (res: Response) => void;
    const onUnauthorized = vi.fn();

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1)], total: 1 }), { status: 200 });
      }
      if (url.startsWith('/api/enrichment-batches')) {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        return new Promise<Response>((res) => {
          resolveEnrich = res;
        });
      }
      if (url === '/api/jobs/search' && init?.method === 'POST') {
        return new Promise<Response>((res) => {
          resolveSearch = res;
        });
      }
      if (url === '/api/jobs/1' && init?.method === 'PATCH') {
        return new Promise<Response>((res) => {
          resolvePatch = res;
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
      onUnauthorized,
    });
    await controller.init();

    const enrichPromise = controller.startBatchEnrich([1]);
    root
      .querySelector<HTMLFormElement>('#dash-search-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const statusSel = root.querySelector<HTMLSelectElement>(
      'select[data-testid="row-status-select-1"]',
    );
    expect(statusSel).not.toBeNull();
    if (statusSel) {
      statusSel.value = 'ready';
      statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    controller.destroy();

    resolveEnrich(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    resolveSearch(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    resolvePatch(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    await enrichPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(onUnauthorized).toHaveBeenCalledTimes(0);
    const errBanner = root.querySelector<HTMLElement>('#dash-error-banner');
    expect(errBanner?.textContent).toBe('');
    expect(errBanner?.hidden).toBe(true);
  });

  it('stops 2s batch polling immediately when pollBatchTick receives 401 without onUnauthorized', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let pollCount = 0;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1)], total: 1 }), { status: 200 });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            batch: {
              id: 55,
              mode: 'full',
              triggered_by: 'ui',
              force: false,
              status: 'running',
              total_count: 1,
              queued_count: 1,
              running_count: 0,
              completed_count: 0,
              skipped_count: 0,
              failed_count: 0,
              canceled_count: 0,
              total_tokens_used: 0,
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:00Z',
            },
            items: [],
          }),
          { status: 202 },
        );
      }
      if (url === '/api/enrichment-batches/55') {
        pollCount += 1;
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'extension',
    });
    await controller.init();
    await controller.startBatchEnrich([1]);

    await vi.advanceTimersByTimeAsync(6500);
    expect(pollCount).toBe(1);
    const errBanner = root.querySelector<HTMLElement>('#dash-error-banner');
    expect(errBanner?.hidden).toBe(false);
    expect(errBanner?.textContent).toContain('Unauthorized (401)');

    controller.destroy();
  });

  it.each([401, 200, 500])(
    'ignores in-flight drawer enrich and save-draft %i responses after destroy() with zero DOM mutation, zero onUnauthorized, and zero unhandled rejections',
    async (statusCode) => {
      window.history.replaceState(null, '', '/dashboard/');
      const job = makeJob(1, true);
      const unhandledRejections: unknown[] = [];
      const onUnhandledProcess = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      const onUnhandledWindow = (event: PromiseRejectionEvent) => {
        unhandledRejections.push(event.reason);
      };
      process.on('unhandledRejection', onUnhandledProcess);
      window.addEventListener('unhandledrejection', onUnhandledWindow);

      try {
        for (const action of ['enrich', 'save-draft'] as const) {
          let resolveAction!: (res: Response) => void;
          const onUnauthorized = vi.fn();

          const transport: ApiTransport = vi.fn(async (url, init) => {
            if (url === '/api/enrichment-config') {
              return new Response(
                JSON.stringify({
                  max_batch_size: 25,
                  default_mode: 'full',
                  default_force: false,
                  skip_detail_if_present: true,
                  require_details: false,
                  max_concurrency: 2,
                  default_model: '',
                  default_effort: '',
                  confirm_threshold: 5,
                  wait_timeout_seconds: 60,
                  web_ui_enabled: true,
                  web_session_ttl_minutes: 720,
                }),
                { status: 200 },
              );
            }
            if (url.startsWith('/api/active-projects')) {
              return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
            }
            if (url.startsWith('/api/search-runs')) {
              return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
            }
            if (url.startsWith('/api/jobs?')) {
              return new Response(JSON.stringify({ jobs: [job], total: 1 }), { status: 200 });
            }
            if (url.startsWith('/api/enrichment-batches')) {
              return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
            }
            if (url === '/api/jobs/1/analyze' && init?.method === 'POST') {
              return new Promise<Response>((res) => {
                resolveAction = res;
              });
            }
            if (url === '/api/proposals' && init?.method === 'POST') {
              return new Promise<Response>((res) => {
                resolveAction = res;
              });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          });

          const controller = new DashboardController({
            root,
            transport,
            surface: 'web',
            onUnauthorized,
          });
          await controller.init();

          // Open JobInspectorDrawer and switch to AI Analysis tab
          root.querySelector<HTMLButtonElement>('[data-testid="row-inspect-btn-1"]')?.click();
          const drawerEl = root.querySelector<HTMLElement>('#dash-drawer');
          expect(drawerEl?.hidden).toBe(false);
          drawerEl?.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();

          if (action === 'enrich') {
            drawerEl
              ?.querySelector<HTMLButtonElement>('[data-testid="drawer-enrich-btn"]')
              ?.click();
          } else {
            drawerEl
              ?.querySelector<HTMLButtonElement>('[data-testid="save-proposal-draft-btn"]')
              ?.click();
          }

          const snapshotDrawerHtml = drawerEl?.innerHTML ?? '';
          expect(snapshotDrawerHtml).not.toBe('');

          controller.destroy();

          const body =
            statusCode === 200
              ? action === 'enrich'
                ? { job: { ...job, proposal: 'New post-destroy proposal' } }
                : { proposal: { id: 10 } }
              : { error: `status ${statusCode}` };

          resolveAction(new Response(JSON.stringify(body), { status: statusCode }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();

          expect(drawerEl?.innerHTML).toBe(snapshotDrawerHtml);
          expect(onUnauthorized).toHaveBeenCalledTimes(0);
          const errBanner = root.querySelector<HTMLElement>('#dash-error-banner');
          expect(errBanner?.textContent).toBe('');
          expect(errBanner?.hidden).toBe(true);
        }
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledProcess);
        window.removeEventListener('unhandledrejection', onUnhandledWindow);
      }
    },
  );

  it('PROBE-1: ignores stale in-flight pollBatchTick response resolving after cancelBatch', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveStalePoll!: (res: Response) => void;
    let pollAttempts = 0;

    const makeBatch = (id: number, status: string) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 2,
      queued_count: status === 'running' ? 1 : 0,
      running_count: status === 'running' ? 1 : 0,
      completed_count: 1,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: status === 'canceled' ? 1 : 0,
      total_tokens_used: 400,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:02Z',
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1)], total: 1 }), { status: 200 });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        return new Response(JSON.stringify({ batch: makeBatch(1, 'running'), items: [] }), {
          status: 202,
        });
      }
      if (url === '/api/enrichment-batches/1') {
        pollAttempts += 1;
        return new Promise<Response>((res) => {
          resolveStalePoll = res;
        });
      }
      if (url === '/api/enrichment-batches/1/cancel' && init?.method === 'POST') {
        return new Response(JSON.stringify({ batch: makeBatch(1, 'canceled'), items: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();
    await controller.startBatchEnrich([1]);

    // Trigger 2s poll tick so GET /api/enrichment-batches/1 is in-flight
    await vi.advanceTimersByTimeAsync(2050);
    expect(pollAttempts).toBe(1);

    // User cancels Batch #1 while poll #1 is still in-flight
    root.querySelector<HTMLButtonElement>('[data-testid="cancel-batch-btn"]')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
        'Batch #1 (full) — canceled',
      );
    });
    expect(root.querySelector('[data-testid="cancel-batch-btn"]')).toBeNull();
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).toBeNull();

    // Now the stale poll #1 resolves with pre-cancel status 'running'
    resolveStalePoll(
      new Response(JSON.stringify({ batch: makeBatch(1, 'running'), items: [] }), { status: 200 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
      'Batch #1 (full) — canceled',
    );
    expect(root.querySelector('[data-testid="cancel-batch-btn"]')).toBeNull();
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).toBeNull();

    controller.destroy();
  });

  it('PROBE-2: updates Batch #1 on poll completion while keeping Batch #2 polling alive', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveBatch1Poll!: (res: Response) => void;
    let batch1PollAttempts = 0;
    let batch2PollAttempts = 0;
    let enrichCalls = 0;

    const makeBatch = (id: number, status: string) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 2,
      queued_count: status === 'running' ? 1 : 0,
      running_count: status === 'running' ? 1 : 0,
      completed_count: status === 'completed' ? 2 : 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: 0,
      total_tokens_used: status === 'completed' ? 500 : 0,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:02Z',
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        enrichCalls += 1;
        return new Response(
          JSON.stringify({ batch: makeBatch(enrichCalls, 'running'), items: [] }),
          { status: 202 },
        );
      }
      if (url === '/api/enrichment-batches/1') {
        batch1PollAttempts += 1;
        return new Promise<Response>((res) => {
          resolveBatch1Poll = res;
        });
      }
      if (url === '/api/enrichment-batches/2') {
        batch2PollAttempts += 1;
        return new Response(JSON.stringify({ batch: makeBatch(2, 'running'), items: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();
    await controller.startBatchEnrich([1]);

    // Trigger Batch #1 poll and leave it in-flight
    await vi.advanceTimersByTimeAsync(2050);
    expect(batch1PollAttempts).toBe(1);

    // Start Batch #2 while Batch #1 poll is still in-flight
    await controller.startBatchEnrich([2]);
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
      '2 batches (full) — running',
    );
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    // Batch #1 poll resolves with terminal status 'completed'
    resolveBatch1Poll(
      new Response(JSON.stringify({ batch: makeBatch(1, 'completed'), items: [] }), {
        status: 200,
      }),
    );

    // Aggregate updates with Batch #1 completion while Batch #2 remains running and polling stays alive
    await vi.waitFor(() => {
      const bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
      expect(bannerText).toContain('2 batches (full) — running');
      expect(bannerText).toContain('2/4 (50%)');
      expect(bannerText).toContain('500 tokens');
    });
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    // Subsequent 2s tick continues polling Batch #2 (and does not re-poll terminal Batch #1)
    await vi.advanceTimersByTimeAsync(2050);
    expect(batch2PollAttempts).toBeGreaterThanOrEqual(1);
    expect(batch1PollAttempts).toBe(1);

    controller.destroy();
  });

  it('keeps Batch #2 running and polling when slow cancelBatch(1) resolves after startBatchEnrich starts Batch #2', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveSlowCancel!: (res: Response) => void;
    let enrichCalls = 0;

    const makeBatch = (id: number, status: string) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 1,
      queued_count: status === 'running' ? 1 : 0,
      running_count: 0,
      completed_count: 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: status === 'canceled' ? 1 : 0,
      total_tokens_used: 0,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:02Z',
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        enrichCalls += 1;
        return new Response(
          JSON.stringify({ batch: makeBatch(enrichCalls, 'running'), items: [] }),
          { status: 202 },
        );
      }
      if (url === '/api/enrichment-batches/1/cancel' && init?.method === 'POST') {
        return new Promise<Response>((res) => {
          resolveSlowCancel = res;
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();
    await controller.startBatchEnrich([1]);

    // Click cancel on Batch #1 (request stays in-flight)
    root.querySelector<HTMLButtonElement>('[data-testid="cancel-batch-btn"]')?.click();
    await Promise.resolve();

    // Before cancel resolves, start Batch #2
    await controller.startBatchEnrich([2]);
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
      '2 batches (full) — running',
    );
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    // Slow cancel for Batch #1 finally resolves
    resolveSlowCancel(
      new Response(JSON.stringify({ batch: makeBatch(1, 'canceled'), items: [] }), { status: 200 }),
    );

    await vi.waitFor(() => {
      const bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
      expect(bannerText).toContain('2 batches (full) — running');
      expect(bannerText).toContain('canceled 1');
    });
    expect(root.querySelector('[data-testid="cancel-batch-btn"]')).not.toBeNull();
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    controller.destroy();
  });

  it('PROBE-3: ignores stale out-of-order loadJobs() response for Run #1 after switching to Run #2', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveRun1Jobs!: (res: Response) => void;

    const run1Job: SavedJob = { ...makeJob(101), job_title: 'Stale Run 1 Job' };
    const run2Job: SavedJob = { ...makeJob(202), job_title: 'Run 2 Exclusive Job' };

    const transport: ApiTransport = vi.fn(async (url) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(
          JSON.stringify({
            search_runs: [
              {
                id: 1,
                label: 'Run 1',
                source: 'search',
                triggered_by: 'ui',
                project_keys: [],
                queries: ['go'],
                total_scraped: 1,
                filtered_count: 1,
                persisted_count: 1,
                detail_enriched_count: 0,
                stopped_reason: 'completed',
                created_at: '2026-11-20T12:00:00Z',
              },
              {
                id: 2,
                label: 'Run 2',
                source: 'search',
                triggered_by: 'ui',
                project_keys: [],
                queries: ['ts'],
                total_scraped: 1,
                filtered_count: 1,
                persisted_count: 1,
                detail_enriched_count: 0,
                stopped_reason: 'completed',
                created_at: '2026-11-20T12:05:00Z',
              },
            ],
            total: 2,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/jobs?limit=500&search_run_id=1') {
        return new Promise<Response>((res) => {
          resolveRun1Jobs = res;
        });
      }
      if (url === '/api/jobs?limit=500&search_run_id=2') {
        return new Response(JSON.stringify({ jobs: [run2Job], total: 1 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1)], total: 1 }), { status: 200 });
      }
      if (url.startsWith('/api/enrichment-batches')) {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root,
      transport,
      surface: 'web',
    });
    await controller.init();

    const runSelect = root.querySelector<HTMLSelectElement>('[data-testid="search-run-select"]');
    expect(runSelect).not.toBeNull();
    if (!runSelect) return;

    // Switch to Run #1 (response deferred)
    runSelect.value = '1';
    runSelect.dispatchEvent(new Event('change', { bubbles: true }));

    // Rapidly switch to Run #2 (response resolves immediately)
    runSelect.value = '2';
    runSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(root.querySelector('#dash-table-wrap tbody')?.textContent).toContain(
        'Run 2 Exclusive Job',
      );
    });

    // Now the slower Run #1 response resolves late
    resolveRun1Jobs(new Response(JSON.stringify({ jobs: [run1Job], total: 1 }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const tbodyText = root.querySelector('#dash-table-wrap tbody')?.textContent ?? '';
    expect(tbodyText).toContain('Run 2 Exclusive Job');
    expect(tbodyText).not.toContain('Stale Run 1 Job');
    expect(runSelect.value).toBe('2');

    controller.destroy();
  });

  it('aggregates 3 row-click batches live (running, queued, completed, tokens), guards double-clicks, and renders grouped items', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    const jobs = [makeJob(1), makeJob(2), makeJob(3)];
    const enrichBodies: Array<{ job_ids: number[] }> = [];
    let resolveFirstPost!: (res: Response) => void;
    let firstPostDeferred = true;
    let nextBatchId = 0;

    const batchDetails = new Map<number, EnrichmentBatchDetailResponse>();
    const makeDetail = (
      id: number,
      jobId: number,
      status: string,
      opts: { queued: number; running: number; completed: number; tokens: number },
    ): EnrichmentBatchDetailResponse => ({
      batch: {
        id,
        mode: 'full',
        triggered_by: 'ui',
        force: false,
        status,
        total_count: 1,
        queued_count: opts.queued,
        running_count: opts.running,
        completed_count: opts.completed,
        skipped_count: 0,
        failed_count: 0,
        canceled_count: 0,
        total_tokens_used: opts.tokens,
        created_at: '2026-11-20T12:00:00Z',
        updated_at: '2026-11-20T12:00:00Z',
      },
      items: [
        {
          id: id * 10,
          batch_id: id,
          job_id: jobId,
          status,
          detail_fetched: false,
          llm_invoked: opts.completed > 0,
          input_tokens: 0,
          output_tokens: 0,
          thought_tokens: 0,
          total_tokens: opts.tokens,
          created_at: '2026-11-20T12:00:00Z',
          updated_at: '2026-11-20T12:00:00Z',
        },
      ],
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs, total: jobs.length }), { status: 200 });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { job_ids: number[] };
        enrichBodies.push(body);
        nextBatchId += 1;
        const id = nextBatchId;
        const jobId = body.job_ids[0];
        const detail = makeDetail(id, jobId, 'running', {
          queued: 0,
          running: 1,
          completed: 0,
          tokens: 0,
        });
        batchDetails.set(id, detail);
        if (firstPostDeferred) {
          firstPostDeferred = false;
          return new Promise<Response>((res) => {
            resolveFirstPost = res;
          });
        }
        return new Response(JSON.stringify(detail), { status: 202 });
      }
      const match = url.match(/^\/api\/enrichment-batches\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);
        return new Response(JSON.stringify(batchDetails.get(id)), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();

    // Double-click row 1 Enrich while first POST is in-flight -> only 1 POST sent for job 1
    const btn1 = root.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-1"]');
    btn1?.click();
    btn1?.click();
    expect(enrichBodies).toEqual([expect.objectContaining({ job_ids: [1] })]);

    // Click row 2 and row 3 while row 1 POST is still in-flight
    root.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-2"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-3"]')?.click();
    await vi.waitFor(() => expect(enrichBodies.length).toBe(3));

    // Resolve row 1 POST
    resolveFirstPost(new Response(JSON.stringify(batchDetails.get(1)), { status: 202 }));
    await vi.waitFor(() => {
      expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
        '3 batches (full) — running',
      );
    });

    let bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('0/3 (0%)');
    expect(bannerText).toContain('running 3 · queued 0');

    // Simulate Batch #1 completing, Batch #2 queued, Batch #3 running
    batchDetails.set(
      1,
      makeDetail(1, 1, 'completed', { queued: 0, running: 0, completed: 1, tokens: 320 }),
    );
    batchDetails.set(
      2,
      makeDetail(2, 2, 'queued', { queued: 1, running: 0, completed: 0, tokens: 0 }),
    );
    batchDetails.set(
      3,
      makeDetail(3, 3, 'running', { queued: 0, running: 1, completed: 0, tokens: 0 }),
    );

    await vi.advanceTimersByTimeAsync(2050);
    bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('3 batches (full) — running');
    expect(bannerText).toContain('1/3 (33%)');
    expect(bannerText).toContain('running 1 · queued 1 · completed 1');
    expect(bannerText).toContain('320 tokens');

    // Expand items and verify Batch # labels + job titles
    root.querySelector<HTMLButtonElement>('[data-testid="batch-items-toggle"]')?.click();
    const itemsText = root.querySelector('.dash-batch-items')?.textContent ?? '';
    expect(itemsText).toContain('Batch #1');
    expect(itemsText).toContain('Job #1 · Job Title 1');
    expect(itemsText).toContain('Batch #2');
    expect(itemsText).toContain('Job #2 · Job Title 2');
    expect(itemsText).toContain('Batch #3');
    expect(itemsText).toContain('Job #3 · Job Title 3');

    controller.destroy();
  });

  it('Cancel Remaining cancels all active tracked batches in parallel and stops polling', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    const canceledIds: number[] = [];
    let nextId = 0;

    const makeBatch = (id: number, status: string) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 1,
      queued_count: status === 'running' ? 1 : 0,
      running_count: 0,
      completed_count: 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: status === 'canceled' ? 1 : 0,
      total_tokens_used: 0,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:00Z',
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ confirm_threshold: 5, default_mode: 'full' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        nextId += 1;
        return new Response(JSON.stringify({ batch: makeBatch(nextId, 'running'), items: [] }), {
          status: 202,
        });
      }
      const cancelMatch = url.match(/^\/api\/enrichment-batches\/(\d+)\/cancel$/);
      if (cancelMatch && init?.method === 'POST') {
        const id = Number(cancelMatch[1]);
        canceledIds.push(id);
        return new Response(JSON.stringify({ batch: makeBatch(id, 'canceled'), items: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();
    await controller.startBatchEnrich([1]);
    await controller.startBatchEnrich([2]);

    root.querySelector<HTMLButtonElement>('[data-testid="cancel-batch-btn"]')?.click();
    await vi.waitFor(() => {
      expect(canceledIds.sort()).toEqual([1, 2]);
      const bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
      expect(bannerText).toContain('2 batches (full) — canceled');
      expect(bannerText).toContain('2/2 (100%)');
      expect(bannerText).toContain('canceled 2');
    });
    expect(root.querySelector('[data-testid="dismiss-batch-banner-btn"]')).not.toBeNull();
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).toBeNull();

    controller.destroy();
  });

  it('clears prior terminal session batches when starting a fresh batch after completion', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let nextId = 0;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ confirm_threshold: 5, default_mode: 'full' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        nextId += 1;
        const isFirst = nextId === 1;
        return new Response(
          JSON.stringify({
            batch: {
              id: nextId,
              mode: 'full',
              triggered_by: 'ui',
              force: false,
              status: isFirst ? 'completed' : 'running',
              total_count: 1,
              queued_count: isFirst ? 0 : 1,
              running_count: 0,
              completed_count: isFirst ? 1 : 0,
              skipped_count: 0,
              failed_count: 0,
              canceled_count: 0,
              total_tokens_used: isFirst ? 900 : 0,
              created_at: '2026-11-20T12:00:00Z',
              updated_at: '2026-11-20T12:00:00Z',
            },
            items: [],
          }),
          { status: 202 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();

    // First batch finishes immediately
    await controller.startBatchEnrich([1]);
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
      'Batch #1 (full) — completed',
    );
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain('900 tokens');

    // Starting Batch #2 after Batch #1 completed resets old terminal totals
    await controller.startBatchEnrich([2]);
    const bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('Batch #2 (full) — running');
    expect(bannerText).toContain('0/1 (0%)');
    expect(bannerText).toContain('0 tokens');
    expect(bannerText).not.toContain('900 tokens');

    controller.destroy();
  });

  it('restores multiple active batches on reload via /api/enrichment-batches?limit=20', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    const makeBatch = (id: number, status: string, tokens: number) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 1,
      queued_count: status === 'queued' ? 1 : 0,
      running_count: status === 'running' ? 1 : 0,
      completed_count: 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: 0,
      total_tokens_used: tokens,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:00Z',
    });

    const transport: ApiTransport = vi.fn(async (url) => {
      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ confirm_threshold: 5, default_mode: 'full' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(
          JSON.stringify({
            batches: [
              makeBatch(10, 'completed', 400),
              makeBatch(11, 'running', 50),
              makeBatch(12, 'queued', 0),
            ],
            total: 3,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/enrichment-batches/11') {
        return new Response(JSON.stringify({ batch: makeBatch(11, 'running', 50), items: [] }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches/12') {
        return new Response(JSON.stringify({ batch: makeBatch(12, 'queued', 0), items: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();

    const bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('2 batches (full) — running');
    expect(bannerText).toContain('0/2 (0%)');
    expect(bannerText).toContain('running 1 · queued 1');
    expect(bannerText).toContain('50 tokens');
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    controller.destroy();
  });

  it('skips polling a batch while its cancel POST is in-flight and ignores out-of-order overlapping polls', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let resolveCancel1!: (res: Response) => void;
    let resolvePoll1Slow!: (res: Response) => void;
    let batch1PollCount = 0;
    let batch2Status = 'running';

    const makeBatch = (id: number, status: string) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 1,
      queued_count: status === 'running' ? 1 : 0,
      running_count: 0,
      completed_count: status === 'completed' ? 1 : 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: status === 'canceled' ? 1 : 0,
      total_tokens_used: status === 'completed' ? 100 : 0,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:00Z',
    });

    let enrichCount = 0;
    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ confirm_threshold: 5, default_mode: 'full' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        enrichCount += 1;
        return new Response(
          JSON.stringify({ batch: makeBatch(enrichCount, 'running'), items: [] }),
          { status: 202 },
        );
      }
      if (url.endsWith('/cancel') && init?.method === 'POST') {
        return new Promise<Response>((res) => {
          resolveCancel1 = res;
        });
      }
      if (url === '/api/enrichment-batches/1') {
        batch1PollCount += 1;
        if (batch1PollCount === 1) {
          return new Promise<Response>((res) => {
            resolvePoll1Slow = res;
          });
        }
        return new Response(JSON.stringify({ batch: makeBatch(1, 'completed'), items: [] }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches/2') {
        return new Response(JSON.stringify({ batch: makeBatch(2, batch2Status), items: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();

    // Path B: overlapping polls out-of-order after adding Batch #2
    await controller.startBatchEnrich([1]);
    await vi.advanceTimersByTimeAsync(2050); // Poll #1 for Batch #1 is slow & in-flight
    expect(batch1PollCount).toBe(1);

    await controller.startBatchEnrich([2]); // resets isPollInFlight
    batch2Status = 'completed';
    await vi.advanceTimersByTimeAsync(2050); // Poll #2 for Batch #1 + Batch #2 both complete
    expect(batch1PollCount).toBe(2);
    await vi.waitFor(() => {
      expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
        '2 batches (full) — completed',
      );
    });
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).toBeNull();

    // Slow Poll #1 resolves late with stale 'running' -> must NOT revert Batch #1
    resolvePoll1Slow(
      new Response(JSON.stringify({ batch: makeBatch(1, 'running'), items: [] }), { status: 200 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain(
      '2 batches (full) — completed',
    );
    expect((controller as unknown as { pollTimer: unknown }).pollTimer).toBeNull();

    // Path A: cancel in-flight skips polling for Batch #3
    await controller.startBatchEnrich([1]); // Batch #3
    root.querySelector<HTMLButtonElement>('[data-testid="cancel-batch-btn"]')?.click();
    await Promise.resolve();
    const callsBeforeTick = (transport as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2050);
    const callsAfterTick = (transport as ReturnType<typeof vi.fn>).mock.calls
      .slice(callsBeforeTick)
      .map((c) => c[0]);
    expect(callsAfterTick).not.toContain('/api/enrichment-batches/3');

    resolveCancel1(
      new Response(JSON.stringify({ batch: makeBatch(3, 'canceled'), items: [] }), { status: 200 }),
    );
    controller.destroy();
  });

  it('handles overlapping startBatchEnrich calls after a terminal session without deleting new terminal batches or keeping stale ones', async () => {
    window.history.replaceState(null, '', '/dashboard/');
    let postCall = 0;
    let resolveCallA!: (res: Response) => void;
    let resolveCallC!: (res: Response) => void;

    const makeBatch = (id: number, status: string, tokens: number) => ({
      id,
      mode: 'full',
      triggered_by: 'ui',
      force: false,
      status,
      total_count: 1,
      queued_count: status === 'running' ? 1 : 0,
      running_count: 0,
      completed_count: status === 'completed' ? 1 : 0,
      skipped_count: 0,
      failed_count: 0,
      canceled_count: 0,
      total_tokens_used: tokens,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:00Z',
    });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ confirm_threshold: 5, default_mode: 'full' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [makeJob(1), makeJob(2)], total: 2 }), {
          status: 200,
        });
      }
      if (url === '/api/enrichment-batches?limit=20') {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      if (url === '/api/jobs/enrich' && init?.method === 'POST') {
        postCall += 1;
        if (postCall === 1) {
          // Prior terminal session Batch #1
          return new Response(JSON.stringify({ batch: makeBatch(1, 'completed', 900), items: [] }), {
            status: 202,
          });
        }
        if (postCall === 2) {
          // Call A (deferred)
          return new Promise<Response>((res) => {
            resolveCallA = res;
          });
        }
        if (postCall === 3) {
          // Call B (resolves first as terminal completed Batch #3)
          return new Response(JSON.stringify({ batch: makeBatch(3, 'completed', 120), items: [] }), {
            status: 202,
          });
        }
        if (postCall === 4) {
          // Call C (deferred, will fail)
          return new Promise<Response>((res) => {
            resolveCallC = res;
          });
        }
        // Call D (resolves first as terminal completed Batch #4)
        return new Response(JSON.stringify({ batch: makeBatch(4, 'completed', 50), items: [] }), {
          status: 202,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({ root, transport, surface: 'web' });
    await controller.init();

    // Establish prior terminal Batch #1 (900 tokens)
    await controller.startBatchEnrich([1]);
    expect(root.querySelector('#dash-batch-banner')?.textContent).toContain('900 tokens');

    // Case (a): Call A and Call B overlap; Call B resolves first as terminal Batch #3, then Call A resolves as Batch #2
    const promiseA = controller.startBatchEnrich([1]);
    const promiseB = controller.startBatchEnrich([2]);
    await promiseB;
    resolveCallA(
      new Response(JSON.stringify({ batch: makeBatch(2, 'completed', 80), items: [] }), {
        status: 202,
      }),
    );
    await promiseA;

    let bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('2 batches (full) — completed');
    expect(bannerText).toContain('200 tokens'); // 120 + 80 (Batch #1's 900 cleared, Batch #3 preserved!)

    // Case (b): Call C fails while Call D succeeds -> old Batch #2/#3 are cleared and Batch #4 remains
    const promiseC = controller.startBatchEnrich([1]);
    const promiseD = controller.startBatchEnrich([2]);
    await promiseD;
    resolveCallC(new Response(JSON.stringify({ error: 'server error' }), { status: 500 }));
    await promiseC;

    bannerText = root.querySelector('#dash-batch-banner')?.textContent ?? '';
    expect(bannerText).toContain('Batch #4 (full) — completed');
    expect(bannerText).toContain('50 tokens');

    controller.destroy();
  });
});
