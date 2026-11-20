import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiJobRow {
  id: number;
  upwork_job_id?: string;
  canonical_url?: string;
  job_title: string;
  budget?: string;
  budget_amount?: string;
  proposals_tier?: string;
  proposals_count?: number | null;
  hours_per_week?: string | null;
  client_rating?: number | null;
  client_spent?: string;
  client_spent_usd?: number | null;
  score?: number | null;
  score_breakdown?: {
    rate_budget?: number;
    skill_match?: number;
    client_spend?: number;
    client_hires?: number;
    proposal_count?: number;
    recency?: number;
    description_quality?: number;
  } | null;
  fit_label?: string;
  last_enriched_at?: string | null;
}

interface McpJobPayload {
  jobs?: ApiJobRow[];
  items?: ApiJobRow[];
  job?: ApiJobRow;
  error?: string;
  code?: string;
  message?: string;
}

function extractJobsArray(payload: McpJobPayload): ApiJobRow[] {
  return payload.jobs ?? payload.items ?? [];
}

async function callToolSafely(
  fn: () => Promise<McpToolCallResult>,
): Promise<{ ok: boolean; errorText: string; result?: McpToolCallResult }> {
  try {
    const res = await fn();
    const text = res.content.map((c) => c.text ?? '').join('\n');
    if (res.isError) {
      return { ok: false, errorText: text, result: res };
    }
    return { ok: true, errorText: text, result: res };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorText: msg };
  }
}

