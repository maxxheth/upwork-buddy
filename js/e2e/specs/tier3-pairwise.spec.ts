import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { waitForExtensionConnected } from '../helpers/pairing.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiJobRow {
  id: number;
  upwork_job_id?: string;
  job_title: string;
  connects_required?: number | null;
  client_hire_rate?: number | null;
  score?: number | null;
  score_breakdown?: {
    skill_match?: number;
    [key: string]: unknown;
  } | null;
}

interface RuleAuditResult {
  field?: string;
  status: string;
}

interface DriftAuditReport {
  view_type: string;
  overall_status: string;
  rules: Record<string, RuleAuditResult> | RuleAuditResult[];
}

function getRule(report: DriftAuditReport, fieldName: string): RuleAuditResult | undefined {
  if (Array.isArray(report.rules)) {
    return report.rules.find((r) => r.field === fieldName);
  }
  return report.rules[fieldName];
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
    return { ok: false, errorText: err instanceof Error ? err.message : String(err) };
  }
}

test.describe('Tier 3 — Cross-Feature Pairwise Combinations', () => {
  test('T3-01: F2 x F3 Discovery x Scoring, Stage-3 budget filter & $0/nil fix', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'golang',
      max_pages: 1,
      enrich_top_n: 3,
      budget_min: 500,
    });
    expect(searchRes.isError).not.toBe(true);

    const searchPayload = parseMcpToolJson<{ jobs?: ApiJobRow[]; items?: ApiJobRow[] }>(searchRes);
    const searchIds = (searchPayload.jobs ?? searchPayload.items ?? []).map((j) => j.upwork_job_id);
    expect(searchIds).toContain('~030100000000000000001');
    expect(searchIds).not.toContain('~030100000000000000002');
    expect(searchIds).not.toContain('~030100000000000000003');

    const saved = parseMcpToolJson<{ jobs?: ApiJobRow[]; items?: ApiJobRow[] }>(
      await mcpHttp.callTool('upwork_list_saved_jobs', { budget_min: 500 }),
    );
    const savedIds = (saved.jobs ?? saved.items ?? []).map((j) => j.upwork_job_id);
    expect(savedIds).toContain('~030100000000000000001');
    expect(savedIds).not.toContain('~030100000000000000002');
    expect(savedIds).not.toContain('~030100000000000000003');

    const apiRes = await daemon.apiFetch('/api/jobs');
    const apiBody = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const cardA = apiBody.jobs.filter((j) => j.upwork_job_id === '~030100000000000000001');
    expect(cardA).toHaveLength(1);
    expect(cardA[0].score_breakdown).toBeTruthy();
  });

  test('T3-02: F2 x F4 Discovery x Drift Audit & Selector Hot Reload', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    await mockClient.configure({ driftMode: 'broken_search' });

    const audit = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      }),
    );
    const titleRule = getRule(audit, 'title');
    expect(titleRule?.status).toBe('BROKEN');

    const auditRows = await workerDb.query<{ view_type: string; overall_status: string }>(
      'SELECT view_type, overall_status FROM selector_audits',
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    const healthRes = await mcpHttp.readResource('upwork://selectors/health');
    expect(healthRes.contents[0]?.text ?? '').toContain('BROKEN');

    const sidePanel = await extPages.openSidePanel();
    try {
      const selectorTab = sidePanel
        .locator('[data-testid="tab-selectors"]')
        .or(sidePanel.getByRole('tab', { name: /selector/i }))
        .or(sidePanel.getByRole('button', { name: /selector/i }))
        .first();
      if ((await selectorTab.count()) > 0) {
        await selectorTab.click();
      }
      await expect(sidePanel.getByText(/BROKEN/i).first()).toBeVisible();

      await daemon.updateSelectorsYaml((yamlText) =>
        yamlText
          .replace(
            '      title:\n        selectors:\n',
            '      title:\n        selectors:\n          - "a[data-test=\'new-title-link\']"\n',
          )
          .replace(
            '      url:\n        selectors:\n',
            '      url:\n        selectors:\n          - "a[data-test=\'new-title-link\']"\n',
          ),
      );

      const refreshBtn = sidePanel
        .locator('[data-testid="refresh-selectors-btn"]')
        .or(sidePanel.getByRole('button', { name: /refresh selectors/i }))
        .first();
      if ((await refreshBtn.count()) > 0) {
        await refreshBtn.click();
      }

      const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 1,
      });
      expect(searchRes.isError).not.toBe(true);
      const payload = parseMcpToolJson<{ jobs?: ApiJobRow[]; items?: ApiJobRow[] }>(searchRes);
      const jobs = payload.jobs ?? payload.items ?? [];
      expect(jobs.length).toBeGreaterThanOrEqual(4);
      expect(jobs.every((j) => Boolean(j.job_title))).toBe(true);
    } finally {
      await sidePanel.close();
      await daemon.restoreSelectorsYaml();
    }
  });

  test('T3-03: F3 x F5 x F7 Enrichment & Analysis x Proposal Fill/Submit/Sync x confirm_in_ui', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    workerDb,
    extPages,
  }) => {
    const detailRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~01abc/',
    });
    expect(detailRes.isError).not.toBe(true);

    const analyzeRes = await mcpHttp.callTool('upwork_analyze_job', {
      job_id: '~01abc',
    });
    expect(analyzeRes.isError).not.toBe(true);

    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~01abc',
        cover_letter: 'Tailored Go + TypeScript proposal with Postgres migration testing.',
        bid_type: 'fixed',
        bid_amount: 1800,
        screening_answers: [
          'Built httptest and Playwright E2E suites for Go APIs.',
          'Use Atlas versioned migrations with isolated test DBs.',
        ],
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    expect(proposalId).toBeTruthy();

    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: proposalId,
    });
    expect(fillRes.isError).not.toBe(true);

    const unapproved = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId }),
    );
    expect(unapproved.ok).toBe(false);
    expect(unapproved.errorText).toContain('APPROVAL_REQUIRED');

    const stateBefore = await mockClient.getState();
    expect(stateBefore.submittedProposals).toHaveLength(0);

    const sidePanel = await extPages.openSidePanel();
    try {
      const approvalsTab = sidePanel
        .locator('[data-testid="tab-approvals"]')
        .or(sidePanel.getByRole('tab', { name: /approvals/i }))
        .or(sidePanel.getByRole('button', { name: /approvals/i }))
        .first();
      if ((await approvalsTab.count()) > 0) {
        await approvalsTab.click();
      }
      const approveBtn = sidePanel
        .locator('[data-testid="approve-submit-btn"]')
        .or(sidePanel.getByRole('button', { name: /approve\s*&\s*submit/i }))
        .first();
      await approveBtn.click();
      await expect(sidePanel.getByText(/submitted/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await sidePanel.close();
    }

    const syncRes = await mcpHttp.callTool('upwork_sync_proposals', {});
    expect(syncRes.isError).not.toBe(true);

    const rows = await workerDb.query<{ status: string }>(
      'SELECT status FROM proposals WHERE id = $1',
      [proposalId],
    );
    expect(rows[0]?.status).toBe('submitted');
  });

  test('T3-04: F6 x F7 x F8 Messages x draft_only Block -> confirm_in_ui Approve x MCP', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'draft_only' }),
    });

    const listRes = await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    expect(listRes.isError).not.toBe(true);

    const getRes = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_101',
      sync: true,
    });
    expect(getRes.isError).not.toBe(true);

    const draft = parseMcpToolJson<{
      approval_token?: string;
      message?: { approval_token?: string };
    }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_101',
        body: 'I am available at 10am CST tomorrow to walk through the audit.',
        prefill_composer: true,
      }),
    );
    const token = draft.approval_token ?? draft.message?.approval_token ?? 'dummy-token';

    const blocked = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_101',
        approval_token: token,
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.errorText).toMatch(/draft_only|POLICY_DRAFT_ONLY/i);

    const stateBefore = await mockClient.getState();
    expect(stateBefore.rooms.room_alpha.messages).toHaveLength(3);

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'confirm_in_ui' }),
    });

    const sidePanel = await extPages.openSidePanel();
    try {
      const msgTab = sidePanel
        .locator('[data-testid="tab-messages"]')
        .or(sidePanel.getByRole('tab', { name: /messages/i }))
        .or(sidePanel.getByRole('button', { name: /messages/i }))
        .first();
      if ((await msgTab.count()) > 0) {
        await msgTab.click();
      }
      const approveSendBtn = sidePanel
        .locator('[data-testid="approve-send-btn"]')
        .or(sidePanel.getByRole('button', { name: /approve\s*&\s*send/i }))
        .first();
      await approveSendBtn.click();
      await expect(sidePanel.getByText(/sent/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await sidePanel.close();
    }

    const stateAfter = await mockClient.getState();
    expect(
      stateAfter.rooms.room_alpha.messages.some((m) =>
        m.body.includes('I am available at 10am CST tomorrow'),
      ),
    ).toBe(true);

    const msgRows = await workerDb.query<{ body: string; status: string }>(
      "SELECT body, status FROM messages WHERE body LIKE '%10am CST tomorrow%'",
    );
    expect(msgRows.length).toBeGreaterThanOrEqual(1);

    const auditRows = await workerDb.query<{ action_type: string }>(
      'SELECT action_type FROM action_audit_logs',
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  test('T3-05: F1 x F8 WS Disconnect & Watchdog Reconnect x MCP RPC Recovery', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    createMcpHttpClient,
    daemon,
  }) => {
    const initialStatus = parseMcpToolJson<{ extension_connected: boolean }>(
      await mcpHttp.callTool('upwork_session_status', {}),
    );
    expect(initialStatus.extension_connected).toBe(true);

    // Restart daemon to drop the WS connection and observe EXTENSION_DISCONNECTED immediately on boot
    await daemon.stop();
    await daemon.start();

    const postRestartMcp = await createMcpHttpClient();

    const downStatus = parseMcpToolJson<{ extension_connected: boolean }>(
      await postRestartMcp.callTool('upwork_session_status', {}),
    );
    if (!downStatus.extension_connected) {
      const tabsFail = await callToolSafely(() => postRestartMcp.callTool('upwork_list_tabs', {}));
      expect(tabsFail.ok).toBe(false);
      expect(tabsFail.errorText).toContain('EXTENSION_DISCONNECTED');
    }

    // Extension reconnects automatically via backoff / alarm watchdog without reloading extension
    const recovered = await waitForExtensionConnected(daemon, true, 22_000);
    expect(recovered.extension_connected).toBe(true);

    const tabsOk = await postRestartMcp.callTool('upwork_list_tabs', {});
    expect(tabsOk.isError).not.toBe(true);

    const searchOk = await postRestartMcp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
    });
    expect(searchOk.isError).not.toBe(true);
  });

  test('T3-06: F1 x F2 x F3 x F8 Single Automation Tab Mutex x Concurrent MCP Discovery & Enrichment', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    upworkPage,
  }) => {
    await upworkPage.goto('https://www.upwork.com/nx/find-work/best-matches', {
      waitUntil: 'domcontentloaded',
    });

    const [searchRes, detailRes] = await Promise.all([
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 2,
      }),
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~02xyz/',
      }),
    ]);

    expect(searchRes.isError).not.toBe(true);
    expect(detailRes.isError).not.toBe(true);

    // User's original tab remains untouched
    expect(upworkPage.url()).toBe('https://www.upwork.com/nx/find-work/best-matches');

    const tabsPayload = parseMcpToolJson<{
      tabs?: Array<{ id: number; url: string; automation?: boolean }>;
    }>(await mcpHttp.callTool('upwork_list_tabs', {}));
    const automationTabs = (tabsPayload.tabs ?? []).filter((t) => t.automation);
    expect(automationTabs.length).toBeLessThanOrEqual(1);

    const requests = await mockClient.getRequests();
    const navRequests = requests.filter(
      (r) => r.pathname.startsWith('/nx/search/jobs') || r.pathname.startsWith('/jobs/~02xyz'),
    );
    expect(navRequests.length).toBeGreaterThanOrEqual(3);
  });

  test('T3-07: F2 x F3 x F8 Search Profile YAML Import x Sweep Execution x upwork://jobs/hot Resource', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    workerDb,
  }) => {
    const yamlProfile = [
      'name: golang_sniper',
      'description: High-scoring Go backend jobs',
      'search:',
      '  mode: live_search',
      '  query: golang',
      '  max_pages: 1',
      '  delay_between_pages_seconds: 0.1',
      'filters:',
      '  required_keywords: ["golang"]',
      '  min_score: 70',
      'enrichment:',
      '  enabled: true',
      '  max_jobs_to_enrich: 2',
      '  delay_between_details_seconds: 0.1',
    ].join('\n');

    const saveRes = await mcpHttp.callTool('upwork_manage_search_profiles', {
      action: 'save',
      yaml: yamlProfile,
      name: 'golang_sniper',
    });
    expect(saveRes.isError).not.toBe(true);

    const dbProfiles = await workerDb.query<{ name: string }>(
      "SELECT name FROM search_profiles WHERE name = 'golang_sniper'",
    );
    expect(dbProfiles).toHaveLength(1);

    const runRes = await mcpHttp.callTool('upwork_manage_search_profiles', {
      action: 'run',
      profile: 'golang_sniper',
      name: 'golang_sniper',
    });
    expect(runRes.isError).not.toBe(true);

    const hotResource = await mcpHttp.readResource('upwork://jobs/hot');
    const hotText = hotResource.contents[0]?.text ?? '';
    expect(hotText.length).toBeGreaterThan(0);
    const parsedHot = JSON.parse(hotText) as { jobs?: ApiJobRow[] } | ApiJobRow[];
    const hotJobs = Array.isArray(parsedHot) ? parsedHot : (parsedHot.jobs ?? []);
    expect(hotJobs.every((j) => (j.score ?? 0) >= 80)).toBe(true);
  });

  test('T3-08: F3 x F5 x F8 Job Analysis x Agent Blueprint Generation x Side Panel & Zip Download', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
    workerDb,
    extPages,
  }) => {
    await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Golang & PostgreSQL Platform',
        url: 'https://www.upwork.com/jobs/~030100000000000000001/',
        upwork_job_id: '~030100000000000000001',
        skills: ['Go', 'PostgreSQL'],
        score: 88,
      }),
    });

    const genRes = await mcpHttp.callTool('upwork_generate_project_agents', {
      job_id: '~030100000000000000001',
      template_name: 'golang',
      agent_names: ['go-api-agent', 'gorm-model-agent'],
      format: 'copilot',
    });
    expect(genRes.isError).not.toBe(true);

    const dbAgents = await workerDb.query<{
      template_name: string;
      blueprint_name: string;
      format: string;
    }>('SELECT template_name, blueprint_name, format FROM generated_agents');
    expect(dbAgents.length).toBeGreaterThanOrEqual(2);

    const listRes = await daemon.apiFetch('/api/agents');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      agents: Array<{ blueprint_name: string; format: string }>;
    };
    expect(listBody.agents.length).toBeGreaterThanOrEqual(2);

    const sidePanel = await extPages.openSidePanel();
    try {
      const agentsTab = sidePanel
        .locator('[data-testid="tab-agents"], [data-testid="tab-blueprints"]')
        .or(sidePanel.getByRole('tab', { name: /agent|blueprint/i }))
        .or(sidePanel.getByRole('button', { name: /agent|blueprint/i }))
        .first();
      if ((await agentsTab.count()) > 0) {
        await agentsTab.click();
      }
      await expect(sidePanel.getByText(/go-api-agent|Go API Agent/i).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }

    const zipRes = await daemon.apiFetch('/api/agents/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_name: 'golang',
        format: 'copilot',
        agent_names: ['go-api-agent', 'gorm-model-agent'],
      }),
    });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type') ?? '').toContain('application/zip');
    const buf = Buffer.from(await zipRes.arrayBuffer());
    expect(buf.subarray(0, 2).toString('utf8')).toBe('PK');
    const zipText = buf.toString('latin1');
    expect(zipText).toContain('.github/instructions/');
  });

  test('T3-09: F2 x F3 x F1 Passive GraphQL Tap (world: MAIN) x DOM Adapter Merge x API Proxy', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mockClient.configure({
      passiveTapEnabled: true,
      omitDomClientMetrics: true,
    });

    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);

    const apiRes = await daemon.apiFetch('/api/jobs');
    expect(apiRes.status).toBe(200);
    const body = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const target = body.jobs.find((j) => j.upwork_job_id === '~022115332344639171');
    expect(target).toBeDefined();
    expect(target?.connects_required).toBe(12);
    expect(target?.client_hire_rate).toBe(85);
  });

  test('T3-10: F5 x F7 x F8 Proposal Connects/Screening Guardrails x auto_with_guardrails', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 3,
        max_connects_per_day: 10,
        min_job_score: 60,
      }),
    });

    // Job 1 (~01abc): unanswered required screening question
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~01abc/',
    });
    const d1 = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~01abc',
        cover_letter: 'Job 1 missing required screening answer.',
        bid_type: 'fixed',
        bid_amount: 1800,
        screening_answers: ['', 'Atlas migrations'],
      }),
    );
    const id1 = d1.proposal?.id ?? d1.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id1 });
    const sub1 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id1 }),
    );
    expect(sub1.ok).toBe(false);
    expect(sub1.errorText).toMatch(/screening|required|unanswered/i);

    // Job 2 (~022115332344639171): requires 12 connects (> 10 cap)
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    const d2 = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Job 2 requires 12 connects exceeding 10 cap.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Completed CWV audit.', '30 hrs/wk'],
      }),
    );
    const id2 = d2.proposal?.id ?? d2.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id2 });
    const sub2 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id2 }),
    );
    expect(sub2.ok).toBe(false);
    expect(sub2.errorText).toContain('DAILY_CAP_EXCEEDED');

    // Job 3 (~022111887415567641942): requires 8 connects (<= 10) and all questions answered
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022111887415567641942/',
    });
    const d3 = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022111887415567641942',
        cover_letter: 'Job 3 within 10 connects cap and all questions answered.',
        bid_type: 'fixed',
        bid_amount: 1000,
        screening_answers: ['Verify DNS TTL and dig propagation before cutover.'],
      }),
    );
    const id3 = d3.proposal?.id ?? d3.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id3 });
    const sub3 = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id3 });
    expect(sub3.isError).not.toBe(true);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(1);
    expect(state.submittedProposals[0].jobId).toBe('~022111887415567641942');
  });

  test('T3-11: F4 x F7 x F8 Drift Audit x Challenge Guard HUMAN_ACTION_REQUIRED Safety', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    workerDb,
  }) => {
    await mockClient.configure({ challenge: 'captcha' });

    const auditRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      }),
    );
    expect(auditRes.ok).toBe(false);
    expect(auditRes.errorText).toContain('HUMAN_ACTION_REQUIRED');

    const brokenRows = await workerDb.query<{ id: number }>(
      "SELECT id FROM selector_audits WHERE overall_status = 'BROKEN'",
    );
    expect(brokenRows).toHaveLength(0);
  });

  test('T3-12: F6 x F3 x F5 Unread Messages x Linked Job & Active Proposal Context', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    workerDb,
    extPages,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~01linked/',
    });
    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~01linked',
        cover_letter: 'Linked proposal context.',
        bid_type: 'fixed',
        bid_amount: 1600,
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    await workerDb.query("UPDATE proposals SET status = 'submitted' WHERE id = $1", [proposalId]);

    const listRes = await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    expect(listRes.isError).not.toBe(true);

    const getRes = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_777',
      sync: true,
    });
    expect(getRes.isError).not.toBe(true);
    const convText = getRes.content.map((c) => c.text ?? '').join('\n');
    expect(convText).toContain('Linked Message Thread Integration Job');

    const threadRows = await workerDb.query<{
      job_id: number | null;
      proposal_id: number | null;
      unread_count: number;
    }>(
      "SELECT job_id, proposal_id, unread_count FROM message_threads WHERE upwork_room_id = 'room_777'",
    );
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0].job_id).not.toBeNull();
    expect(threadRows[0].proposal_id).not.toBeNull();
    expect(threadRows[0].unread_count).toBe(2);

    const unreadRes = await mcpHttp.readResource('upwork://messages/unread');
    const unreadText = unreadRes.contents[0]?.text ?? '';
    expect(unreadText).toContain('room_777');
    expect(unreadText).toContain('Linked Message Thread Integration Job');

    const sidePanel = await extPages.openSidePanel();
    try {
      const msgTab = sidePanel
        .locator('[data-testid="tab-messages"]')
        .or(sidePanel.getByRole('tab', { name: /messages/i }))
        .or(sidePanel.getByRole('button', { name: /messages/i }))
        .first();
      if ((await msgTab.count()) > 0) {
        await msgTab.click();
      }
      await expect(
        sidePanel.getByText(/Linked Message Thread Integration Job|Dana Brooks/i).first(),
      ).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });

  test('T3-13: F1 x F8 Streamable HTTP + stdio Dual-Transport Interoperability', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    createMcpStdioClient,
  }) => {
    const mcpStdio = await createMcpStdioClient();

    const detailRes = await mcpStdio.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~05dual/',
    });
    expect(detailRes.isError).not.toBe(true);

    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpStdio.callTool('upwork_draft_proposal', {
        job_id: '~05dual',
        cover_letter: 'Drafted over stdio MCP transport.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Confirmed synchronous kickoff availability.'],
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    expect(proposalId).toBeTruthy();

    // Fill via Streamable HTTP MCP client against shared Postgres + WS bridge
    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: proposalId,
    });
    expect(fillRes.isError).not.toBe(true);

    const pendingRes = await mcpHttp.readResource('upwork://proposals/pending-approval');
    const pendingText = pendingRes.contents[0]?.text ?? '';
    expect(pendingText).toContain('~05dual');
  });

  test('T3-14: F3 x F8 Profile Update x Live Re-Scoring & Resource Sync', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_profile', {
      action: 'update',
      description: 'WordPress developer',
      skills: ['WordPress'],
      target_rate: 60,
    });

    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~06rust/',
    });

    const baselineRes = parseMcpToolJson<{ score?: number; job?: ApiJobRow }>(
      await mcpHttp.callTool('upwork_analyze_job', { job_id: '~06rust' }),
    );
    const baselineScore = baselineRes.score ?? baselineRes.job?.score ?? 0;

    await mcpHttp.callTool('upwork_profile', {
      action: 'update',
      description: 'Systems engineer specializing in Rust, PostgreSQL, and Go.',
      skills: ['Rust', 'PostgreSQL', 'Go'],
      target_rate: 120,
    });

    const profileRes = await mcpHttp.readResource('upwork://profile');
    const profileText = profileRes.contents[0]?.text ?? '';
    expect(profileText).toContain('Rust');
    expect(profileText).toContain('PostgreSQL');
    expect(profileText).toMatch(/updated_at|lastSyncedAt/);

    const updatedRes = parseMcpToolJson<{
      score?: number;
      score_breakdown?: ApiJobRow['score_breakdown'];
      job?: ApiJobRow;
    }>(await mcpHttp.callTool('upwork_analyze_job', { job_id: '~06rust' }));
    const updatedScore = updatedRes.score ?? updatedRes.job?.score ?? 0;
    expect(updatedScore).toBeGreaterThan(baselineScore);

    const apiRes = await daemon.apiFetch('/api/jobs');
    const apiBody = (await apiRes.json()) as { jobs: ApiJobRow[] };
    const job = apiBody.jobs.find((j) => j.upwork_job_id === '~06rust');
    expect(job?.score_breakdown?.skill_match ?? 0).toBeGreaterThanOrEqual(15);
  });
});
