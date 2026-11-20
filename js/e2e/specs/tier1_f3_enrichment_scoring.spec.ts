import { expect, test } from '../helpers/test-fixtures.ts';

interface DetailedJobEntry {
  id: number;
  upwork_job_id?: string;
  canonical_url?: string;
  job_title: string;
  job_description: string;
  source_feed?: string;
  source_query?: string;
  budget_amount?: string;
  experience_level?: string;
  duration?: string;
  hours_per_week?: string;
  proposals_tier?: string;
  connects_required?: number | null;
  client_country?: string;
  client_rating?: number | null;
  client_reviews?: number | null;
  client_spent?: string;
  client_spent_usd?: number | null;
  client_hires?: number | null;
  client_hire_rate?: number | null;
  payment_verified?: boolean | null;
  client_activity?: {
    interviewing?: number;
    invites_sent?: number;
    unanswered_invites?: number;
    last_viewed?: string;
  } | null;
  screening_questions?: Array<{ prompt: string; required?: boolean }> | null;
  attachments?: unknown[] | null;
  qualifications?: unknown[] | null;
  score?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  fit_label?: string;
  last_enriched_at?: string | null;
}

test.describe('Tier 1 F3 — Job Detail Enrichment, Scoring & Pipeline Filtering', () => {
  test('T1-F3-01: standalone /jobs/~* detail extraction (all 14 upwork.yaml rules + hours_per_week)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    expect(res.isError).not.toBe(true);

    const jobsRes = await daemon.apiFetch('/api/jobs');
    expect(jobsRes.status).toBe(200);
    const { jobs } = (await jobsRes.json()) as { jobs: DetailedJobEntry[] };
    const job = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(job).toBeDefined();

    expect(job?.job_description.startsWith('Summary ')).toBe(false);
    expect(job?.job_description).toContain('\n');
    expect(job?.budget_amount).toContain('1,500');
    expect(job?.experience_level).toBe('Expert');
    expect(job?.duration).toContain('1 to 3 months');
    expect(job?.hours_per_week).toBe('30+ hrs/week');
    expect(job?.proposals_tier).toBe('Less than 5');
    expect(job?.client_rating).toBeCloseTo(4.95, 2);
    expect(job?.client_spent).toContain('$120K');
    expect(job?.client_spent_usd).toBe(120000);
    expect(job?.client_hires).toBe(52);
    expect(job?.client_country).toBe('United States');
  });

  test('T1-F3-02: slide-over .job-details-content drawer enrichment & search-record merge', async ({
    pairedExtension,
    daemon,
    extPages,
    upworkPage,
  }) => {
    const seedRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
        job_description: 'Initial card snippet.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        source_feed: 'search',
        source_query: 'drawer',
      }),
    });
    expect(seedRes.ok).toBe(true);

    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=drawer', {
      waitUntil: 'domcontentloaded',
    });
    await upworkPage.locator('[data-test="open-drawer-btn"]').first().click();
    await expect(upworkPage.locator('.job-details-content')).toBeVisible({ timeout: 10_000 });

    const toolbarHost = extPages.getShadowToolbar(upworkPage);
    await expect(toolbarHost).toBeAttached({ timeout: 10_000 });
    const enrichBtn = toolbarHost
      .locator('[data-testid="toolbar-enrich-btn"], [data-testid="toolbar-save-btn"], button')
      .first();
    await enrichBtn.click();

    await expect
      .poll(
        async () => {
          const listRes = await daemon.apiFetch('/api/jobs');
          const { jobs } = (await listRes.json()) as { jobs: DetailedJobEntry[] };
          const matches = jobs.filter((j) => j.upwork_job_id === '~022115332344639171');
          return matches.length === 1 && Boolean(matches[0].last_enriched_at);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const finalRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await finalRes.json()) as { jobs: DetailedJobEntry[] };
    const merged = jobs.filter((j) => j.upwork_job_id === '~022115332344639171');
    expect(merged.length).toBe(1);
    expect(merged[0].hours_per_week).toBe('30+ hrs/week');
    expect((merged[0].screening_questions ?? []).length).toBe(2);
    expect(merged[0].source_feed).toBe('search');
    expect(merged[0].source_query).toBe('drawer');
    expect(pairedExtension.errors).toEqual([]);
  });

  test('T1-F3-03: authenticated detail fields (payment_verified, client_activity, screening_questions, attachments, qualifications)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const res = await mcpHttp.callTool('upwork_get_job_details', {
      job_id: '~022115332344639171',
    });
    expect(res.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DetailedJobEntry[] };
    const created = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(created).toBeDefined();

    const detailRes = await daemon.apiFetch(`/api/jobs/${created?.id}`);
    expect(detailRes.status).toBe(200);
    const { job } = (await detailRes.json()) as { job: DetailedJobEntry };

    expect(job.payment_verified).toBe(true);
    expect(job.client_reviews).toBe(48);
    expect([85, 0.85]).toContain(job.client_hire_rate);
    expect(job.connects_required).toBe(12);
    expect(job.client_activity?.interviewing).toBe(2);
    expect(job.client_activity?.invites_sent).toBe(4);
    expect(job.client_activity?.unanswered_invites).toBe(1);
    expect(job.client_activity?.last_viewed).toBe('1 hour ago');

    expect((job.screening_questions ?? []).length).toBe(2);
    expect(job.screening_questions?.[0].prompt).toContain('Core Web Vitals');
    expect(typeof job.screening_questions?.[0].required).toBe('boolean');

    expect(JSON.stringify(job.attachments ?? [])).toContain('spec.pdf');
    expect((job.qualifications ?? []).length).toBeGreaterThan(0);
  });

  test('T1-F3-04: deterministic ScoreJob & score_breakdown driven by DB Profile.Skills & PortfolioItems', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const profileRes = await daemon.apiFetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description:
          'Senior full-stack Go, PostgreSQL, Playwright, TypeScript, and Docker engineer.',
        skills: 'Go, PostgreSQL, Playwright, TypeScript, Docker',
        portfolio_items: [
          {
            title: 'Go + PostgreSQL Telemetry Engine',
            link: 'https://github.com/example/telemetry',
            description: 'Production Go microservices and Playwright E2E suite.',
          },
        ],
      }),
    });
    expect(profileRes.ok).toBe(true);

    await mcpHttp.callTool('upwork_get_job_details', { job_id: '~022115332344639171' });
    await mcpHttp.callTool('upwork_get_job_details', { job_id: '~022111887415567641944' });

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DetailedJobEntry[] };

    const highFit = jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    const lowFit = jobs.find((j) => j.upwork_job_id === '~022111887415567641944');

    expect(highFit?.score ?? 0).toBeGreaterThanOrEqual(80);
    expect(highFit?.fit_label).toBe('hot');
    expect(highFit?.score_breakdown).toBeTruthy();
    expect(Object.keys(highFit?.score_breakdown ?? {}).length).toBeGreaterThan(0);

    expect(lowFit?.score ?? 100).toBeLessThan(40);
    expect(lowFit?.fit_label).toBe('skip');
  });

  test('T1-F3-05: backward-compatible POST /api/jobs v1.0 upwork-scraper-fs payload upsert', async ({
    daemon,
  }) => {
    const v1Payload = {
      job_title: 'v1.0 Scraper Compatibility Job',
      job_description: 'Full stack TypeScript and Go API project.',
      url: 'https://www.upwork.com/jobs/Scraper-Compat_~022199999999999999/',
      job_url: 'https://www.upwork.com/jobs/Scraper-Compat_~022199999999999999/',
      source: 'upwork-scraper-fs',
      status: 'discovered',
      contract_type: 'fixed',
      budget: '$2,000.00',
      rate_range: '',
      rate_min: '',
      rate_max: '',
      budget_amount: '$2,000.00',
      experience_level: 'Expert',
      skills: ['Go', 'TypeScript', 'PostgreSQL'],
      proposal: 'Draft v1 proposal text.',
      proposal_subject: 'Go + TypeScript Delivery',
      proposal_tone: 'direct',
      proposal_json: JSON.stringify({ intro: 'Hello', steps: ['Audit', 'Ship'] }),
      portfolio_references: [{ title: 'Ref A', url: 'https://example.com/a' }],
      time_estimate: { days: 5 },
      workload_division: { backend: '60%', frontend: '40%' },
      questions_for_client: ['Q1?'],
      tips_and_advice: ['Clarify SLA'],
      execution_prompt: 'Build cleanly.',
      tone_analysis: 'concise',
      score: 78,
    };

    const firstRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(v1Payload),
    });
    expect([200, 201]).toContain(firstRes.status);

    const secondRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...v1Payload,
        score: 92,
        time_estimate: '1 week',
        questions_for_client: 'Any existing CI?',
      }),
    });
    expect([200, 201]).toContain(secondRes.status);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DetailedJobEntry[] };
    const matches = jobs.filter((j) => j.upwork_job_id === '~022199999999999999');
    expect(matches.length).toBe(1);
    expect(matches[0].score).toBe(92);
  });

  test('T1-F3-06: batch top-N enrichment (enrich_top_n = 2) enriches only top 2 candidates', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await daemon.apiFetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'WordPress, Elementor, SEO, and FastAPI specialist.',
        skills: 'WordPress, Elementor, SEO, FastAPI, PostgreSQL',
      }),
    });

    const res = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
      enrich_top_n: 2,
    });
    expect(res.isError).not.toBe(true);

    const detailHits = await mockClient.getRequests('/jobs/');
    expect(detailHits.length).toBe(2);

    const listRes = await daemon.apiFetch('/api/jobs');
    const { jobs } = (await listRes.json()) as { jobs: DetailedJobEntry[] };
    expect(jobs.length).toBe(4);

    const enrichedJobs = jobs.filter((j) => Boolean(j.last_enriched_at));
    const unenrichedJobs = jobs.filter((j) => !j.last_enriched_at);
    expect(enrichedJobs.length).toBe(2);
    expect(unenrichedJobs.length).toBe(2);

    const minEnrichedScore = Math.min(...enrichedJobs.map((j) => j.score ?? 0));
    const maxUnenrichedScore = Math.max(...unenrichedJobs.map((j) => j.score ?? 0));
    expect(minEnrichedScore).toBeGreaterThanOrEqual(maxUnenrichedScore);
  });
});
