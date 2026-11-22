import http from 'node:http';
import path from 'node:path';
import { buildDaemonBinary, type DaemonHandle, startWorkerDaemon } from '../helpers/daemon.ts';
import type { ExtensionContextHandle } from '../helpers/extension.ts';
import {
  type McpClient,
  McpHttpClient,
  McpStdioClient,
  parseMcpToolJson,
} from '../helpers/mcp-client.ts';
import { getSessionStatus, pairExtensionWithDaemon } from '../helpers/pairing.ts';
import { test as baseTest, expect } from '../helpers/test-fixtures.ts';

const EXPECTED_TOOLS = [
  'upwork_session_status',
  'upwork_audit_selectors',
  'upwork_list_tabs',
  'upwork_capture_ui_diagnostic',
  'upwork_get_ui_diagnostic',
  'upwork_test_selector_patch',
  'upwork_apply_selector_patch',
  'upwork_search_jobs',
  'upwork_get_job_details',
  'upwork_list_saved_jobs',
  'upwork_analyze_job',
  'upwork_manage_search_profiles',
  'upwork_draft_proposal',
  'upwork_fill_proposal_form',
  'upwork_submit_proposal',
  'upwork_sync_proposals',
  'upwork_list_conversations',
  'upwork_get_conversation',
  'upwork_draft_message',
  'upwork_send_message',
  'upwork_profile',
  'upwork_generate_project_agents',
  'upwork_active_projects',
  'upwork_save_jobs',
  'upwork_enrich_jobs',
  'upwork_enrichment_batches',
] as const;

const EXPECTED_RESOURCES = [
  'upwork://profile',
  'upwork://jobs/hot',
  'upwork://proposals/pending-approval',
  'upwork://proposals/active',
  'upwork://messages/unread',
  'upwork://selectors/health',
  'upwork://diagnostics/latest',
  'upwork://projects/active',
  'upwork://jobs/search-runs',
  'upwork://jobs/enrichment-batches',
] as const;

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
  reset(): void;
  close(): Promise<void>;
}

