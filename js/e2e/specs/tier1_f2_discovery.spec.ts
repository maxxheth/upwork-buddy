import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiJobEntry {
  id: number;
  upwork_job_id?: string;
  canonical_url?: string;
  job_title: string;
  job_description: string;
  source_feed?: string;
  source_query?: string;
  budget?: string;
  budget_amount?: string;
  duration?: string;
  client_country?: string;
  proposals_tier?: string;
  client_rating?: number | null;
  score?: number | null;
  fit_label?: string;
}

test.describe('Tier 1 F2 — Job Discovery & Search/Authenticated Feeds', () => {
  test('T1-F2-01: search listings extraction with rendered_text, URL normalization & transforms', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    expect(listRes.status).toBe(200);
    const { jobs } = (await listRes.json()) as { jobs: ApiJobEntry[] };
    expect(jobs.length).toBeGreaterThanOrEqual(4);

    const target = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(target).toBeDefined();
    expect(target?.job_title).toContain('Audit + WordPress/Elementor');
    expect(target?.canonical_url).toMatch(/^https:\/\/www\.upwork\.com\/jobs\//);
    expect(target?.canonical_url).not.toContain('span-class-highlight-');
    expect(target?.canonical_url).not.toContain('-span');
    expect(target?.canonical_url).not.toContain('referrer_url_path');

    const migrationJob = jobs.find((j) => j.upwork_job_id === '~022111887415567641942');
    expect(migrationJob).toBeDefined();
    const budgetText = migrationJob?.budget_amount || migrationJob?.budget || '';
    expect(budgetText).toContain('$1,000.00');
    expect(budgetText).not.toContain('Est. budget:');
    expect(migrationJob?.duration ?? '').not.toContain('Est. time:');
  });

  test('T1-F2-02: multi-page search pagination, upwork_job_id deduplication & target_jobs cap', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 2,
      target_jobs: 5,
    });
    expect(searchRes.isError).not.toBe(true);
    const payload = parseMcpToolJson<{
      jobs?: ApiJobEntry[];
      total?: number;
      pages_scraped?: number;
    }>(searchRes);
    expect(payload.pages_scraped ?? 2).toBeGreaterThanOrEqual(2);

    const listRes = await daemon.apiFetch('/api/jobs');
    expect(listRes.status).toBe(200);
    const { jobs } = (await listRes.json()) as { jobs: ApiJobEntry[] };
    expect(jobs.length).toBe(5);

    const uniqueIds = new Set(jobs.map((j) => j.upwork_job_id));
    expect(uniqueIds.size).toBe(5);
    expect(uniqueIds.has('~022115332344639171')).toBe(true);

    const searchHits = await mockClient.getRequests('/nx/search/jobs/');
    expect(searchHits.length).toBeGreaterThanOrEqual(2);
  });

  test('T1-F2-03: authenticated discovery feeds (best_matches, most_recent, saved_jobs)', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    for (const feed of ['best_matches', 'most_recent', 'saved_jobs'] as const) {
      const res = await mcpHttp.callTool('upwork_search_jobs', {
        source: feed,
        max_pages: 1,
      });
      expect(res.isError).not.toBe(true);
    }

    const requests = await mockClient.getRequests('/nx/find-work/');
    const visitedPaths = new Set(requests.map((r) => r.pathname));
    expect(visitedPaths.has('/nx/find-work/best-matches')).toBe(true);
    expect(visitedPaths.has('/nx/find-work/most-recent')).toBe(true);
    expect(visitedPaths.has('/nx/find-work/saved-jobs')).toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    expect(listRes.status).toBe(200);
    const { jobs } = (await listRes.json()) as { jobs: ApiJobEntry[] };
    expect(jobs.length).toBeGreaterThanOrEqual(6);

    const feedsFound = new Set(jobs.map((j) => j.source_feed));
    expect(feedsFound.has('best_matches')).toBe(true);
    expect(feedsFound.has('most_recent')).toBe(true);
    expect(feedsFound.has('saved_jobs')).toBe(true);

    const sample = jobs[0];
    expect(sample.client_country).toBeTruthy();
    expect(sample.proposals_tier).toBeTruthy();
    expect(typeof sample.client_rating).toBe('number');
  });

  test('T1-F2-04: search profile CRUD, query deduplication & multi-query execution', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const createRes = await daemon.apiFetch('/api/search-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wp_elementor_multi',
        description: 'Multi-query WP + Elementor profile',
        search: {
          mode: 'live_search',
          queries: ['WordPress', '  WordPress  ', 'Elementor'],
          per_page: 20,
          sort: 'recency',
          max_pages: 1,
        },
      }),
    });
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as {
      profile: { id: number; name: string; config: { search: { queries: string[] } } };
    };
    expect(created.profile.name).toBe('wp_elementor_multi');

    const listProfilesRes = await daemon.apiFetch('/api/search-profiles');
    expect(listProfilesRes.status).toBe(200);
    const profilesBody = (await listProfilesRes.json()) as {
      profiles: Array<{ id: number; name: string; config: { search: { queries: string[] } } }>;
    };
    const saved = profilesBody.profiles.find((p) => p.name === 'wp_elementor_multi');
    expect(saved).toBeDefined();

    const runRes = await mcpHttp.callTool('upwork_manage_search_profiles', {
      action: 'run',
      profile: 'wp_elementor_multi',
      id: saved?.id,
    });
    expect(runRes.isError).not.toBe(true);

    const searchRequests = await mockClient.getRequests('/nx/search/jobs/');
    const executedQueries = searchRequests.map((r) => r.query.q);
    expect(executedQueries.filter((q) => q === 'WordPress').length).toBe(1);
    expect(executedQueries.filter((q) => q === 'Elementor').length).toBe(1);
    expect(searchRequests.length).toBe(2);

    const jobsRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await jobsRes.json()) as { jobs: ApiJobEntry[] };
    expect(jobs.some((j) => j.upwork_job_id === '~022115332344639171')).toBe(true);
    expect(jobs.some((j) => j.upwork_job_id === '~022111887415567643001')).toBe(true);
  });

  test('T1-F2-05: native Upwork search facet URL construction', async ({
    pairedExtension,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'golang',
      sort: 'recency',
      per_page: 20,
      contract_type: 'fixed',
      amount: '500-5000',
      contractor_tier: [2, 3],
      proposal_tiers: ['0-4', '5-9'],
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const requests = await mockClient.getRequests('/nx/search/jobs/');
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const req = requests[0];
    expect(req.query.q).toBe('golang');
    expect(req.query.sort).toBe('recency');
    expect(req.query.per_page).toBe('20');
    expect(req.query.t).toBe('1');
    expect(req.query.amount).toBe('500-5000');
    expect(req.query.contractor_tier).toBe('2,3');
    expect(req.query.proposals).toBe('0-4,5-9');
  });

  test('T1-F2-06: Side Panel Pipeline Queue display, filtering & idempotent re-scrape', async ({
    pairedExtension,
    daemon,
    extPages,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const seededJobs = [
      {
        job_title: 'Hot Pipeline Go Architecture',
        job_description: 'High-scoring Go + Postgres architecture project.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        score: 85,
        fit_label: 'hot',
      },
      {
        job_title: 'Ready Pipeline TypeScript Task',
        job_description: 'Solid TypeScript refactoring task.',
        url: 'https://www.upwork.com/jobs/~022111887415567641942/',
        score: 65,
        fit_label: 'ready',
      },
      {
        job_title: 'Skip Pipeline Low Budget Task',
        job_description: 'Low-fit placeholder task.',
        url: 'https://www.upwork.com/jobs/~022111887415567641944/',
        score: 30,
        fit_label: 'skip',
      },
    ];
    for (const job of seededJobs) {
      const res = await daemon.apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      });
      expect(res.ok).toBe(true);
    }

    const sidePanel = await extPages.openSidePanel();
    try {
      await expect(sidePanel.getByText('Hot Pipeline Go Architecture')).toBeVisible({
        timeout: 10_000,
      });
      await expect(sidePanel.getByText('Skip Pipeline Low Budget Task')).toBeVisible();

      const minScoreFilter = sidePanel
        .locator('[data-testid="filter-min-score"], input[name="minScore"]')
        .or(sidePanel.getByLabel(/min.*score/i))
        .first();
      if ((await minScoreFilter.count()) > 0) {
        await minScoreFilter.fill('60');
      }
      const fitFilter = sidePanel
        .locator('[data-testid="filter-fit"], select[name="fit"]')
        .or(sidePanel.getByLabel(/fit/i))
        .first();
      if ((await fitFilter.count()) > 0) {
        await fitFilter.selectOption('hot');
      }

      await expect(sidePanel.getByText('Hot Pipeline Go Architecture')).toBeVisible();
      await expect(sidePanel.getByText('Skip Pipeline Low Budget Task')).toHaveCount(0);
    } finally {
      await sidePanel.close();
    }

    await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
    });
    const firstList = (await (await daemon.apiFetch('/api/jobs')).json()) as {
      jobs: ApiJobEntry[];
    };

    await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
    });
    const secondList = (await (await daemon.apiFetch('/api/jobs')).json()) as {
      jobs: ApiJobEntry[];
    };

    expect(secondList.jobs.length).toBe(firstList.jobs.length);
    const idSet = new Set(secondList.jobs.map((j) => j.upwork_job_id));
    expect(idSet.size).toBe(secondList.jobs.length);
  });
});
