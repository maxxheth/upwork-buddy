import { pairExtensionWithDaemon } from '../helpers/pairing.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface DiscoveryJobRow {
  upwork_job_id?: string;
  canonical_url?: string;
  job_title: string;
  budget?: string;
  budget_amount?: string | number | null;
  hourly_rate?: string | null;
  rate_range?: string | null;
  skills?: string;
  client_rating?: number | null;
  proposals_tier?: string | null;
}

test.describe('Tier 2 F2 — Job Discovery & Search Corner Cases', () => {
  test('T2-F2-01: search cards missing optional fields vs card missing required title', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'missing_optional',
      max_pages: 1,
    });
    expect(res.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    expect(listRes.status).toBe(200);
    const { jobs } = (await listRes.json()) as { jobs: DiscoveryJobRow[] };

    expect(jobs.length).toBe(2);
    const minimalCard = jobs.find((j) => j.upwork_job_id === '~022111887415567641942');
    const completeCard = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    const omittedTitleCard = jobs.find((j) => j.upwork_job_id === '~022111887415567641944');

    expect(minimalCard).toBeDefined();
    expect(minimalCard?.client_rating ?? null).toBeNull();
    expect(minimalCard?.proposals_tier ?? '').toBe('');
    expect(completeCard).toBeDefined();
    expect(omittedTitleCard).toBeUndefined();
  });

  test('T2-F2-02: Fixed price fallback when [data-test=is-fixed-price] is absent', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'budget_stage3',
      max_pages: 1,
      enrich_top_n: 0,
    });
    expect(res.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DiscoveryJobRow[] };
    const cardA = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(cardA).toBeDefined();
    expect(cardA?.budget).toBe('Fixed price');
    expect(cardA?.hourly_rate ?? '').toBe('');
    expect(cardA?.rate_range ?? '').toBe('');
    expect(cardA?.budget_amount ?? '').toBe('');
  });

  test('T2-F2-03: empty search results page (0 job tiles) completes cleanly', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'empty',
      max_pages: 2,
    });
    expect(res.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DiscoveryJobRow[] };
    expect(jobs.length).toBe(0);

    const hits = await mockClient.getRequests('/nx/search/jobs/');
    expect(hits.length).toBe(1);
    expect(pairedExtension.errors).toEqual([]);
  });

  test('T2-F2-04: normalize_job_url corner cases (-amp-, -- collapse, relative path, highlights)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'url_normalization',
      max_pages: 1,
    });
    expect(res.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DiscoveryJobRow[] };
    expect(jobs.length).toBe(1);
    expect(jobs[0].upwork_job_id).toBe('~022112225892746435112');
    expect(jobs[0].canonical_url).toBe(
      'https://www.upwork.com/jobs/On-Off-WordPress-Host-Server_~022112225892746435112/',
    );
  });

  test('T2-F2-05: invalid search_profiles inputs rejected with validation errors', async ({
    daemon,
  }) => {
    const invalidPayloads = [
      {
        name: '',
        search: { mode: 'live_search', query: '', queries: [] },
      },
      {
        name: 'bad_per_page_profile',
        search: { mode: 'live_search', queries: ['WordPress'], per_page: 99 },
      },
      {
        name: 'bad_jitter_profile',
        transport: { jitter_ratio: 1.5 },
        search: { mode: 'live_search', queries: ['WordPress'] },
      },
    ];

    for (const payload of invalidPayloads) {
      const res = await daemon.apiFetch('/api/search-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect([400, 422]).toContain(res.status);
      const errBody = await res.text();
      expect(errBody.length).toBeGreaterThan(2);
    }

    const listRes = await daemon.apiFetch('/api/search-profiles');
    expect(listRes.status).toBe(200);
    const { profiles } = (await listRes.json()) as { profiles: unknown[] };
    expect(profiles.length).toBe(0);
  });

  test('T2-F2-06: dedicated automation tab isolation & jittered pacing floor under concurrent sweeps', async ({
    extensionCtx,
    daemon,
    mockClient,
    mcpHttp,
    upworkPage,
  }) => {
    // Pair explicitly with the production 4.5s pacing default so >= 4.5s ± 50% (>= 2.25s) floor is exercised cleanly.
    await pairExtensionWithDaemon(extensionCtx, daemon, { pacingSeconds: 4.5 });

    const userRoomUrl = 'https://www.upwork.com/ab/messages/rooms';
    await upworkPage.goto(userRoomUrl, { waitUntil: 'domcontentloaded' });

    const [wpRes, emptyRes] = await Promise.all([
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 2,
      }),
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'empty',
        max_pages: 1,
      }),
    ]);

    expect(wpRes.isError).not.toBe(true);
    expect(emptyRes.isError).not.toBe(true);

    // User's active tab URL must never be navigated or hijacked by automation.
    expect(upworkPage.url()).toBe(userRoomUrl);

    const searchHits = await mockClient.getRequests('/nx/search/jobs/');
    expect(searchHits.length).toBe(3);

    const wpHits = searchHits.filter((r) => r.query.q === 'WordPress');
    expect(wpHits.length).toBe(2);
    const emptyIdx = searchHits.findIndex((r) => r.query.q === 'empty');
    const wpIndices = searchHits
      .map((r, i) => (r.query.q === 'WordPress' ? i : -1))
      .filter((i) => i >= 0);

    // Serialization check: the empty sweep must not interleave between WordPress page 1 and page 2.
    expect(emptyIdx === 0 || emptyIdx === 2).toBe(true);
    expect(Math.abs(wpIndices[1] - wpIndices[0])).toBe(1);

    // Production pacing check: 4.5s with ±50% jitter has a strict >= 2.25s floor between pages.
    const interPageDelayMs = wpHits[1].timestampMs - wpHits[0].timestampMs;
    expect(interPageDelayMs).toBeGreaterThanOrEqual(2_200);
  });
});