async function startMockAgyServer(): Promise<MockAgyHandle> {
  const chatRequests: MockAgyRecordedRequest[] = [];
  let delayMs = 0;

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

        const analysisPayload = {
          proposal:
            'Tailored proposal built with Go, PostgreSQL, and Playwright verification discipline.',
          execution_prompt: 'Implement typed API endpoints and Playwright integration tests.',
          time_estimate: '1-2 weeks',
          workload_division: '60% backend / 40% verification',
          questions_for_client: ['Can you share staging access for validation?'],
          tips_and_advice: ['Confirm database migration window before cutover.'],
          tone_analysis: 'direct and technical',
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
    reset(): void {
      chatRequests.length = 0;
      delayMs = 0;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

interface AgyMcpWorkerFixtures {
  mockAgy: MockAgyHandle;
  agyDaemon: DaemonHandle;
}

interface AgyMcpTestFixtures {
  agyReset: undefined;
  agyPairedExtension: ExtensionContextHandle;
  agyMcpHttp: McpClient;
  createAgyMcpStdioClient: () => Promise<McpStdioClient>;
}

const agyMcpTest = baseTest.extend<AgyMcpTestFixtures, AgyMcpWorkerFixtures>({
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
          path.join(repoRoot, 'dist', `upwork-buddy-e2e-f8-agy-w${workerInfo.workerIndex}`),
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
          ENRICHMENT_MAX_CONCURRENCY: '2',
          WEB_UI_ENABLED: 'true',
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

  createAgyMcpStdioClient: async ({ agyDaemon }, use) => {
    const created: McpStdioClient[] = [];
    try {
      await use(async () => {
        const client = new McpStdioClient(agyDaemon.binaryPath, agyDaemon.env);
        await client.initialize();
        created.push(client);
        return client;
      });
    } finally {
      for (const client of created) {
        await client.close();
      }
    }
  },
});

baseTest.describe('Tier 1 F8 — Embedded Go MCP Server (Streamable HTTP + stdio)', () => {
  baseTest(
    'T1-F8-01: Streamable HTTP /mcp handshake, all 26 tools & all 10 resources discovery',
    async ({ mcpHttp }) => {
      const tools = await mcpHttp.listTools();
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames.length).toBe(26);
      expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
      }

      const resources = await mcpHttp.listResources();
      const resourceUris = resources.map((r) => r.uri).sort();
      expect(resourceUris.length).toBe(10);
      expect(resourceUris).toEqual([...EXPECTED_RESOURCES].sort());
    },
  );

  baseTest(
    'T1-F8-02: upwork-buddy mcp (stdio) transport initialization & tool execution',
    async ({ daemon }) => {
      const stdioClient = new McpStdioClient(daemon.binaryPath, daemon.env);
      await stdioClient.initialize();
      try {
        const tools = await stdioClient.listTools();
        expect(tools.length).toBe(26);

        const resources = await stdioClient.listResources();
        expect(resources.length).toBe(10);

        const statusRes = await stdioClient.callTool('upwork_session_status', {});
        expect(statusRes.isError).not.toBe(true);
        const status = parseMcpToolJson<{ policy_mode?: string; db?: string }>(statusRes);
        expect(status.policy_mode).toBe('confirm_in_ui');

        const savedRes = await stdioClient.callTool('upwork_list_saved_jobs', {});
        expect(savedRes.isError).not.toBe(true);
        const saved = parseMcpToolJson<{ jobs: unknown[] }>(savedRes);
        expect(Array.isArray(saved.jobs)).toBe(true);

        const batchesRes = await stdioClient.callTool('upwork_enrichment_batches', {
          action: 'list',
        });
        expect(batchesRes.isError).not.toBe(true);
        const batchesPayload = parseMcpToolJson<{ batches?: unknown[] }>(batchesRes);
        expect(Array.isArray(batchesPayload.batches)).toBe(true);

        expect(stdioClient.getNonJsonStdoutLines()).toEqual([]);
      } finally {
        await stdioClient.close();
      }
    },
  );

  baseTest(
    'T1-F8-03: MCP discovery, profile, analysis & persistent agent blueprints workflow',
    async ({ pairedExtension, daemon, mcpHttp }) => {
      expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

      const updateProfile = await mcpHttp.callTool('upwork_profile', {
        action: 'update',
        description: 'Go, PostgreSQL, WordPress, Elementor & Playwright architect.',
        skills: 'Go, PostgreSQL, WordPress, Elementor, Playwright',
        target_rate: 95,
      });
      expect(updateProfile.isError).not.toBe(true);

      const getProfile = await mcpHttp.callTool('upwork_profile', { action: 'get' });
      expect(getProfile.isError).not.toBe(true);
      expect(JSON.stringify(parseMcpToolJson(getProfile))).toContain('Playwright');

      const saveSearchProfile = await mcpHttp.callTool('upwork_manage_search_profiles', {
        action: 'save',
        name: 'mcp_wp_profile',
        search: { mode: 'live_search', queries: ['WordPress'], max_pages: 1 },
      });
      expect(saveSearchProfile.isError).not.toBe(true);

      const listSearchProfiles = await mcpHttp.callTool('upwork_manage_search_profiles', {
        action: 'list',
      });
      expect(JSON.stringify(parseMcpToolJson(listSearchProfiles))).toContain('mcp_wp_profile');

      const runSearchProfile = await mcpHttp.callTool('upwork_manage_search_profiles', {
        action: 'run',
        name: 'mcp_wp_profile',
      });
      expect(runSearchProfile.isError).not.toBe(true);

      const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 1,
      });
      expect(searchRes.isError).not.toBe(true);

      const detailRes = await mcpHttp.callTool('upwork_get_job_details', {
        job_id: '~022115332344639171',
      });
      expect(detailRes.isError).not.toBe(true);

      const savedJobsRes = await mcpHttp.callTool('upwork_list_saved_jobs', { min_score: 60 });
      expect(savedJobsRes.isError).not.toBe(true);
      const savedJobs = parseMcpToolJson<{ jobs: Array<{ id: number; upwork_job_id?: string }> }>(
        savedJobsRes,
      );
      const targetJob = savedJobs.jobs.find((j) => j.upwork_job_id === '~022115332344639171');
      expect(targetJob).toBeDefined();

      const analyzeRes = await mcpHttp.callTool('upwork_analyze_job', {
        job_id: targetJob?.id,
      });
      expect(analyzeRes.isError).not.toBe(true);

      for (const format of ['claude', 'copilot'] as const) {
        const genRes = await mcpHttp.callTool('upwork_generate_project_agents', {
          job_id: targetJob?.id,
          format,
        });
        expect(genRes.isError).not.toBe(true);
      }

      const agentsBeforeRes = await daemon.apiFetch('/api/agents');
      expect(agentsBeforeRes.status).toBe(200);
      const agentsBeforeText = await agentsBeforeRes.text();
      expect(agentsBeforeText.length).toBeGreaterThan(2);

      // Restart daemon and verify generated_agents persists in Postgres across restarts.
      await daemon.restart();
      const agentsAfterRes = await daemon.apiFetch('/api/agents');
      expect(agentsAfterRes.status).toBe(200);
      expect(await agentsAfterRes.text()).toBe(agentsBeforeText);
    },
  );

  baseTest(
    'T1-F8-04: MCP proposal lifecycle (draft -> fill -> pending-approval token -> submit -> sync)',
    async ({ pairedExtension, daemon, mcpHttp }) => {
      expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

      const jobRes = await daemon.apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          upwork_job_id: '~022115332344639171',
          job_title: 'On-Page SEO Expert Needed',
          job_description: 'MCP proposal lifecycle test job.',
          url: 'https://www.upwork.com/jobs/~022115332344639171/',
          connects_required: 12,
          score: 90,
        }),
      });
      const job = (await jobRes.json()) as { id: number };

      const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: job.id,
        cover_letter: 'MCP-driven cover letter for ~022115332344639171.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Audited 10+ WordPress sites.', 'Available 30+ hrs/week.'],
      });
      expect(draftRes.isError).not.toBe(true);
      const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
      const proposalId = draft.proposal_id ?? draft.id;

      const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
        proposal_id: proposalId,
      });
      expect(fillRes.isError).not.toBe(true);
      const fillPayload = parseMcpToolJson<{ status: string; approval_token?: string }>(fillRes);
      expect(fillPayload.status).toBe('pending_approval');

      const pendingResource = await mcpHttp.readResource('upwork://proposals/pending-approval');
      const pendingText = pendingResource.contents[0]?.text ?? '';
      expect(pendingText).toContain('pending_approval');
      const pendingJson = JSON.parse(pendingText) as {
        proposals?: Array<{ id: number; approval_token?: string }>;
      };
      const token =
        fillPayload.approval_token ??
        pendingJson.proposals?.find((p) => p.id === proposalId)?.approval_token;
      expect((token ?? '').length).toBeGreaterThan(0);

      const submitRes = await mcpHttp.callTool('upwork_submit_proposal', {
        proposal_id: proposalId,
        approval_token: token,
      });
      expect(submitRes.isError).not.toBe(true);
      const submitPayload = parseMcpToolJson<{ status: string }>(submitRes);
      expect(submitPayload.status).toBe('submitted');

      const syncRes = await mcpHttp.callTool('upwork_sync_proposals', {});
      expect(syncRes.isError).not.toBe(true);
    },
  );

  baseTest(
    'T1-F8-05: MCP communication & diagnostics tools under auto_with_guardrails',
    async ({ pairedExtension, daemon, mcpHttp, upworkPage }) => {
      expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

      await daemon.apiFetch('/api/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'auto_with_guardrails',
          allowed_room_ids: ['room_alpha'],
        }),
      });

      await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
        waitUntil: 'domcontentloaded',
      });

      const tabsRes = await mcpHttp.callTool('upwork_list_tabs', {});
      expect(tabsRes.isError).not.toBe(true);

      const auditRes = await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      });
      expect(auditRes.isError).not.toBe(true);

      const convsRes = await mcpHttp.callTool('upwork_list_conversations', { sync: true });
      expect(convsRes.isError).not.toBe(true);

      const convRes = await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha' });
      expect(convRes.isError).not.toBe(true);

      const draftMsgRes = await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: 'MCP diagnostic test reply.',
        prefill_composer: true,
      });
      expect(draftMsgRes.isError).not.toBe(true);

      const sendMsgRes = await mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        body: 'MCP diagnostic test reply.',
      });
      expect(sendMsgRes.isError).not.toBe(true);

      const threadPage = pairedExtension.context
        .pages()
        .find((p) => p.url().includes('/ab/messages/rooms/room_alpha'));
      expect(threadPage).toBeDefined();
      if (threadPage) {
        await expect(threadPage.getByText('MCP diagnostic test reply.')).toBeVisible({
          timeout: 10_000,
        });
      }
    },
  );

  baseTest(
    'T1-F8-06: all 10 upwork://* MCP resources & concurrent Streamable HTTP client serialization',
    async ({ pairedExtension, daemon, mcpHttp, createMcpHttpClient }) => {
      expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

      await daemon.apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: 'WordPress, Elementor, SEO, Go & PostgreSQL consultant.',
          skills: 'WordPress, Elementor, SEO, Go, PostgreSQL',
        }),
      });

      const jobRes = await daemon.apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          upwork_job_id: '~022115332344639171',
          job_title: 'Hot Resource Job',
          job_description: 'Hot job description.',
          url: 'https://www.upwork.com/jobs/~022115332344639171/',
          score: 88,
          fit_label: 'hot',
        }),
      });
      const hotJob = (await jobRes.json()) as { id: number };

      const saveRunRes = await mcpHttp.callTool('upwork_save_jobs', {
        run_label: 'f8-resource-seed',
        jobs: [
          {
            upwork_job_id: '~022115332344639171',
            job_title: 'Hot Resource Job',
            job_description: 'Hot job description.',
            url: 'https://www.upwork.com/jobs/~022115332344639171/',
          },
        ],
      });
      expect(saveRunRes.isError).not.toBe(true);

      const enrichSeedRes = await mcpHttp.callTool('upwork_enrich_jobs', {
        job_ids: [hotJob.id],
        mode: 'detail_only',
        wait: true,
      });
      expect(enrichSeedRes.isError).not.toBe(true);

      const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: hotJob.id,
        cover_letter: 'Pending approval resource test.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Yes.', '30+ hrs.'],
      });
      const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
      await mcpHttp.callTool('upwork_fill_proposal_form', {
        proposal_id: draft.proposal_id ?? draft.id,
      });
      await mcpHttp.callTool('upwork_sync_proposals', {});
      await mcpHttp.callTool('upwork_list_conversations', { sync: true });
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      });

      for (const uri of EXPECTED_RESOURCES) {
        const resource = await mcpHttp.readResource(uri);
        expect(resource.contents.length).toBeGreaterThan(0);
        const text = resource.contents[0].text ?? '';
        expect(text.length).toBeGreaterThan(2);
        expect(() => JSON.parse(text)).not.toThrow();
      }

      const clientA = await createMcpHttpClient();
      const clientB = await createMcpHttpClient();
      const [resA, resB] = await Promise.all([
        clientA.callTool('upwork_get_job_details', { job_id: '~022115332344639171' }),
        clientB.callTool('upwork_get_job_details', { job_id: '~022115332344639172' }),
      ]);

      expect(resA.isError).not.toBe(true);
      expect(resB.isError).not.toBe(true);
      expect(JSON.stringify(parseMcpToolJson(resA))).toContain('022115332344639171');
      expect(JSON.stringify(parseMcpToolJson(resB))).toContain('022115332344639172');
    },
  );
});

