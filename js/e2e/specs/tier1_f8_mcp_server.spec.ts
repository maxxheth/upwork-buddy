import { McpStdioClient, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

const EXPECTED_TOOLS = [
  'upwork_session_status',
  'upwork_audit_selectors',
  'upwork_list_tabs',
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
] as const;

const EXPECTED_RESOURCES = [
  'upwork://profile',
  'upwork://jobs/hot',
  'upwork://proposals/pending-approval',
  'upwork://proposals/active',
  'upwork://messages/unread',
  'upwork://selectors/health',
] as const;

test.describe('Tier 1 F8 — Embedded Go MCP Server (Streamable HTTP + stdio)', () => {
  test('T1-F8-01: Streamable HTTP /mcp handshake, all 18 tools & all 6 resources discovery', async ({
    mcpHttp,
  }) => {
    const tools = await mcpHttp.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames.length).toBe(18);
    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
    }

    const resources = await mcpHttp.listResources();
    const resourceUris = resources.map((r) => r.uri).sort();
    expect(resourceUris).toEqual([...EXPECTED_RESOURCES].sort());
  });

  test('T1-F8-02: upwork-buddy mcp (stdio) transport initialization & tool execution', async ({
    daemon,
  }) => {
    const stdioClient = new McpStdioClient(daemon.binaryPath, daemon.env);
    await stdioClient.initialize();
    try {
      const tools = await stdioClient.listTools();
      expect(tools.length).toBe(18);

      const statusRes = await stdioClient.callTool('upwork_session_status', {});
      expect(statusRes.isError).not.toBe(true);
      const status = parseMcpToolJson<{ policy_mode?: string; db?: string }>(statusRes);
      expect(status.policy_mode).toBe('confirm_in_ui');

      const savedRes = await stdioClient.callTool('upwork_list_saved_jobs', {});
      expect(savedRes.isError).not.toBe(true);
      const saved = parseMcpToolJson<{ jobs: unknown[] }>(savedRes);
      expect(Array.isArray(saved.jobs)).toBe(true);

      expect(stdioClient.getNonJsonStdoutLines()).toEqual([]);
    } finally {
      await stdioClient.close();
    }
  });

  test('T1-F8-03: MCP discovery, profile, analysis & persistent agent blueprints workflow', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
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
  });

  test('T1-F8-04: MCP proposal lifecycle (draft -> fill -> pending-approval token -> submit -> sync)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
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
  });

  test('T1-F8-05: MCP communication & diagnostics tools under auto_with_guardrails', async ({
    pairedExtension,
    daemon,
    mcpHttp,
    upworkPage,
  }) => {
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
  });

  test('T1-F8-06: all 6 upwork://* MCP resources & concurrent Streamable HTTP client serialization', async ({
    pairedExtension,
    daemon,
    mcpHttp,
    createMcpHttpClient,
  }) => {
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
  });
});
