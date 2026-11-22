import http from 'node:http';
import path from 'node:path';
import type { Locator, Page, Request } from '@playwright/test';
import { buildDaemonBinary, type DaemonHandle, startWorkerDaemon } from '../helpers/daemon.ts';
import type { ExtensionContextHandle } from '../helpers/extension.ts';
import { type McpClient, McpHttpClient, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { getSessionStatus, pairExtensionWithDaemon } from '../helpers/pairing.ts';
import { test as baseTest, expect } from '../helpers/test-fixtures.ts';

const MOCK_AGY_API_KEY = 'e2e-mock-agy-key';

interface MockAgyRecordedRequest {
  model: string;
  effort: string;
  prompt: string;
}

interface MockAgyHandle {
  readonly baseUrl: string;
  readonly chatRequests: MockAgyRecordedRequest[];
  setDelayMs(ms: number): void;
  setFailOnTitleIncludes(substring: string | null): void;
  reset(): void;
  close(): Promise<void>;
}

async function startMockAgyServer(): Promise<MockAgyHandle> {
  const chatRequests: MockAgyRecordedRequest[] = [];
  let delayMs = 0;
  let failOnTitleIncludes: string | null = null;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    if (req.headers.authorization !== `Bearer ${MOCK_AGY_API_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'AGY_AUTH_REQUIRED' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw) as {
          model?: string;
          effort?: string;
          messages?: Array<{ role: string; content: string }>;
        };
        const prompt = parsed.messages?.map((m) => m.content).join('\n') ?? '';
        const model = parsed.model || 'gemini-pro-orchestrator-neon';
        const effort = parsed.effort || 'medium';
        chatRequests.push({ model, effort, prompt });

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        if (failOnTitleIncludes && prompt.includes(failOnTitleIncludes)) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `simulated AGY failure for ${failOnTitleIncludes}` }));
          return;
        }

        const analysisPayload = {
          proposal:
            'Built production Go + PostgreSQL services and Playwright verification suites matching your exact architecture.',
          execution_prompt:
            'Scaffold Go service layer, Atlas Postgres migration, and Playwright E2E regression tests.',
          time_estimate: '1-2 weeks',
          workload_division: '65% Go/Postgres backend / 35% TypeScript & E2E verification',
          questions_for_client: ['Do you have a staging environment ready for integration checks?'],
          tips_and_advice: ['Confirm database migration window before deployment.'],
          tone_analysis: 'confident and concise',
        };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model,
            created_at: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: JSON.stringify(analysisPayload),
            },
            done: true,
            effort_applied: Boolean(parsed.effort),
            applied_effort: effort,
            usage: {
              inputTokens: 450,
              outputTokens: 320,
              thoughtTokens: 80,
              totalTokens: 850,
            },
          }),
        );
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock AGY server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    chatRequests,
    setDelayMs(ms: number): void {
      delayMs = ms;
    },
    setFailOnTitleIncludes(substring: string | null): void {
      failOnTitleIncludes = substring;
    },
    reset(): void {
      chatRequests.length = 0;
      delayMs = 0;
      failOnTitleIncludes = null;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function rawHttpRequest(opts: {
  port: number;
  method: string;
  reqPath: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.reqPath,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.once('error', reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

interface F10WorkerFixtures {
  mockAgy: MockAgyHandle;
  agyDaemon: DaemonHandle;
}

interface F10TestFixtures {
  agyReset: undefined;
  agyPairedExtension: ExtensionContextHandle;
  agyMcpHttp: McpClient;
}

interface JobDto {
  id: number;
  upwork_job_id?: string;
  job_title: string;
  contract_type?: string;
  budget?: string;
  budget_amount?: string;
  rate_range?: string;
  proposal?: string;
  last_enriched_at?: string | null;
  ai_enrichment_status?: string;
  ai_enriched_at?: string | null;
  ai_enrichment_error?: string;
  ai_model?: string;
  ai_effort?: string;
  ai_tokens_used?: number | null;
  last_search_run_id?: number | null;
}

interface BatchItemDto {
  id: number;
  job_id: number;
  status: string;
  detail_fetched?: boolean;
  llm_invoked?: boolean;
  total_tokens?: number;
  error_code?: string;
  error_message?: string;
}

interface BatchDto {
  id: number;
  mode: string;
  status: string;
  total_count: number;
  queued_count: number;
  running_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
  canceled_count: number;
  total_tokens_used: number;
  items?: BatchItemDto[];
}

const f10Test = baseTest.extend<F10TestFixtures, F10WorkerFixtures>({
  mockAgy: [
    async ({ workerDb: _workerDb }, use) => {
      const server = await startMockAgyServer();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],

  agyDaemon: [
    async ({ workerDb, mockAgy }, use, workerInfo) => {
      const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
      let binaryPath = process.env.E2E_DAEMON_BINARY;
      if (!binaryPath) {
        binaryPath = await buildDaemonBinary(
          repoRoot,
          path.join(repoRoot, 'dist', `upwork-buddy-e2e-f10-w${workerInfo.workerIndex}`),
        );
      }
      const handle = await startWorkerDaemon({
        binaryPath,
        dbConfig: workerDb.config,
        repoRoot,
        policyMode: 'confirm_in_ui',
        extraEnv: {
          LLM_PROVIDER: 'agy',
          AGY_ENDPOINT_URL: mockAgy.baseUrl,
          AGY_API_KEY: MOCK_AGY_API_KEY,
          ENRICHMENT_MAX_BATCH_SIZE: '25',
          ENRICHMENT_DEFAULT_MODE: 'full',
          ENRICHMENT_DEFAULT_FORCE: 'false',
          ENRICHMENT_SKIP_DETAIL_IF_PRESENT: 'true',
          ENRICHMENT_REQUIRE_DETAILS: 'false',
          ENRICHMENT_MAX_CONCURRENCY: '2',
          ENRICHMENT_CONFIRM_THRESHOLD: '3',
          ENRICHMENT_WAIT_TIMEOUT_SECONDS: '30',
          WEB_UI_ENABLED: 'true',
          WEB_SESSION_TTL_MINUTES: '720',
        },
      });
      try {
        await use(handle);
      } finally {
        await handle.cleanup();
      }
    },
    { scope: 'worker' },
  ],

  agyReset: [
    async ({ mockAgy }, use) => {
      mockAgy.reset();
      await use(undefined);
    },
    { auto: true },
  ],

  agyPairedExtension: async ({ extensionCtx, agyDaemon }, use) => {
    let connected = false;
    try {
      const status = await getSessionStatus(agyDaemon);
      connected = status.extension_connected;
    } catch {
      connected = false;
    }
    if (!connected) {
      await pairExtensionWithDaemon(extensionCtx, agyDaemon, { pacingSeconds: 0.1 });
    }
    await use(extensionCtx);
  },

  agyMcpHttp: async ({ agyDaemon }, use) => {
    const client = new McpHttpClient(agyDaemon.mcpUrl, agyDaemon.apiToken);
    await client.initialize();
    try {
      await use(client);
    } finally {
      await client.close();
    }
  },
});

async function seedDashboardProfileAndProjects(daemon: DaemonHandle): Promise<void> {
  const profileRes = await daemon.apiFetch('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      description: 'Senior Go, PostgreSQL, TypeScript & WordPress architect.',
      skills: 'Go, PostgreSQL, TypeScript, Playwright, WordPress',
      target_rate: 95,
      portfolio_items: [
        {
          title: 'Public Telemetry Engine',
          link: 'https://example.com/telemetry',
          description: 'Go + PostgreSQL observability pipeline.',
        },
      ],
    }),
  });
  expect(profileRes.ok).toBe(true);

  const syncRes = await daemon.apiFetch('/api/active-projects/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projects: [
        {
          project_key: 'edfx/public-go-platform',
          name: 'Public Go Automation Platform',
          client: 'OpenSourceCo',
          group_name: 'edfx-labs',
          path: '/var/www/edfx-labs/public-go',
          activity_tier: 'active',
          status: 'active',
          proposal_visibility: 'public',
          tech_stack: ['Go', 'PostgreSQL', 'TypeScript'],
          summary: 'Public Go + PostgreSQL + TypeScript automation platform.',
        },
        {
          project_key: 'marvenio/nda-core',
          name: 'MarvenioSecretCore',
          client: 'Marvenio Holdings LLC',
          group_name: 'marvenio',
          path: '/srv/nda/marvenio/core',
          activity_tier: 'active',
          status: 'active',
          proposal_visibility: 'anonymized',
          public_alias: 'Enterprise FinTech Ledger',
          tech_stack: ['Go', 'PostgreSQL'],
          summary: 'Confidential enterprise FinTech platform.',
        },
      ],
    }),
  });
  expect(syncRes.ok).toBe(true);
}

function tableRowForJob(page: Page, jobTitleSubstring: string): Locator {
  return page.locator('tbody tr, [role="row"]').filter({ hasText: jobTitleSubstring }).first();
}

async function exerciseDashboardTableAndDrawer(opts: {
  page: Page;
  daemon: DaemonHandle;
  mockAgy: MockAgyHandle;
  expectedSurface: 'extension' | 'web';
}): Promise<void> {
  const { page, daemon, mockAgy } = opts;

  await expect(
    page.getByText(/Senior Go Systems Consultant|Go & PostgreSQL Automation Platform/i).first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  // Active Projects workload pill visible
  await expect(page.getByText(/active/i).first()).toBeVisible();

  // Search Run selector present
  const runSelector = page
    .locator('[data-testid="search-run-select"]')
    .or(page.locator('select').filter({ hasText: /All Runs|f10-|search/i }))
    .first();
  await expect(runSelector).toBeVisible();

  // Collapsible 0-token search panel with Match Active Projects toggle
  const searchPanelToggle = page
    .locator('[data-testid="toggle-search-panel-btn"]')
    .or(page.getByRole('button', { name: /run new search/i }))
    .first();
  await expect(searchPanelToggle).toBeVisible();
  await searchPanelToggle.click();
  await expect(page.getByText(/0 LLM tokens/i).first()).toBeVisible();
  const matchProjectsToggle = page
    .locator('[data-testid="match-active-projects-checkbox"]')
    .or(page.getByLabel(/match active projects/i))
    .first();
  await expect(matchProjectsToggle).toBeVisible();
  // Collapse the search panel so panel inputs cannot shadow the table filter bar
  await searchPanelToggle.click();

  // Numeric budget sort check ($2,200.00 vs $1,500.00 vs $1,000.00 across toggle clicks)
  const budgetHeader = page
    .locator('th, [role="columnheader"]')
    .filter({ hasText: /budget|rate/i })
    .first();
  await expect(budgetHeader).toBeVisible();
  const getBudgetSortIndices = async () => {
    const rowTexts = await page
      .locator('tbody tr, [role="rowgroup"]:not(thead) [role="row"]')
      .allInnerTexts();
    return {
      idx2200: rowTexts.findIndex((t) => t.includes('Go & PostgreSQL Automation Platform')),
      idx1500: rowTexts.findIndex((t) => t.includes('On-Page SEO Expert Needed')),
      idx1000: rowTexts.findIndex((t) => t.includes('Full Website Migration')),
    };
  };
  await budgetHeader.click();
  const sortAfterClick1 = await getBudgetSortIndices();
  expect(sortAfterClick1.idx2200).toBeGreaterThanOrEqual(0);
  expect(sortAfterClick1.idx1500).toBeGreaterThanOrEqual(0);
  expect(sortAfterClick1.idx1000).toBeGreaterThanOrEqual(0);
  const isDesc1 =
    sortAfterClick1.idx2200 < sortAfterClick1.idx1500 &&
    sortAfterClick1.idx1500 < sortAfterClick1.idx1000;
  const isAsc1 =
    sortAfterClick1.idx1000 < sortAfterClick1.idx1500 &&
    sortAfterClick1.idx1500 < sortAfterClick1.idx2200;
  expect(isDesc1 || isAsc1).toBe(true);

  await budgetHeader.click();
  const sortAfterClick2 = await getBudgetSortIndices();
  if (isDesc1) {
    expect(sortAfterClick2.idx1000).toBeLessThan(sortAfterClick2.idx1500);
    expect(sortAfterClick2.idx1500).toBeLessThan(sortAfterClick2.idx2200);
  } else {
    expect(sortAfterClick2.idx2200).toBeLessThan(sortAfterClick2.idx1500);
    expect(sortAfterClick2.idx1500).toBeLessThan(sortAfterClick2.idx1000);
  }

  // Filter by query + verify focus preservation during live polling
  const testIdFilterInput = page.locator('[data-testid="filter-query-input"]');
  const searchInput =
    (await testIdFilterInput.count()) > 0
      ? testIdFilterInput.first()
      : page.locator('input[type="search"], input[placeholder*="Search" i]').first();
  await expect(searchInput).toBeVisible();
  await searchInput.focus();

  // Select 5 body rows using Shift+Click range selection (guarantees >= 4 unenriched rows > threshold 3)
  const rowCheckboxSelector =
    'tbody input[type="checkbox"], [role="rowgroup"]:not(thead) [role="row"] input[type="checkbox"]';
  const rowCheckboxes = page.locator(rowCheckboxSelector);
  const checkboxCount = await rowCheckboxes.count();
  expect(checkboxCount).toBeGreaterThanOrEqual(5);

  await rowCheckboxes.nth(0).click();
  await rowCheckboxes.nth(4).click({ modifiers: ['Shift'] });

  const checkedAfterShift = await page
    .locator(
      'tbody input[type="checkbox"]:checked, [role="rowgroup"]:not(thead) [role="row"] input[type="checkbox"]:checked',
    )
    .count();
  expect(checkedAfterShift).toBeGreaterThanOrEqual(5);

  // Sticky bulk selection bar appears; clicking Enrich Selected opens confirmation modal (> 3 threshold)
  const enrichSelectedBtn = page
    .locator('[data-testid="enrich-selected-btn"]')
    .or(page.getByRole('button', { name: /enrich selected/i }))
    .first();
  await expect(enrichSelectedBtn).toBeVisible();

  const agyCountBeforeCancel = mockAgy.chatRequests.length;
  let enrichPostCount = 0;
  const onRequest = (req: Request) => {
    if (req.method() === 'POST' && req.url().includes('/api/jobs/enrich')) {
      enrichPostCount += 1;
    }
  };
  page.context().on('request', onRequest);

  try {
    await enrichSelectedBtn.click();
    const confirmCancelBtn = page
      .locator('[data-testid="confirm-enrich-cancel-btn"]')
      .or(page.getByRole('dialog').getByRole('button', { name: /cancel/i }))
      .or(page.getByRole('button', { name: /^cancel$/i }))
      .first();
    await expect(confirmCancelBtn).toBeVisible();
    await confirmCancelBtn.click();
    expect(enrichPostCount).toBe(0);
    expect(mockAgy.chatRequests.length).toBe(agyCountBeforeCancel);

    // Launch a slow batch (delayMs = 2500 -> >= 5s for 4+ unenriched rows at concurrency 2) and verify 2s live polling keeps focus + open drawer, then Cancel Remaining
    mockAgy.setDelayMs(2_500);
    await enrichSelectedBtn.click();
    const confirmProceedBtn = page
      .locator('[data-testid="confirm-enrich-proceed-btn"]')
      .or(page.getByRole('dialog').getByRole('button', { name: /confirm|enrich|proceed|start/i }))
      .or(page.getByRole('button', { name: /confirm enrich|start enrichment|proceed/i }))
      .first();
    await confirmProceedBtn.click();
    await expect.poll(() => enrichPostCount, { timeout: 10_000 }).toBe(1);
  } finally {
    page.context().off('request', onRequest);
  }

  const cancelRemainingBtn = page
    .locator('[data-testid="cancel-batch-btn"]')
    .or(page.getByRole('button', { name: /cancel remaining/i }))
    .first();
  await expect(cancelRemainingBtn).toBeVisible({ timeout: 10_000 });

  // Open Inspector Drawer while batch is running and focus filter input to verify partitioned DOM polling stability
  const targetRow = tableRowForJob(page, 'Go & PostgreSQL Automation Platform');
  await targetRow
    .getByText(/Go & PostgreSQL Automation Platform/i)
    .first()
    .click();
  await expect(page.getByText(/Overview/i).first()).toBeVisible({ timeout: 10_000 });
  await searchInput.focus();
  await page.waitForTimeout(2_200);
  expect(await searchInput.evaluate((el) => document.activeElement === el)).toBe(true);
  await expect(page.getByText(/Overview/i).first()).toBeVisible();

  const drawerCloseBtn = page
    .locator('[data-testid="drawer-close-btn"]')
    .or(page.getByRole('button', { name: /close drawer|close/i }))
    .first();
  await expect(drawerCloseBtn).toBeVisible();
  await drawerCloseBtn.click();
  await expect(page.locator('[data-testid="job-inspector-drawer"]')).toBeHidden();

  await expect(cancelRemainingBtn).toBeVisible({ timeout: 10_000 });
  await cancelRemainingBtn.click();

  // Wait for batches to settle, verify cancellation recorded, then reset delayMs immediately
  let latestBatch: BatchDto | undefined;
  await expect
    .poll(
      async () => {
        const res = await daemon.apiFetch('/api/enrichment-batches');
        const body = (await res.json()) as { batches: BatchDto[] };
        latestBatch = body.batches[0];
        return (
          body.batches.length > 0 &&
          body.batches.every((b) => ['completed', 'canceled', 'failed'].includes(b.status))
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  mockAgy.setDelayMs(0);
  expect((latestBatch?.canceled_count ?? 0) >= 1 || latestBatch?.status === 'canceled').toBe(true);

  await targetRow
    .getByText(/Go & PostgreSQL Automation Platform/i)
    .first()
    .click();
  await expect(page.getByText(/Overview/i).first()).toBeVisible({ timeout: 10_000 });

  // Switch to AI Analysis tab BEFORE clicking drawerEnrichBtn, then enrich cleanly and verify metadata + refs
  const aiTab = page
    .locator('[data-testid="drawer-tab-ai"]')
    .or(page.getByRole('tab', { name: /ai analysis/i }))
    .or(page.getByRole('button', { name: /ai analysis/i }))
    .first();
  await expect(aiTab).toBeVisible();
  await aiTab.click();

  const drawerEnrichBtn = page
    .locator('[data-testid="drawer-enrich-btn"]')
    .or(page.getByRole('button', { name: /enrich\s*\/\s*re-analyze|analyze job/i }))
    .first();
  await expect(drawerEnrichBtn).toBeVisible({ timeout: 10_000 });
  await drawerEnrichBtn.click();

  const drawer = page.locator('[data-testid="job-inspector-drawer"]');
  await expect(drawer.getByText(/Built production Go \+ PostgreSQL services/i).first()).toBeVisible(
    {
      timeout: 15_000,
    },
  );
  await expect(drawer.getByText(/\[PUBLIC\]/i).first()).toBeVisible();
  await expect(drawer.getByText(/\[ANONYMIZED\/NDA\]/i).first()).toBeVisible();
  await expect(drawer.getByText(/gemini-pro-orchestrator-neon/i).first()).toBeVisible();
  await expect(drawer.getByText(/\bmedium\b/i).first()).toBeVisible();
  await expect(drawer.getByText(/850/i).first()).toBeVisible();

  // Save as Proposal Draft from drawer
  const saveDraftBtn = page
    .locator('[data-testid="save-proposal-draft-btn"]')
    .or(page.getByRole('button', { name: /save as proposal draft/i }))
    .first();
  await saveDraftBtn.click();

  await expect
    .poll(
      async () => {
        const propRes = await daemon.apiFetch('/api/proposals');
        if (!propRes.ok) return 0;
        const propBody = (await propRes.json()) as { proposals: Array<{ id: number }> };
        return propBody.proposals.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);
}

f10Test.describe(
  'Tier 2 F10 — Decoupled Search, Batch AI Enrichment & Dual-Surface Dashboard (R1–R5)',
  () => {
    f10Test(
      'T2-F10-01: R1 multi-criteria search, SearchRun provenance, GET /api/jobs total/filtering & mergeIncomingJob AI preservation (0 LLM tokens)',
      async ({ agyPairedExtension, agyDaemon, mockClient, mockAgy }) => {
        expect(agyPairedExtension.extensionId.length).toBeGreaterThan(0);

        const searchRes = await agyDaemon.apiFetch('/api/jobs/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'search',
            query: 'WordPress',
            max_pages: 2,
            contract_type: 'hourly',
            hourly_rate_min: 70,
            hourly_rate_max: 130,
            payment_verified_only: true,
            skip_auto_detail_enrich: true,
            run_label: 'f10-r1-multi-criteria',
          }),
        });
        expect(searchRes.status).toBe(200);
        const searchBody = (await searchRes.json()) as {
          search_run_id?: number;
          dashboard_url?: string;
          jobs: JobDto[];
        };
        expect(searchBody.search_run_id ?? 0).toBeGreaterThan(0);
        expect(searchBody.dashboard_url ?? '').toContain('/dashboard/');

        // 0 LLM calls and 0 Chrome detail scrapes
        expect(mockAgy.chatRequests).toHaveLength(0);
        expect(await mockClient.getRequests('/jobs/')).toHaveLength(0);

        // Verify MockUpworkServer received hourly_rate and payment_verified query params
        const searchRequests = await mockClient.getRequests('/nx/search/jobs/');
        expect(searchRequests.length).toBeGreaterThanOrEqual(1);
        const firstQuery = searchRequests[0].query;
        expect(firstQuery.payment_verified).toBe('1');
        expect(firstQuery.hourly_rate ?? '').toContain('70');
        expect(firstQuery.hourly_rate ?? '').toContain('130');

        // SearchRun list & detail endpoints
        const runsRes = await agyDaemon.apiFetch('/api/search-runs');
        expect(runsRes.status).toBe(200);
        const runsBody = (await runsRes.json()) as {
          search_runs: Array<{ id: number; label: string; persisted_count: number }>;
        };
        expect(runsBody.search_runs.some((r) => r.id === searchBody.search_run_id)).toBe(true);

        const runDetailRes = await agyDaemon.apiFetch(
          `/api/search-runs/${searchBody.search_run_id}`,
        );
        expect(runDetailRes.status).toBe(200);
        const runDetailText = await runDetailRes.text();
        expect(runDetailText).toContain('f10-r1-multi-criteria');

        // Upgraded GET /api/jobs with filtering, sorting & total count
        const jobsRes = await agyDaemon.apiFetch(
          `/api/jobs?search_run_id=${searchBody.search_run_id}&contract_type=hourly&hourly_rate_min=70&sort=budget_desc`,
        );
        expect(jobsRes.status).toBe(200);
        const jobsBody = (await jobsRes.json()) as { jobs: JobDto[]; total: number };
        expect(jobsBody.total).toBe(jobsBody.jobs.length);
        expect(jobsBody.total).toBeGreaterThanOrEqual(1);
        const hourlyJob = jobsBody.jobs.find((j) => j.upwork_job_id === '~022115332344639180');
        expect(hourlyJob).toBeDefined();

        // AI-enrich hourlyJob, then re-scrape via another search run and confirm mergeIncomingJob preserves ai_* fields
        const analyzeRes = await agyDaemon.apiFetch(`/api/jobs/${hourlyJob?.id}/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ use_llm: true }),
        });
        expect(analyzeRes.status).toBe(200);
        expect(mockAgy.chatRequests).toHaveLength(1);

        const rescrapeRes = await agyDaemon.apiFetch('/api/jobs/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'search',
            query: 'WordPress',
            max_pages: 2,
            skip_auto_detail_enrich: true,
            run_label: 'f10-r1-rescrape',
          }),
        });
        expect(rescrapeRes.status).toBe(200);
        const rescrapeBody = (await rescrapeRes.json()) as { search_run_id: number };
        expect(rescrapeBody.search_run_id).toBeGreaterThan(searchBody.search_run_id ?? 0);
        expect(mockAgy.chatRequests).toHaveLength(1);

        const afterRescrapeRes = await agyDaemon.apiFetch(`/api/jobs/${hourlyJob?.id}`);
        expect(afterRescrapeRes.status).toBe(200);
        const { job: preservedJob } = (await afterRescrapeRes.json()) as { job: JobDto };
        expect(preservedJob.last_search_run_id).toBe(rescrapeBody.search_run_id);
        expect(preservedJob.ai_enrichment_status).toBe('completed');
        expect(preservedJob.ai_tokens_used ?? 0).toBeGreaterThan(0);
        expect((preservedJob.proposal ?? '').length).toBeGreaterThan(0);
        expect((preservedJob.ai_model ?? '').length).toBeGreaterThan(0);

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    f10Test(
      'T2-F10-02: R1 NDA-safe from_active_projects query seeding (only eligible tech_stack, zero sensitive/private/archived leaks)',
      async ({ agyPairedExtension, agyDaemon, mockClient, mockAgy }) => {
        expect(agyPairedExtension.extensionId.length).toBeGreaterThan(0);

        const syncRes = await agyDaemon.apiFetch('/api/active-projects/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projects: [
              {
                project_key: 'marvenio/secret-core',
                name: 'MarvenioSecretCore',
                client: 'Marvenio Holdings LLC',
                group_name: 'marvenio-confidential',
                path: '/srv/nda/marvenio/core',
                activity_tier: 'active',
                status: 'active',
                proposal_visibility: 'anonymized',
                public_alias: 'ConfidentialFintechAlias',
                tech_stack: ['Go', 'PostgreSQL'],
                summary: 'Confidential Marvenio billing engine.',
              },
              {
                project_key: 'stealth/vault',
                name: 'StealthVaultApp',
                client: 'StealthCorp',
                activity_tier: 'active',
                status: 'active',
                proposal_visibility: 'private',
                tech_stack: ['Rust', 'Solana'],
                summary: 'Private stealth blockchain project.',
              },
              {
                project_key: 'legacy/old-portal',
                name: 'OldLegacyPortal',
                client: 'LegacyClient',
                activity_tier: 'archived',
                status: 'archived',
                proposal_visibility: 'public',
                tech_stack: ['COBOL'],
                summary: 'Archived mainframe project.',
              },
            ],
          }),
        });
        expect(syncRes.ok).toBe(true);

        const searchRes = await agyDaemon.apiFetch('/api/jobs/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from_active_projects: true,
            skip_auto_detail_enrich: true,
            run_label: 'f10-nda-seeded',
          }),
        });
        expect(searchRes.status).toBe(200);
        expect(mockAgy.chatRequests).toHaveLength(0);

        const searchReqs = await mockClient.getRequests('/nx/search/jobs/');
        expect(searchReqs.length).toBeGreaterThanOrEqual(1);

        const normalizedQueryText = searchReqs
          .map((r) => {
            let decodedSearch = r.search;
            try {
              decodedSearch = decodeURIComponent(r.search.replace(/\+/g, ' '));
            } catch {
              decodedSearch = r.search;
            }
            return `${r.path} ${decodedSearch} ${JSON.stringify(r.query)}`;
          })
          .join('\n')
          .toLowerCase();
        expect(normalizedQueryText).toMatch(/\bgo\b|postgresql/);

        for (const forbidden of [
          'marvenio/secret-core',
          'MarvenioSecretCore',
          'Marvenio Holdings LLC',
          'marvenio-confidential',
          '/srv/nda/marvenio/core',
          'ConfidentialFintechAlias',
          'Confidential Marvenio billing engine',
          'billing engine',
          'marvenio',
          'stealth/vault',
          'StealthVaultApp',
          'StealthCorp',
          'Rust',
          'Solana',
          'Private stealth blockchain project',
          'blockchain',
          'legacy/old-portal',
          'OldLegacyPortal',
          'LegacyClient',
          'COBOL',
          'Archived mainframe project',
          'mainframe',
        ]) {
          expect(normalizedQueryText).not.toContain(forbidden.toLowerCase());
        }

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    f10Test(
      'T2-F10-03: R2 config/cap guardrails, detail_only vs ai_only, Chrome-offline fallback vs require_details, HUMAN_ACTION_REQUIRED halt & AGY failure status',
      async ({ agyPairedExtension, agyDaemon, mockClient, mockAgy, workerDb }) => {
        expect(agyPairedExtension.extensionId.length).toBeGreaterThan(0);

        const cfgRes = await agyDaemon.apiFetch('/api/enrichment-config');
        expect(cfgRes.status).toBe(200);
        const cfg = (await cfgRes.json()) as {
          max_batch_size: number;
          default_mode: string;
          default_force: boolean;
          confirm_threshold: number;
          web_ui_enabled: boolean;
        };
        expect(cfg.max_batch_size).toBe(25);
        expect(cfg.default_mode).toBe('full');
        expect(cfg.default_force).toBe(false);
        expect(cfg.confirm_threshold).toBe(3);
        expect(cfg.web_ui_enabled).toBe(true);

        // Exceeding ENRICHMENT_MAX_BATCH_SIZE (26 IDs > 25) -> 400 INVALID_PARAMS, 0 batches, 0 AGY calls
        const overCapRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: Array.from({ length: 26 }, (_, i) => i + 1),
            mode: 'ai_only',
          }),
        });
        expect(overCapRes.status).toBe(400);
        expect(await overCapRes.text()).toContain('INVALID_PARAMS');
        const batchesAfterCap = (await (
          await agyDaemon.apiFetch('/api/enrichment-batches')
        ).json()) as {
          batches: BatchDto[];
        };
        expect(batchesAfterCap.batches).toHaveLength(0);
        expect(mockAgy.chatRequests).toHaveLength(0);

        // Seed 2 jobs for detail_only vs ai_only checks
        const seededIds: number[] = [];
        for (const item of [
          {
            upwork_job_id: '~022115332344639171',
            job_title: 'On-Page SEO Expert Needed',
            job_description: 'Short card text.',
            url: 'https://www.upwork.com/jobs/~022115332344639171/',
          },
          {
            upwork_job_id: '~022115332344639172',
            job_title: 'WordPress Landing Page Cleanup',
            job_description: 'Short cleanup text.',
            url: 'https://www.upwork.com/jobs/~022115332344639172/',
          },
        ]) {
          const res = await agyDaemon.apiFetch('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item),
          });
          expect(res.ok).toBe(true);
          const created = (await res.json()) as { id: number };
          seededIds.push(created.id);
        }

        // detail_only -> 2 Chrome detail scrapes, 0 AGY calls, GET /api/jobs?enrichment_status=detail_only matches
        const detailOnlyRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job_ids: seededIds, mode: 'detail_only', wait: true }),
        });
        expect(detailOnlyRes.status).toBe(200);
        expect(mockAgy.chatRequests).toHaveLength(0);
        const detailHitsAfterDetailOnly = await mockClient.getRequests('/jobs/');
        expect(detailHitsAfterDetailOnly).toHaveLength(2);

        const detailListRes = await agyDaemon.apiFetch('/api/jobs?enrichment_status=detail_only');
        expect(detailListRes.status).toBe(200);
        const detailList = (await detailListRes.json()) as { jobs: JobDto[]; total: number };
        expect(detailList.total).toBe(2);

        // ai_only -> 0 new Chrome detail scrapes, 2 AGY calls, token/model/effort persisted
        const aiOnlyRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job_ids: seededIds, mode: 'ai_only', wait: true }),
        });
        expect(aiOnlyRes.status).toBe(200);
        expect(await mockClient.getRequests('/jobs/')).toHaveLength(2);
        expect(mockAgy.chatRequests).toHaveLength(2);

        const enrichedJobRes = await agyDaemon.apiFetch(`/api/jobs/${seededIds[0]}`);
        const { job: enrichedJob } = (await enrichedJobRes.json()) as { job: JobDto };
        expect(enrichedJob.ai_enrichment_status).toBe('completed');
        expect(enrichedJob.ai_tokens_used).toBe(850);
        expect(enrichedJob.ai_model).toBe('gemini-pro-orchestrator-neon');
        expect(enrichedJob.ai_effort).toBe('medium');

        // Programmable Mock AGY failure sets ai_enrichment_status = 'failed'
        mockAgy.setFailOnTitleIncludes('WordPress Landing Page Cleanup');
        const failRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: [seededIds[1]],
            mode: 'ai_only',
            force: true,
            wait: true,
          }),
        });
        expect(failRes.status).toBe(200);
        const failBatch = (await failRes.json()) as { batch?: BatchDto } & BatchDto;
        const failBatchObj = failBatch.batch ?? failBatch;
        expect(failBatchObj.failed_count).toBe(1);

        const failedJobRes = await agyDaemon.apiFetch(`/api/jobs/${seededIds[1]}`);
        const { job: failedJob } = (await failedJobRes.json()) as { job: JobDto };
        expect(failedJob.ai_enrichment_status).toBe('failed');
        expect((failedJob.ai_enrichment_error ?? '').length).toBeGreaterThan(0);
        mockAgy.setFailOnTitleIncludes(null);

        // HUMAN_ACTION_REQUIRED mid-batch detail halt preserves job 1 and halts remaining Chrome scrapes
        const challengeIds: number[] = [];
        for (const cid of [
          '~040200000000000000001',
          '~040200000000000000002',
          '~040200000000000000003',
        ] as const) {
          const res = await agyDaemon.apiFetch('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              upwork_job_id: cid,
              job_title: `Challenge Job ${cid}`,
              job_description: 'Card text prior to detail scrape.',
              url: `https://www.upwork.com/jobs/${cid}/`,
            }),
          });
          expect(res.ok).toBe(true);
          challengeIds.push(((await res.json()) as { id: number }).id);
        }

        const detailReqsBeforeChallenge = (await mockClient.getRequests('/jobs/')).length;
        await mockClient.setScenario({
          challenge: 'cloudflare',
          challengeOnPath: '/jobs/.*~040200000000000000002',
        });
        const challengeBatchRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: challengeIds,
            mode: 'detail_only',
            wait: true,
          }),
        });
        expect(challengeBatchRes.status).toBe(200);
        const challengeBatchRaw = (await challengeBatchRes.json()) as {
          batch?: BatchDto;
        } & BatchDto;
        const challengeBatch = challengeBatchRaw.batch ?? challengeBatchRaw;
        expect(challengeBatch.failed_count).toBeGreaterThanOrEqual(1);
        const challengeItems = challengeBatch.items ?? [];
        if (challengeItems.length > 0) {
          const failedItem = challengeItems.find((item) => item.job_id === challengeIds[1]);
          expect(failedItem?.status).toBe('failed');
          expect(`${failedItem?.error_code ?? ''} ${failedItem?.error_message ?? ''}`).toMatch(
            /HUMAN_ACTION_REQUIRED|403|challenge|cloudflare/i,
          );
        }

        const firstAfterChallenge = (
          (await (await agyDaemon.apiFetch(`/api/jobs/${challengeIds[0]}`)).json()) as {
            job: JobDto;
          }
        ).job;
        expect(firstAfterChallenge.last_enriched_at).toBeTruthy();

        const thirdAfterChallenge = (
          (await (await agyDaemon.apiFetch(`/api/jobs/${challengeIds[2]}`)).json()) as {
            job: JobDto;
          }
        ).job;
        expect(thirdAfterChallenge.last_enriched_at ?? null).toBeNull();

        const detailReqsAfterChallenge = await mockClient.getRequests('/jobs/');
        const newDetailReqs = detailReqsAfterChallenge.slice(detailReqsBeforeChallenge);
        expect(newDetailReqs.some((r) => r.pathname.includes('~040200000000000000003'))).toBe(
          false,
        );
        await mockClient.reset();

        // Chrome offline fallback (require_details=false succeeds vs require_details=true fails item)
        const offlineSeedRes = await agyDaemon.apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            upwork_job_id: '~040200000000000000004',
            job_title: 'Offline Fallback Job',
            job_description: 'Stored description used when Chrome is disconnected.',
            url: 'https://www.upwork.com/jobs/~040200000000000000004/',
          }),
        });
        expect(offlineSeedRes.ok).toBe(true);
        const offlineJobId = ((await offlineSeedRes.json()) as { id: number }).id;

        const offlineDaemon = await startWorkerDaemon({
          binaryPath: agyDaemon.binaryPath,
          dbConfig: workerDb.config,
          repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
          extraEnv: {
            LLM_PROVIDER: 'agy',
            AGY_ENDPOINT_URL: mockAgy.baseUrl,
            AGY_API_KEY: MOCK_AGY_API_KEY,
          },
        });
        try {
          const fallbackOkRes = await offlineDaemon.apiFetch('/api/jobs/enrich', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              job_ids: [offlineJobId],
              mode: 'full',
              require_details: false,
              wait: true,
            }),
          });
          expect(fallbackOkRes.status).toBe(200);
          const fallbackBatch = (await fallbackOkRes.json()) as { batch?: BatchDto } & BatchDto;
          expect((fallbackBatch.batch ?? fallbackBatch).completed_count).toBe(1);

          const requireDetailsFailRes = await offlineDaemon.apiFetch('/api/jobs/enrich', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              job_ids: [offlineJobId],
              mode: 'full',
              force: true,
              skip_detail_if_present: false,
              require_details: true,
              wait: true,
            }),
          });
          expect(requireDetailsFailRes.status).toBe(200);
          const requireFailBatch = (await requireDetailsFailRes.json()) as {
            batch?: BatchDto;
          } & BatchDto;
          expect((requireFailBatch.batch ?? requireFailBatch).failed_count).toBe(1);
        } finally {
          await offlineDaemon.cleanup();
        }
      },
    );

    f10Test(
      'T2-F10-04: R2 force=false skip-cached idempotency, mid-batch cancel & startup crash recovery (RecoverInterruptedBatches)',
      async ({ agyPairedExtension, agyDaemon, mockAgy, workerDb }) => {
        expect(agyPairedExtension.extensionId.length).toBeGreaterThan(0);

        const jobIds: number[] = [];
        for (const upworkId of [
          '~022115332344639171',
          '~022115332344639172',
          '~022111887415567641941',
          '~022111887415567641942',
        ] as const) {
          const res = await agyDaemon.apiFetch('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              upwork_job_id: upworkId,
              job_title: `Batch Idempotency Job ${upworkId}`,
              job_description: 'Testing force=false skip idempotency and cancellation.',
              url: `https://www.upwork.com/jobs/${upworkId}/`,
            }),
          });
          expect(res.ok).toBe(true);
          jobIds.push(((await res.json()) as { id: number }).id);
        }

        // Pre-enrich job 0
        const preRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job_ids: [jobIds[0]], mode: 'ai_only', wait: true }),
        });
        expect(preRes.status).toBe(200);
        expect(mockAgy.chatRequests).toHaveLength(1);

        // Run batch of 3 with force=false -> skips job 0, calls AGY only twice
        const skipRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: jobIds.slice(0, 3),
            mode: 'ai_only',
            force: false,
            wait: true,
          }),
        });
        expect(skipRes.status).toBe(200);
        const skipRaw = (await skipRes.json()) as { batch?: BatchDto } & BatchDto;
        const skipBatch = skipRaw.batch ?? skipRaw;
        expect(skipBatch.skipped_count).toBe(1);
        expect(skipBatch.completed_count).toBe(2);
        expect(mockAgy.chatRequests).toHaveLength(3);

        // Re-run with force=true -> re-enriches all 3 (3 more AGY calls)
        const forceRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: jobIds.slice(0, 3),
            mode: 'ai_only',
            force: true,
            wait: true,
          }),
        });
        expect(forceRes.status).toBe(200);
        const forceRaw = (await forceRes.json()) as { batch?: BatchDto } & BatchDto;
        const forceBatch = forceRaw.batch ?? forceRaw;
        expect(forceBatch.skipped_count).toBe(0);
        expect(forceBatch.completed_count).toBe(3);
        expect(mockAgy.chatRequests).toHaveLength(6);

        // Mid-batch cancellation with slow Mock AGY
        mockAgy.setDelayMs(600);
        const countBeforeCancelBatch = mockAgy.chatRequests.length;
        const asyncRes = await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_ids: jobIds,
            mode: 'ai_only',
            force: true,
            max_concurrency: 1,
            wait: false,
          }),
        });
        expect(asyncRes.status).toBe(202);
        const asyncRaw = (await asyncRes.json()) as { batch?: BatchDto } & BatchDto;
        const cancelBatchId = (asyncRaw.batch ?? asyncRaw).id;

        await expect
          .poll(() => mockAgy.chatRequests.length, { timeout: 10_000 })
          .toBeGreaterThanOrEqual(countBeforeCancelBatch + 1);

        const cancelRes = await agyDaemon.apiFetch(
          `/api/enrichment-batches/${cancelBatchId}/cancel`,
          {
            method: 'POST',
          },
        );
        expect(cancelRes.ok).toBe(true);

        let finalCancelBatch: BatchDto | undefined;
        await expect
          .poll(
            async () => {
              const getRes = await agyDaemon.apiFetch(`/api/enrichment-batches/${cancelBatchId}`);
              const getRaw = (await getRes.json()) as { batch?: BatchDto } & BatchDto;
              finalCancelBatch = getRaw.batch ?? getRaw;
              return ['canceled', 'completed', 'failed'].includes(finalCancelBatch.status);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        expect(finalCancelBatch?.canceled_count ?? 0).toBeGreaterThanOrEqual(1);
        mockAgy.setDelayMs(0);

        // Startup crash recovery (RecoverInterruptedBatches): simulate interrupted running batch & analyzing job, restart daemon
        const insertedBatches = await workerDb.query<{ id: number }>(
          `INSERT INTO enrichment_batches (mode, triggered_by, force, status, total_count, queued_count, running_count, completed_count, skipped_count, failed_count, canceled_count, total_tokens_used, created_at, updated_at)
         VALUES ('ai_only', 'ui', false, 'running', 1, 0, 1, 0, 0, 0, 0, 0, NOW(), NOW())
         RETURNING id`,
        );
        const interruptedBatchId = insertedBatches[0].id;
        await workerDb.query(
          `INSERT INTO enrichment_batch_items (batch_id, job_id, status, detail_fetched, llm_invoked, input_tokens, output_tokens, thought_tokens, total_tokens, created_at, updated_at)
         VALUES ($1, $2, 'running', false, false, 0, 0, 0, 0, NOW(), NOW())`,
          [interruptedBatchId, jobIds[3]],
        );
        await workerDb.query(`UPDATE jobs SET ai_enrichment_status = 'analyzing' WHERE id = $1`, [
          jobIds[3],
        ]);

        await agyDaemon.restart();

        const recoveredBatchRes = await agyDaemon.apiFetch(
          `/api/enrichment-batches/${interruptedBatchId}`,
        );
        expect(recoveredBatchRes.status).toBe(200);
        const recoveredBatchRaw = (await recoveredBatchRes.json()) as {
          batch?: BatchDto;
        } & BatchDto;
        const recoveredBatch = recoveredBatchRaw.batch ?? recoveredBatchRaw;
        expect(['running', 'queued']).not.toContain(recoveredBatch.status);

        const recoveredJobRes = await agyDaemon.apiFetch(`/api/jobs/${jobIds[3]}`);
        const { job: recoveredJob } = (await recoveredJobRes.json()) as { job: JobDto };
        expect(['queued', 'scraping_details', 'analyzing']).not.toContain(
          recoveredJob.ai_enrichment_status,
        );

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    f10Test(
      'T2-F10-05: R3 extension dashboard.html via Popup/SidePanel launchers & openDashboard(), TanStack Table, batch polling, NDA drawer & XSS safety',
      async ({ agyPairedExtension, agyDaemon, agyMcpHttp, extPages, mockAgy }) => {
        await seedDashboardProfileAndProjects(agyDaemon);

        // Run 0-token searches to populate jobs
        const s1 = await agyMcpHttp.callTool('upwork_search_jobs', {
          source: 'search',
          query: 'go postgresql',
          max_pages: 1,
          skip_auto_detail_enrich: true,
          run_label: 'f10-ext-go',
          compact: true,
        });
        expect(s1.isError).not.toBe(true);

        const s2 = await agyMcpHttp.callTool('upwork_search_jobs', {
          source: 'search',
          query: 'WordPress',
          max_pages: 2,
          skip_auto_detail_enrich: true,
          run_label: 'f10-ext-wp',
          compact: true,
        });
        expect(s2.isError).not.toBe(true);

        // Seed a job with stored XSS payload in title/description to verify table & drawer escaping
        const xssJobRes = await agyDaemon.apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            upwork_job_id: '~0888000000000000001',
            job_title: '<img src=x onerror="window.__xss=1">XSS Dashboard Job',
            job_description: '<svg onload="window.__xss=2">Malicious description</svg>',
            url: 'https://www.upwork.com/jobs/~0888000000000000001/',
          }),
        });
        expect(xssJobRes.ok).toBe(true);

        // Pre-enrich 1 job so Side Panel .sp-card AI badge can also be verified
        const preList = (await (await agyDaemon.apiFetch('/api/jobs')).json()) as {
          jobs: JobDto[];
        };
        const preTarget = preList.jobs.find((j) => j.upwork_job_id === '~033000000000000000001');
        expect(preTarget).toBeDefined();
        await agyDaemon.apiFetch('/api/jobs/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job_ids: [preTarget?.id], mode: 'ai_only', wait: true }),
        });

        // Launcher 1: Popup "Open Jobs Table"
        const popup = await extPages.openPopup();
        try {
          const popupOpenBtn = popup
            .locator('[data-testid="open-jobs-table-btn"]')
            .or(popup.getByRole('button', { name: /open jobs table/i }))
            .first();
          await expect(popupOpenBtn).toBeVisible();
          const [popupDashPage] = await Promise.all([
            agyPairedExtension.context.waitForEvent('page'),
            popupOpenBtn.click(),
          ]);
          await popupDashPage.waitForLoadState('domcontentloaded');
          expect(popupDashPage.url()).toContain('dashboard.html');
          await popupDashPage.close();
        } finally {
          await popup.close();
        }

        // Launcher 2: Side Panel "Open Full Table ↗" + preserved existing selectors + AI badge on .sp-card
        const sidePanel = await extPages.openSidePanel();
        try {
          await expect(sidePanel.locator('[data-testid="filter-min-score"]')).toBeVisible();
          await expect(sidePanel.locator('[data-testid="filter-fit"]')).toBeVisible();
          await expect(sidePanel.locator('[data-testid="filter-query"]')).toBeVisible();
          await expect(sidePanel.locator('[data-testid="tab-approvals"]')).toBeVisible();
          await expect(sidePanel.locator('.sp-card').first()).toBeVisible({ timeout: 15_000 });
          await expect(
            sidePanel
              .locator('.sp-card [data-testid*="ai"], .sp-card .sp-badge')
              .or(sidePanel.locator('.sp-card').getByText(/ai enriched|ai status/i))
              .first(),
          ).toBeVisible();

          const spOpenBtn = sidePanel
            .locator('[data-testid="open-full-table-btn"]')
            .or(sidePanel.getByRole('button', { name: /open full table/i }))
            .first();
          await expect(spOpenBtn).toBeVisible();
          const [spDashPage] = await Promise.all([
            agyPairedExtension.context.waitForEvent('page'),
            spOpenBtn.click(),
          ]);
          await spDashPage.waitForLoadState('domcontentloaded');
          expect(spDashPage.url()).toContain('dashboard.html');
          await spDashPage.close();
        } finally {
          await sidePanel.close();
        }

        // Direct openDashboard() test of full shared TanStack Table + Drawer + XSS check
        const dashPage = await extPages.openDashboard();
        const dialogs: string[] = [];
        dashPage.on('dialog', (d) => {
          dialogs.push(d.message());
          void d.dismiss();
        });
        try {
          await exerciseDashboardTableAndDrawer({
            page: dashPage,
            daemon: agyDaemon,
            mockAgy,
            expectedSurface: 'extension',
          });

          // Close current drawer if open, then click 'XSS Dashboard Job' to render job_description in the Inspector Drawer
          const drawerCloseBtn = dashPage
            .locator('[data-testid="drawer-close-btn"]')
            .or(dashPage.getByRole('button', { name: /close drawer|close/i }))
            .first();
          if ((await drawerCloseBtn.count()) > 0 && (await drawerCloseBtn.isVisible())) {
            await drawerCloseBtn.click();
          } else {
            await dashPage.keyboard.press('Escape');
          }

          const xssRow = tableRowForJob(dashPage, 'XSS Dashboard Job');
          await expect(xssRow).toBeVisible({ timeout: 10_000 });
          await expect(xssRow).toContainText('XSS Dashboard Job');
          await xssRow
            .getByText(/XSS Dashboard Job/i)
            .first()
            .click();

          await expect(dashPage.getByText(/Malicious description/i).first()).toBeVisible({
            timeout: 10_000,
          });
          await expect(dashPage.getByText(/XSS Dashboard Job/i).first()).toBeVisible();

          // Verify XSS payload escaped in table & drawer
          const xssFlag = await dashPage.evaluate(
            () => (window as unknown as { __xss?: unknown }).__xss,
          );
          expect(xssFlag).toBeUndefined();
          expect(await dashPage.locator('img[src="x"], svg[onload]').count()).toBe(0);
          expect(dialogs).toEqual([]);
        } finally {
          await dashPage.close();
        }

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    f10Test(
      'T2-F10-06: R3 + R5 standalone /dashboard/ ticket exchange, URL strip, CSP/headers, fail-closed /api/*, GET / invariant & table parity',
      async ({ agyPairedExtension, agyDaemon, agyMcpHttp, mockAgy }) => {
        await seedDashboardProfileAndProjects(agyDaemon);

        // 1. GET / invariant & fail-closed /api/*
        const rootRes = await fetch(`${agyDaemon.baseUrl}/`);
        expect(rootRes.status).toBe(200);
        expect(await rootRes.json()).toEqual({ message: 'Hello World' });

        for (const apiPath of [
          '/api/jobs',
          '/api/enrichment-batches',
          '/api/search-runs',
          '/api/web-session/ticket',
        ]) {
          const unauthRes = await fetch(`${agyDaemon.baseUrl}${apiPath}`, {
            method: apiPath.endsWith('ticket') ? 'POST' : 'GET',
          });
          expect(unauthRes.status).toBe(401);
        }

        // 2. GET /dashboard redirect & strict CSP / security headers
        const redirectRes = await fetch(`${agyDaemon.baseUrl}/dashboard`, { redirect: 'manual' });
        expect([301, 302, 307, 308]).toContain(redirectRes.status);
        expect(redirectRes.headers.get('location') ?? '').toContain('/dashboard/');

        const htmlRes = await fetch(`${agyDaemon.baseUrl}/dashboard/`);
        expect(htmlRes.status).toBe(200);
        expect(htmlRes.headers.get('content-security-policy')).toBe(
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        );
        expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(htmlRes.headers.get('referrer-policy')).toBe('no-referrer');
        const rawHtml = await htmlRes.text();
        expect(rawHtml).not.toContain(agyDaemon.apiToken);

        // 3. Seed jobs via compact MCP search & verify clickable dashboard_url
        const searchRes = await agyMcpHttp.callTool('upwork_search_jobs', {
          source: 'search',
          queries: ['go postgresql', 'WordPress'],
          max_pages: 1,
          skip_auto_detail_enrich: true,
          run_label: 'f10-web-run',
          compact: true,
        });
        expect(searchRes.isError).not.toBe(true);
        const searchPayload = parseMcpToolJson<{ search_run_id: number; dashboard_url?: string }>(
          searchRes,
        );
        expect(searchPayload.dashboard_url ?? '').toContain('/dashboard/');
        expect(searchPayload.dashboard_url ?? '').toContain('ticket=');

        const ticketUrl = new URL(searchPayload.dashboard_url ?? '');
        const originalTicket = ticketUrl.searchParams.get('ticket') ?? '';
        expect(originalTicket.length).toBeGreaterThan(0);

        // 4. Negative /dashboard/auth/exchange checks: non-loopback Host -> 403, wrong Content-Type -> 400/415
        const nonLoopbackRes = await rawHttpRequest({
          port: agyDaemon.port,
          method: 'POST',
          reqPath: '/dashboard/auth/exchange',
          headers: {
            host: 'evil.example:9090',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ticket: originalTicket }),
        });
        expect(nonLoopbackRes.status).toBe(403);

        const badContentTypeRes = await fetch(`${agyDaemon.baseUrl}/dashboard/auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ ticket: originalTicket }),
        });
        expect([400, 415]).toContain(badContentTypeRes.status);

        // 5. Open dashboard_url in browser -> ticket stripped via replaceState, scoped sessionStorage token, full table parity
        const webPage = await agyPairedExtension.context.newPage();
        try {
          await webPage.goto(searchPayload.dashboard_url ?? '', { waitUntil: 'domcontentloaded' });
          await expect
            .poll(() => !webPage.url().includes('ticket='), { timeout: 10_000 })
            .toBe(true);
          expect(webPage.url()).toContain(`run=${searchPayload.search_run_id}`);

          // Verify sessionStorage holds a scoped session token (never the master apiToken)
          const storageSnapshot = await webPage.evaluate(() => ({
            sessionValues: Object.values(window.sessionStorage),
            localValues: Object.values(window.localStorage),
          }));
          expect(storageSnapshot.sessionValues.some((v) => v.length > 10)).toBe(true);
          expect(storageSnapshot.sessionValues.join(' ')).not.toContain(agyDaemon.apiToken);
          expect(storageSnapshot.localValues.join(' ')).not.toContain(agyDaemon.apiToken);

          // Single-use ticket replay must fail with 401
          const replayRes = await fetch(`${agyDaemon.baseUrl}/dashboard/auth/exchange`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ticket: originalTicket }),
          });
          expect(replayRes.status).toBe(401);

          // Mint an extra ticket via REST POST /api/web-session/ticket and verify it works too
          const mintRes = await agyDaemon.apiFetch('/api/web-session/ticket', { method: 'POST' });
          expect(mintRes.status).toBe(200);
          const minted = (await mintRes.json()) as { ticket?: string; dashboard_url?: string };
          expect((minted.ticket ?? '').length).toBeGreaterThan(0);

          await exerciseDashboardTableAndDrawer({
            page: webPage,
            daemon: agyDaemon,
            mockAgy,
            expectedSurface: 'web',
          });
        } finally {
          await webPage.close();
        }

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    f10Test(
      'T2-F10-07: R5 manual Bearer token unlock fallback & WEB_UI_ENABLED=false disablement',
      async ({ agyPairedExtension, agyDaemon, workerDb }) => {
        // Part A: Manual unlock when visiting /dashboard/ without ?ticket=
        const seedRes = await agyDaemon.apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            upwork_job_id: '~0777000000000000001',
            job_title: 'Manual Unlock Verification Job',
            job_description: 'Verifies manual Bearer token unlock screen.',
            url: 'https://www.upwork.com/jobs/~0777000000000000001/',
          }),
        });
        expect(seedRes.ok).toBe(true);

        const webPage = await agyPairedExtension.context.newPage();
        try {
          await webPage.goto(`${agyDaemon.baseUrl}/dashboard/`, { waitUntil: 'domcontentloaded' });
          await webPage.evaluate(() => {
            window.sessionStorage.clear();
            window.localStorage.clear();
          });
          await webPage.reload({ waitUntil: 'domcontentloaded' });

          const tokenInput = webPage
            .locator('[data-testid="web-token-input"], input[type="password"], input[name="token"]')
            .or(webPage.getByLabel(/token/i))
            .first();
          await expect(tokenInput).toBeVisible({ timeout: 10_000 });

          const unlockBtn = webPage
            .locator('[data-testid="web-unlock-btn"]')
            .or(webPage.getByRole('button', { name: /unlock|sign in|connect/i }))
            .first();

          // Bogus token rejected (401)
          await tokenInput.fill('invalid-bogus-token');
          await unlockBtn.click();
          await expect(webPage.getByText(/invalid|unauthorized|401|failed/i).first()).toBeVisible({
            timeout: 10_000,
          });

          // Valid daemon token unlocks table
          await tokenInput.fill(agyDaemon.apiToken);
          await unlockBtn.click();
          await expect(webPage.getByText('Manual Unlock Verification Job').first()).toBeVisible({
            timeout: 15_000,
          });
        } finally {
          await webPage.close();
        }

        // Filter only expected 401 console error from the bogus unlock attempt
        const unexpectedErrors = agyPairedExtension.errors.filter(
          (e) =>
            !(
              e.source === 'console' &&
              /status of 401\b/i.test(e.message) &&
              ((e.url ?? '').includes('/dashboard/') || (e.url ?? '').includes('/api/'))
            ),
        );
        expect(unexpectedErrors).toEqual([]);

        // Part B: WEB_UI_ENABLED=false returns 404 on /dashboard/ and omits dashboard_url
        const disabledWebDaemon = await startWorkerDaemon({
          binaryPath: agyDaemon.binaryPath,
          dbConfig: workerDb.config,
          repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
          extraEnv: {
            WEB_UI_ENABLED: 'false',
          },
        });
        try {
          const dashRes = await fetch(`${disabledWebDaemon.baseUrl}/dashboard/`);
          expect(dashRes.status).toBe(404);

          const ticketRes = await disabledWebDaemon.apiFetch('/api/web-session/ticket', {
            method: 'POST',
          });
          expect([403, 404]).toContain(ticketRes.status);

          const batchSaveRes = await disabledWebDaemon.apiFetch('/api/jobs/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              run_label: 'disabled-web-check',
              jobs: [
                {
                  upwork_job_id: '~0777000000000000002',
                  job_title: 'Disabled Web UI Job',
                  url: 'https://www.upwork.com/jobs/~0777000000000000002/',
                },
              ],
            }),
          });
          expect(batchSaveRes.status).toBe(200);
          const batchSaveBody = (await batchSaveRes.json()) as { dashboard_url?: string };
          expect(batchSaveBody.dashboard_url ?? '').toBe('');
        } finally {
          await disabledWebDaemon.cleanup();
        }
      },
    );
  },
);