agyMcpTest.describe(
  'Tier 1 F8 — R1/R2/R4 Decoupled Search, Enrichment & Batch MCP Extensions',
  () => {
    agyMcpTest(
      'T1-F8-07: Decoupled 0-token multi-criteria upwork_search_jobs (compact, NDA-safe from_active_projects), ticket exchange & upwork://jobs/search-runs',
      async ({
        agyPairedExtension,
        agyDaemon,
        agyMcpHttp,
        createAgyMcpStdioClient,
        mockClient,
        mockAgy,
      }) => {
        const syncRes = await agyDaemon.apiFetch('/api/active-projects/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projects: [
              {
                project_key: 'edfx/nda-go-core',
                name: 'TopSecretClientPortal',
                client: 'SecretClientCorp',
                group_name: 'confidential-group',
                path: '/srv/nda/secret-client-path',
                activity_tier: 'active',
                status: 'active',
                proposal_visibility: 'anonymized',
                public_alias: 'Enterprise Go Platform',
                tech_stack: ['Go', 'PostgreSQL'],
                summary: 'Proprietary confidential summary never for Upwork search.',
              },
              {
                project_key: 'edfx/private-vault',
                name: 'PrivateVaultApp',
                client: 'PrivateVaultCorp',
                activity_tier: 'active',
                status: 'active',
                proposal_visibility: 'private',
                tech_stack: ['PrivateOnlyStack'],
                summary: 'Strictly private.',
              },
            ],
          }),
        });
        expect(syncRes.ok).toBe(true);

        const searchRes = await agyMcpHttp.callTool('upwork_search_jobs', {
          source: 'search',
          query: 'WordPress',
          max_pages: 2,
          hourly_rate_min: 70,
          payment_verified_only: true,
          skip_auto_detail_enrich: true,
          filters: { max_proposals: 10 },
          run_label: 'f8-zero-token-wp',
          compact: true,
        });
        expect(searchRes.isError).not.toBe(true);

        const searchPayload = parseMcpToolJson<{
          jobs: Array<{
            id: number;
            upwork_job_id?: string;
            job_title?: string;
            job_description?: string;
            score_breakdown?: unknown;
            qualifications?: unknown;
            screening_questions?: unknown;
            attachments?: unknown;
          }>;
          search_run_id?: number;
          dashboard_url?: string;
        }>(searchRes);

        expect(searchPayload.search_run_id ?? 0).toBeGreaterThan(0);
        expect(searchPayload.dashboard_url ?? '').toContain('/dashboard/');
        expect(searchPayload.dashboard_url ?? '').toContain('ticket=');
        expect(mockAgy.chatRequests).toHaveLength(0);
        expect(await mockClient.getRequests('/jobs/')).toHaveLength(0);

        expect(searchPayload.jobs.some((j) => j.upwork_job_id === '~022111887415567641944')).toBe(
          false,
        );
        for (const job of searchPayload.jobs) {
          expect((job.job_description ?? '').length).toBeLessThan(200);
          expect(job.score_breakdown).toBeUndefined();
          expect(job.qualifications).toBeUndefined();
          expect(job.screening_questions).toBeUndefined();
          expect(job.attachments).toBeUndefined();
        }

        const dashboardUrl = new URL(searchPayload.dashboard_url ?? '');
        const ticket = dashboardUrl.searchParams.get('ticket') ?? '';
        expect(ticket.length).toBeGreaterThan(0);

        const exchangeRes = await fetch(`${agyDaemon.baseUrl}/dashboard/auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket }),
        });
        expect(exchangeRes.status).toBe(200);
        const exchangeJson = (await exchangeRes.json()) as {
          session_token?: string;
          expires_at?: string;
        };
        expect((exchangeJson.session_token ?? '').length).toBeGreaterThan(0);

        const replayRes = await fetch(`${agyDaemon.baseUrl}/dashboard/auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket }),
        });
        expect(replayRes.status).toBe(401);

        await mockClient.reset();

        const ndaSearchRes = await agyMcpHttp.callTool('upwork_search_jobs', {
          from_active_projects: true,
          compact: true,
          skip_auto_detail_enrich: true,
          run_label: 'f8-nda-seeded',
        });
        expect(ndaSearchRes.isError).not.toBe(true);
        expect(mockAgy.chatRequests).toHaveLength(0);

        const searchRequests = await mockClient.getRequests('/nx/search/jobs/');
        expect(searchRequests.length).toBeGreaterThanOrEqual(1);
        const normalizedQueryText = searchRequests
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
          'edfx/nda-go-core',
          'edfx/private-vault',
          'TopSecretClientPortal',
          'SecretClientCorp',
          'confidential-group',
          '/srv/nda/secret-client-path',
          'Enterprise Go Platform',
          'Proprietary confidential summary',
          'Strictly private.',
          'PrivateOnlyStack',
          'PrivateVaultApp',
          'PrivateVaultCorp',
        ]) {
          expect(normalizedQueryText).not.toContain(forbidden.toLowerCase());
        }

        const runsResourceHttp = await agyMcpHttp.readResource('upwork://jobs/search-runs');
        const runsTextHttp = runsResourceHttp.contents[0]?.text ?? '';
        expect(runsTextHttp).toContain('f8-zero-token-wp');
        expect(runsTextHttp).toContain('f8-nda-seeded');

        const stdioClient = await createAgyMcpStdioClient();
        const runsResourceStdio = await stdioClient.readResource('upwork://jobs/search-runs');
        expect(runsResourceStdio.contents[0]?.text ?? '').toContain('f8-zero-token-wp');
        expect(stdioClient.getNonJsonStdoutLines()).toEqual([]);

        const filteredListRes = await agyMcpHttp.callTool('upwork_list_saved_jobs', {
          search_run_id: searchPayload.search_run_id,
          contract_type: 'hourly',
          hourly_rate_min: 70,
          compact: true,
        });
        expect(filteredListRes.isError).not.toBe(true);
        const filteredList = parseMcpToolJson<{
          jobs: Array<{ upwork_job_id?: string }>;
          total: number;
        }>(filteredListRes);
        expect(filteredList.total).toBeGreaterThanOrEqual(1);
        expect(filteredList.jobs.some((j) => j.upwork_job_id === '~022115332344639180')).toBe(true);

        expect(agyPairedExtension.errors).toEqual([]);
      },
    );

    agyMcpTest(
      'T1-F8-08: upwork_save_jobs deduplication, SearchRun provenance, sort_by_score, 0 tokens & INVALID_PARAMS checks',
      async ({ agyMcpHttp, mockAgy }) => {
        const saveRes = await agyMcpHttp.callTool('upwork_save_jobs', {
          run_label: 'f8-curated-save',
          source: 'curated',
          sort_by_score: true,
          compact: true,
          jobs: [
            {
              upwork_job_id: '~0990000000000000001',
              job_title: 'Curated Go & PostgreSQL Backend',
              job_description: 'Build Go microservices with PostgreSQL.',
              url: 'https://www.upwork.com/jobs/~0990000000000000001/',
              contract_type: 'fixed',
              budget_amount: '$1,800.00',
              skills: ['Go', 'PostgreSQL'],
              payment_verified: true,
            },
            {
              upwork_job_id: '~0990000000000000002',
              job_title: 'Curated Hourly TypeScript Engineer',
              job_description: 'Hourly TypeScript + Playwright test automation.',
              url: 'https://www.upwork.com/jobs/~0990000000000000002/',
              contract_type: 'hourly',
              rate_range: '$95.00/hr',
              skills: ['TypeScript', 'Playwright'],
              payment_verified: true,
            },
            {
              upwork_job_id: '~0990000000000000001',
              job_title: 'Curated Go & PostgreSQL Backend (duplicate)',
              job_description: 'Duplicate entry in same payload.',
              url: 'https://www.upwork.com/jobs/~0990000000000000001/',
            },
          ],
        });
        expect(saveRes.isError).not.toBe(true);
        const savePayload = parseMcpToolJson<{
          total_received: number;
          deduplicated_count: number;
          persisted_count: number;
          search_run_id?: number;
          jobs: Array<{ id: number; upwork_job_id?: string; score?: number }>;
        }>(saveRes);

        expect(savePayload.total_received).toBe(3);
        expect(savePayload.deduplicated_count).toBe(2);
        expect(savePayload.persisted_count).toBe(2);
        expect(savePayload.search_run_id ?? 0).toBeGreaterThan(0);
        expect(mockAgy.chatRequests).toHaveLength(0);

        const listRes = await agyMcpHttp.callTool('upwork_list_saved_jobs', {
          search_run_id: savePayload.search_run_id,
        });
        expect(listRes.isError).not.toBe(true);
        const listed = parseMcpToolJson<{
          jobs: Array<{ upwork_job_id?: string; last_search_run_id?: number; score?: number }>;
          total: number;
        }>(listRes);
        expect(listed.total).toBe(2);
        for (const job of listed.jobs) {
          expect(job.last_search_run_id).toBe(savePayload.search_run_id);
          expect(typeof job.score).toBe('number');
        }

        const emptyErr = await agyMcpHttp.callTool('upwork_save_jobs', { jobs: [] });
        expect(emptyErr.isError).toBe(true);
        expect(emptyErr.content.map((c) => c.text ?? '').join('\n')).toContain('INVALID_PARAMS');

        const badJsonErr = await agyMcpHttp.callTool('upwork_save_jobs', {
          jobs: [
            {
              upwork_job_id: '~0990000000000000003',
              job_title: 'Bad JSONB Job',
              url: 'https://www.upwork.com/jobs/~0990000000000000003/',
              proposal_json: '{bad-json',
            },
          ],
        });
        expect(badJsonErr.isError).toBe(true);
        expect(badJsonErr.content.map((c) => c.text ?? '').join('\n')).toContain('INVALID_PARAMS');
      },
    );

    agyMcpTest(
      'T1-F8-09: upwork_analyze_job(ensure_details), upwork_enrich_jobs (force/cap) & upwork_enrichment_batches (HTTP + stdio)',
      async ({
        agyPairedExtension,
        agyDaemon,
        agyMcpHttp,
        createAgyMcpStdioClient,
        mockClient,
        mockAgy,
      }) => {
        expect(agyPairedExtension.extensionId.length).toBeGreaterThan(0);

        // Part A: upwork_analyze_job with ensure_details=true + use_llm=true
        const seedA = await agyDaemon.apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            upwork_job_id: '~022115332344639171',
            job_title: 'On-Page SEO Expert Needed',
            job_description: 'Short card snippet only.',
            url: 'https://www.upwork.com/jobs/~022115332344639171/',
          }),
        });
        expect(seedA.ok).toBe(true);

        const analyzeRes = await agyMcpHttp.callTool('upwork_analyze_job', {
          job_id: '~022115332344639171',
          ensure_details: true,
          use_llm: true,
        });
        expect(analyzeRes.isError).not.toBe(true);

        const detailReqs = await mockClient.getRequests('/jobs/');
        expect(detailReqs.some((r) => r.pathname.includes('~022115332344639171'))).toBe(true);
        expect(mockAgy.chatRequests).toHaveLength(1);
        expect(mockAgy.chatRequests[0].prompt).toMatch(/30\+ hrs\/week|Core Web Vitals/);

        const analyzePayload = parseMcpToolJson<{
          job: { ai_enrichment_status?: string; ai_tokens_used?: number };
          ai_model?: string;
          ai_effort?: string;
          ai_enriched_at?: string;
          usage?: { total_tokens?: number };
        }>(analyzeRes);
        expect(analyzePayload.job.ai_enrichment_status).toBe('completed');
        expect((analyzePayload.ai_model ?? '').length).toBeGreaterThan(0);
        expect((analyzePayload.ai_effort ?? '').length).toBeGreaterThan(0);
        expect((analyzePayload.ai_enriched_at ?? '').length).toBeGreaterThan(0);
        expect(analyzePayload.usage?.total_tokens ?? 0).toBeGreaterThan(0);

        // Part B: upwork_enrich_jobs force=false skip-cached idempotency vs force=true & max batch cap
        const seedB = await agyDaemon.apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            upwork_job_id: '~022115332344639172',
            job_title: 'WordPress Landing Page Cleanup',
            job_description: 'Card snippet for second job.',
            url: 'https://www.upwork.com/jobs/~022115332344639172/',
          }),
        });
        expect(seedB.ok).toBe(true);

        const enrichSkipRes = await agyMcpHttp.callTool('upwork_enrich_jobs', {
          job_ids: ['~022115332344639171', '~022115332344639172'],
          mode: 'full',
          force: false,
          wait: true,
        });
        expect(enrichSkipRes.isError).not.toBe(true);
        const skipRaw = parseMcpToolJson<{
          batch?: {
            id: number;
            status: string;
            total_count: number;
            skipped_count: number;
            completed_count: number;
            total_tokens_used: number;
          };
          id?: number;
          status?: string;
          total_count?: number;
          skipped_count?: number;
          completed_count?: number;
          total_tokens_used?: number;
        }>(enrichSkipRes);
        const skipBatch = skipRaw.batch ?? skipRaw;
        expect(skipBatch.status).toBe('completed');
        expect(skipBatch.total_count).toBe(2);
        expect(skipBatch.skipped_count).toBe(1);
        expect(skipBatch.completed_count).toBe(1);
        expect(skipBatch.total_tokens_used).toBeGreaterThan(0);
        expect(mockAgy.chatRequests).toHaveLength(2);

        const enrichForceRes = await agyMcpHttp.callTool('upwork_enrich_jobs', {
          job_ids: ['~022115332344639171'],
          mode: 'ai_only',
          force: true,
          wait: true,
        });
        expect(enrichForceRes.isError).not.toBe(true);
        const forceRaw = parseMcpToolJson<{
          batch?: { skipped_count: number; completed_count: number };
          skipped_count?: number;
          completed_count?: number;
        }>(enrichForceRes);
        const forceBatch = forceRaw.batch ?? forceRaw;
        expect(forceBatch.skipped_count).toBe(0);
        expect(forceBatch.completed_count).toBe(1);
        expect(mockAgy.chatRequests).toHaveLength(3);

        const tooManyIds = Array.from(
          { length: 26 },
          (_, i) => `~09990000000000000${String(i).padStart(2, '0')}`,
        );
        const capErr = await agyMcpHttp.callTool('upwork_enrich_jobs', {
          job_ids: tooManyIds,
          mode: 'ai_only',
        });
        expect(capErr.isError).toBe(true);
        expect(capErr.content.map((c) => c.text ?? '').join('\n')).toContain('INVALID_PARAMS');

        // Part C: async upwork_enrich_jobs + upwork_enrichment_batches (list/get/cancel) over HTTP & stdio
        for (const extraId of ['~022111887415567641941', '~022111887415567641942'] as const) {
          const res = await agyDaemon.apiFetch('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              upwork_job_id: extraId,
              job_title: `Async Batch Job ${extraId}`,
              job_description: 'Async cancellation test job.',
              url: `https://www.upwork.com/jobs/${extraId}/`,
            }),
          });
          expect(res.ok).toBe(true);
        }

        mockAgy.setDelayMs(450);
        const asyncStartRes = await agyMcpHttp.callTool('upwork_enrich_jobs', {
          job_ids: [
            '~022115332344639171',
            '~022115332344639172',
            '~022111887415567641941',
            '~022111887415567641942',
          ],
          mode: 'ai_only',
          force: true,
          max_concurrency: 1,
          wait: false,
        });
        expect(asyncStartRes.isError).not.toBe(true);
        const asyncRaw = parseMcpToolJson<{
          batch?: { id: number; status: string };
          id?: number;
          status?: string;
        }>(asyncStartRes);
        const asyncBatch = asyncRaw.batch ?? asyncRaw;
        const batchId = asyncBatch.id;
        expect(batchId).toBeGreaterThan(0);
        expect(['queued', 'running']).toContain(asyncBatch.status);

        const stdioClient = await createAgyMcpStdioClient();
        const cancelRes = await stdioClient.callTool('upwork_enrichment_batches', {
          action: 'cancel',
          batch_id: batchId,
        });
        expect(cancelRes.isError).not.toBe(true);

        let finalStatus = '';
        let finalCanceledCount = 0;
        await expect
          .poll(
            async () => {
              const getRes = await agyMcpHttp.callTool('upwork_enrichment_batches', {
                action: 'get',
                batch_id: batchId,
              });
              const getRaw = parseMcpToolJson<{
                batch?: { status: string; canceled_count: number };
                status?: string;
                canceled_count?: number;
              }>(getRes);
              const b = getRaw.batch ?? getRaw;
              finalStatus = b.status ?? '';
              finalCanceledCount = b.canceled_count ?? 0;
              return ['completed', 'canceled', 'failed'].includes(finalStatus);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        expect(finalStatus === 'canceled' || finalCanceledCount >= 1).toBe(true);

        const listHttp = await agyMcpHttp.callTool('upwork_enrichment_batches', { action: 'list' });
        expect(listHttp.isError).not.toBe(true);
        const listStdio = await stdioClient.callTool('upwork_enrichment_batches', {
          action: 'list',
        });
        expect(listStdio.isError).not.toBe(true);

        const batchesResHttp = await agyMcpHttp.readResource('upwork://jobs/enrichment-batches');
        const batchesResStdio = await stdioClient.readResource('upwork://jobs/enrichment-batches');
        expect(batchesResHttp.contents[0]?.text ?? '').toContain(String(batchId));
        expect(batchesResStdio.contents[0]?.text ?? '').toContain(String(batchId));
        expect(stdioClient.getNonJsonStdoutLines()).toEqual([]);
        expect(agyPairedExtension.errors).toEqual([]);
      },
    );
  },
);