test.describe('Tier 2 — F3: Job Detail Enrichment, Scoring & Pipeline Filtering', () => {
  test('T2-F3-01: Explicit $0 budget vs unknown/nil budget distinction', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const zeroRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639173/',
    });
    expect(zeroRes.isError).not.toBe(true);

    const unknownRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639174/',
    });
    expect(unknownRes.isError).not.toBe(true);

    const apiRes = await daemon.apiFetch('/api/jobs');
    expect(apiRes.status).toBe(200);
    const apiBody = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const zeroJob = apiBody.jobs.find((j) => j.upwork_job_id === '~022115332344639173');
    const unknownJob = apiBody.jobs.find((j) => j.upwork_job_id === '~022115332344639174');

    expect(zeroJob).toBeDefined();
    expect(unknownJob).toBeDefined();
    const zeroBudgetStr = String(zeroJob?.budget_amount || zeroJob?.budget || '');
    expect(zeroBudgetStr).toMatch(/0/);
    const unknownBudgetRaw = unknownJob?.budget_amount;
    expect(
      unknownBudgetRaw === null || unknownBudgetRaw === undefined || unknownBudgetRaw === '',
    ).toBe(true);

    const excludeUnknown = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', {
        budget_min: 100,
        include_unknown_budget: false,
      }),
    );
    const excludeIds = extractJobsArray(excludeUnknown).map((j) => j.upwork_job_id);
    expect(excludeIds).not.toContain('~022115332344639173');
    expect(excludeIds).not.toContain('~022115332344639174');

    const includeUnknown = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', {
        budget_min: 100,
        include_unknown_budget: true,
      }),
    );
    const includeIds = extractJobsArray(includeUnknown).map((j) => j.upwork_job_id);
    expect(includeIds).not.toContain('~022115332344639173');
    expect(includeIds).toContain('~022115332344639174');
  });

  test('T2-F3-02: "Fixed price" search card retained through Stage 2 before Stage 3 enrichment', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'budget_stage3',
      max_pages: 1,
      enrich_top_n: 5,
      budget_min: 500,
      budget_max: 2000,
    });
    expect(searchRes.isError).not.toBe(true);
    const searchData = parseMcpToolJson<McpJobPayload>(searchRes);
    const matchedIds = extractJobsArray(searchData).map((j) => j.upwork_job_id);

    const detailRequests = await mockClient.getRequests('/jobs/');
    const hitPaths = detailRequests.map((r) => r.pathname);
    expect(hitPaths.some((p) => p.includes('~022115332344639171'))).toBe(true);
    expect(hitPaths.some((p) => p.includes('~022115332344639172'))).toBe(true);

    expect(matchedIds).toContain('~022115332344639171');
    expect(matchedIds).not.toContain('~022115332344639172');

    const savedRes = await daemon.apiFetch('/api/jobs');
    expect(savedRes.status).toBe(200);
    const savedBody = (await savedRes.json()) as { jobs: ApiJobRow[] };
    const enriched171 = savedBody.jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(enriched171).toBeDefined();
    expect(enriched171?.last_enriched_at).toBeTruthy();
  });

  test('T2-F3-03: budget_max = 0 boundary is enforced as $0 cap (NOT infinity)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
  }) => {
    for (const jobId of ['~022115332344639171', '~022115332344639172', '~022115332344639173']) {
      const res = await mcpHttp.callTool('upwork_get_job_details', {
        url: `https://www.upwork.com/jobs/${jobId}/`,
      });
      expect(res.isError).not.toBe(true);
    }

    const zeroCapRes = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', {
        budget_min: 0,
        budget_max: 0,
        include_unknown_budget: false,
      }),
    );
    const ids = extractJobsArray(zeroCapRes).map((j) => j.upwork_job_id);
    expect(ids).toContain('~022115332344639173');
    expect(ids).not.toContain('~022115332344639171');
    expect(ids).not.toContain('~022115332344639172');
  });

  test('T2-F3-04: Missing optional detail fields & +8 missing-proposals score baseline', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const res = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639174/',
    });
    expect(res.isError).not.toBe(true);

    const apiRes = await daemon.apiFetch('/api/jobs');
    expect(apiRes.status).toBe(200);
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const job = body.jobs.find((j) => j.upwork_job_id === '~022115332344639174');

    expect(job).toBeDefined();
    expect(job?.client_rating ?? null).toBeNull();
    expect(job?.proposals_tier ?? '').toBe('');
    expect(job?.hours_per_week ?? '').toBe('');
    expect(job?.client_spent_usd ?? 0).toBe(0);
    expect(job?.score_breakdown?.proposal_count).toBe(8);
    expect(job?.score_breakdown?.client_spend).toBe(0);
  });

  test('T2-F3-05: 404 / expired / private job detail pages rejected by page_guards', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const expired = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~022115332344639404/',
      }),
    );
    expect(expired.ok).toBe(false);
    expect(expired.errorText).toMatch(/JOB_NOT_FOUND|no longer available|unavailable|not found/i);

    const priv = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~022115332344639404/?variant=private&status=404',
      }),
    );
    expect(priv.ok).toBe(false);
    expect(priv.errorText).toMatch(/JOB_NOT_FOUND|private|unavailable|404/i);

    const apiRes = await daemon.apiFetch('/api/jobs');
    expect(apiRes.status).toBe(200);
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    expect(body.jobs).toHaveLength(0);
  });

  test('T2-F3-06: Empty-shell / soft-404 detail page rejected when signal selectors absent', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const soft404 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~022115332344639405/',
      }),
    );
    expect(soft404.ok).toBe(false);
    expect(soft404.errorText).toMatch(/JOB_NOT_FOUND|unavailable|non-job|detail|not found/i);

    const apiRes = await daemon.apiFetch('/api/jobs');
    expect(apiRes.status).toBe(200);
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    expect(body.jobs).toHaveLength(0);
  });

  test('T2-F3-07: Boundary proposal counts ("Less than 5", "10 to 15", "20 to 50", "50+")', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'boundary_cases',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const max4 = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', { max_proposals: 4 }),
    );
    const max4Ids = extractJobsArray(max4).map((j) => j.upwork_job_id);
    expect(max4Ids).toContain('~030100000000000000001');
    expect(max4Ids).not.toContain('~022111887415567641941');
    expect(max4Ids).not.toContain('~022111887415567641944');

    const max50 = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', { max_proposals: 50 }),
    );
    const max50Ids = extractJobsArray(max50).map((j) => j.upwork_job_id);
    expect(max50Ids).toContain('~022111887415567641942');
    expect(max50Ids).not.toContain('~022111887415567641944');

    const apiRes = await daemon.apiFetch('/api/jobs');
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const byId = new Map(body.jobs.map((j) => [j.upwork_job_id, j]));

    expect(byId.get('~030100000000000000001')?.proposals_count).toBe(4);
    expect(byId.get('~030100000000000000001')?.score_breakdown?.proposal_count).toBe(10);

    expect(byId.get('~022111887415567641941')?.proposals_count).toBe(15);
    expect(byId.get('~022111887415567641941')?.score_breakdown?.proposal_count).toBe(10);

    expect(byId.get('~022111887415567641942')?.proposals_count).toBe(50);
    expect(byId.get('~022111887415567641942')?.score_breakdown?.proposal_count).toBe(5);

    expect(byId.get('~022111887415567641944')?.proposals_count).toBe(999);
    expect(byId.get('~022111887415567641944')?.score_breakdown?.proposal_count).toBe(2);
  });

  test('T2-F3-08: Boundary posted ages ("23 hours ago" vs "25 hours ago", "1 week ago", "1 month ago")', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'boundary_cases',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const age0 = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', { max_age_days: 0 }),
    );
    const age0Ids = extractJobsArray(age0).map((j) => j.upwork_job_id);
    expect(age0Ids).toContain('~030100000000000000001');
    expect(age0Ids).not.toContain('~022111887415567641941');

    const age1 = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', { max_age_days: 1 }),
    );
    const age1Ids = extractJobsArray(age1).map((j) => j.upwork_job_id);
    expect(age1Ids).toContain('~030100000000000000001');
    expect(age1Ids).toContain('~022111887415567641941');
    expect(age1Ids).not.toContain('~022111887415567641942');

    const apiRes = await daemon.apiFetch('/api/jobs');
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const byId = new Map(body.jobs.map((j) => [j.upwork_job_id, j]));

    expect(byId.get('~030100000000000000001')?.score_breakdown?.recency).toBe(10);
    expect(byId.get('~022111887415567641941')?.score_breakdown?.recency).toBe(8);
    expect(byId.get('~022111887415567641942')?.score_breakdown?.recency).toBe(4);
    expect(byId.get('~022111887415567641944')?.score_breakdown?.recency).toBe(0);
  });

  test('T2-F3-09: Boundary keyword_matches (go vs django, .net vs networking) & lowercase "10k" spend', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'boundary_cases',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const goOnly = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', {
        required_keywords: ['go'],
        exclude_keywords: ['wordpress'],
      }),
    );
    const goIds = extractJobsArray(goOnly).map((j) => j.upwork_job_id);
    expect(goIds).toContain('~030100000000000000001');
    expect(goIds).not.toContain('~022111887415567641941');
    expect(goIds).not.toContain('~022111887415567641942');

    const netOnly = parseMcpToolJson<McpJobPayload>(
      await mcpHttp.callTool('upwork_list_saved_jobs', {
        required_keywords: ['.net'],
      }),
    );
    const netIds = extractJobsArray(netOnly).map((j) => j.upwork_job_id);
    expect(netIds).toContain('~022111887415567641944');
    expect(netIds).not.toContain('~022111887415567642001');

    const apiRes = await daemon.apiFetch('/api/jobs');
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const tenKJob = body.jobs.find((j) => j.upwork_job_id === '~030100000000000000001');
    expect(tenKJob).toBeDefined();
    expect(tenKJob?.client_spent_usd).toBe(10000);
    expect(tenKJob?.score_breakdown?.client_spend).toBe(12);
  });
});
