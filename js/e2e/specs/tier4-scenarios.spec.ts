import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiJobRow {
  id: number;
  upwork_job_id?: string;
  canonical_url?: string;
  job_title: string;
  connects_required?: number | null;
  client_hire_rate?: number | null;
  payment_verified?: boolean | null;
  hours_per_week?: string | null;
  screening_questions?: unknown[];
  attachments?: unknown[];
  score?: number | null;
}

interface RuleAuditResult {
  field?: string;
  status: string;
}

interface DriftAuditReport {
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

test.describe('Tier 4 — Real-World Application Scenarios', () => {
  test('T4-01: Full Authenticated Job Discovery-to-Proposal Submission (confirm_in_ui)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    await mcpHttp.callTool('upwork_profile', {
      action: 'update',
      description: 'Senior Go, TypeScript, and PostgreSQL architect.',
      skills: ['Go', 'TypeScript', 'PostgreSQL'],
      target_rate: 110,
      portfolio_items: [
        {
          title: 'WXT MV3 + Go MCP Bridge',
          link: 'https://example.com/wxt-go',
          description: 'Chrome MV3 extension bridged to Go MCP daemon over loopback WS.',
        },
        {
          title: 'Postgres 17 Workflow Engine',
          link: 'https://example.com/pg-engine',
          description: 'High-reliability PostgreSQL workflow automation platform.',
        },
      ],
    });

    const session = parseMcpToolJson<{
      extension_connected: boolean;
      upwork_logged_in?: boolean;
      policy_mode?: string;
    }>(await mcpHttp.callTool('upwork_session_status', {}));
    expect(session.extension_connected).toBe(true);
    expect(session.policy_mode).toBe('confirm_in_ui');

    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'Go PostgreSQL',
      max_pages: 1,
      enrich_top_n: 2,
    });
    expect(searchRes.isError).not.toBe(true);

    const bestMatchesRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'best_matches',
      max_pages: 1,
    });
    expect(bestMatchesRes.isError).not.toBe(true);

    const apiJobsRes = await daemon.apiFetch('/api/jobs');
    expect(apiJobsRes.status).toBe(200);
    const apiJobs = (await apiJobsRes.json()) as { jobs: ApiJobRow[] };

    // Overlapping ~033000000000000000001 deduplicated
    const dedupMatches = apiJobs.jobs.filter((j) => j.upwork_job_id === '~033000000000000000001');
    expect(dedupMatches).toHaveLength(1);

    const targetJob = apiJobs.jobs.find((j) => j.upwork_job_id === '~040100000000000000002');
    expect(targetJob).toBeDefined();
    expect(targetJob?.canonical_url).not.toContain('span-class-highlight');
    expect(targetJob?.canonical_url).not.toContain('referrer_url_path');
    expect(targetJob?.payment_verified).toBe(true);
    expect(targetJob?.connects_required).toBe(10);
    expect(targetJob?.hours_per_week).toBe('30+ hrs/week');
    expect((targetJob?.screening_questions ?? []).length).toBe(2);
    expect((targetJob?.attachments ?? []).length).toBeGreaterThanOrEqual(1);

    await mcpHttp.callTool('upwork_analyze_job', { job_id: '~040100000000000000002' });

    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~040100000000000000002',
        cover_letter:
          'We built production Go + PostgreSQL workflow engines with TypeScript extension hooks.',
        bid_type: 'fixed',
        bid_amount: 2200,
        screening_answers: [
          'Serializable and read-committed retry loops with pgx transactions.',
          'Built full Chromium MV3 Playwright harnesses in TypeScript.',
        ],
        portfolio_refs: ['WXT MV3 + Go MCP Bridge', 'Postgres 17 Workflow Engine'],
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    expect(proposalId).toBeTruthy();

    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: proposalId,
    });
    expect(fillRes.isError).not.toBe(true);

    const blockedSubmit = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId }),
    );
    expect(blockedSubmit.ok).toBe(false);
    expect(blockedSubmit.errorText).toContain('APPROVAL_REQUIRED');

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
      await expect(sidePanel.getByText(/2,200|2200/).first()).toBeVisible();
      const approveBtn = sidePanel
        .locator('[data-testid="approve-submit-btn"]')
        .or(sidePanel.getByRole('button', { name: /approve\s*&\s*submit/i }))
        .first();
      await approveBtn.click();
      await expect(sidePanel.getByText(/submitted/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await sidePanel.close();
    }

    await mcpHttp.callTool('upwork_sync_proposals', {});

    const stateAfter = await mockClient.getState();
    expect(stateAfter.submittedProposals).toHaveLength(1);
    expect(stateAfter.submittedProposals[0].coverLetter).toContain(
      'Go + PostgreSQL workflow engines',
    );

    const dbProps = await workerDb.query<{
      status: string;
      approved_at: string | null;
      submitted_at: string | null;
    }>('SELECT status, approved_at, submitted_at FROM proposals WHERE id = $1', [proposalId]);
    expect(dbProps[0]?.status).toBe('submitted');
    expect(dbProps[0]?.approved_at).not.toBeNull();
    expect(dbProps[0]?.submitted_at).not.toBeNull();

    const activeProposalsRes = await mcpHttp.readResource('upwork://proposals/active');
    expect(activeProposalsRes.contents[0]?.text ?? '').toContain('~040100000000000000002');

    const auditRows = await workerDb.query<{ action_type: string }>(
      'SELECT action_type FROM action_audit_logs',
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
  });

  test('T4-02: HUMAN_ACTION_REQUIRED Mid-Workflow Challenge Halt (page 2 challenge & recovery)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    extPages,
  }) => {
    test.setTimeout(150_000);

    await mockClient.setScenario({
      challenge: 'captcha',
      challengeOnPath: '/nx/search/jobs/.*page=2',
    });

    const haltedSearch = await callToolSafely(() =>
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'react',
        max_pages: 3,
      }),
    );
    expect(haltedSearch.ok).toBe(false);
    expect(haltedSearch.errorText).toContain('HUMAN_ACTION_REQUIRED');

    const requests = await mockClient.getRequests('/nx/search/jobs/');
    expect(requests.some((r) => r.query.page === '1' || !r.query.page)).toBe(true);
    expect(requests.some((r) => r.query.page === '3')).toBe(false);

    // Page 1 jobs remain safely persisted
    const jobsRes = await daemon.apiFetch('/api/jobs');
    const jobsBody = (await jobsRes.json()) as { jobs: ApiJobRow[] };
    expect(jobsBody.jobs.some((j) => j.upwork_job_id === '~040200000000000000001')).toBe(true);

    const popup = await extPages.openPopup();
    try {
      await expect(popup.getByText(/human action|challenge|captcha/i).first()).toBeVisible();
    } finally {
      await popup.close();
    }

    // Clear challenge and verify clean recovery
    await mockClient.setScenario({ challenge: 'none', challengeOnPath: null });
    const recoveredStatus = parseMcpToolJson<{ extension_connected: boolean }>(
      await mcpHttp.callTool('upwork_session_status', {}),
    );
    expect(recoveredStatus.extension_connected).toBe(true);

    const recoveredSearch = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'react',
      max_pages: 2,
    });
    expect(recoveredSearch.isError).not.toBe(true);
  });

  test('T4-03: draft_only Hard Block + auto_with_guardrails Daily Cap Enforcement', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    // Seed 3 jobs: High-1 (88, 10 connects), Low (52, 4 connects), High-2 (85, 8 connects)
    for (const seed of [
      {
        job_title: 'High Score Job 1',
        url: 'https://www.upwork.com/jobs/~022115332344639180/',
        upwork_job_id: '~022115332344639180',
        score: 88,
        connects_required: 10,
      },
      {
        job_title: 'Low Score Job',
        url: 'https://www.upwork.com/jobs/~022115332344639172/',
        upwork_job_id: '~022115332344639172',
        score: 52,
        connects_required: 4,
      },
      {
        job_title: 'High Score Job 2',
        url: 'https://www.upwork.com/jobs/~022111887415567641942/',
        upwork_job_id: '~022111887415567641942',
        score: 85,
        connects_required: 8,
      },
    ]) {
      const res = await daemon.apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seed),
      });
      expect(res.ok).toBe(true);
    }

    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_202', sync: true });

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'draft_only' }),
    });

    const dHigh1 = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639180',
        cover_letter: 'High-1 proposal.',
        bid_type: 'hourly',
        bid_amount: 85,
        screening_answers: ['Diagnosed Go mutex contention via trace/pprof.'],
      }),
    );
    const idHigh1 = dHigh1.proposal?.id ?? dHigh1.id;
    const fillHigh1 = parseMcpToolJson<{ approval_token?: string }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idHigh1 }),
    );

    const draftMsg = parseMcpToolJson<{ approval_token?: string }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_202',
        body: 'Timeline draft under draft_only.',
        prefill_composer: true,
      }),
    );

    const blockedProp = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', {
        proposal_id: idHigh1,
        approval_token: fillHigh1.approval_token ?? 'forged-token',
      }),
    );
    expect(blockedProp.ok).toBe(false);

    const blockedMsg = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_202',
        approval_token: draftMsg.approval_token ?? 'forged-token',
      }),
    );
    expect(blockedMsg.ok).toBe(false);

    const stateAfterDraftOnly = await mockClient.getState();
    expect(stateAfterDraftOnly.submittedProposals).toHaveLength(0);

    // Switch to auto_with_guardrails
    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 1,
        max_connects_per_day: 20,
        max_messages_per_day: 2,
        min_job_score: 70,
      }),
    });

    const dLow = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639172',
        cover_letter: 'Low score proposal.',
        bid_type: 'fixed',
        bid_amount: 250,
      }),
    );
    const idLow = dLow.proposal?.id ?? dLow.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idLow });
    const subLow = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: idLow }),
    );
    expect(subLow.ok).toBe(false);

    const subHigh1 = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: idHigh1 });
    expect(subHigh1.isError).not.toBe(true);

    const dHigh2 = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022111887415567641942',
        cover_letter: 'Second high proposal hitting 1/1 daily cap.',
        bid_type: 'fixed',
        bid_amount: 1000,
        screening_answers: ['Verify DNS TTL before cutover.'],
      }),
    );
    const idHigh2 = dHigh2.proposal?.id ?? dHigh2.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idHigh2 });
    const subHigh2 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: idHigh2 }),
    );
    expect(subHigh2.ok).toBe(false);
    expect(subHigh2.errorText).toContain('DAILY_CAP_EXCEEDED');

    const status = parseMcpToolJson<{
      proposals_today?: number;
      connects_today?: number;
    }>(await mcpHttp.callTool('upwork_session_status', {}));
    expect(status.proposals_today).toBe(1);
    expect(status.connects_today).toBe(10);

    const sidePanel = await extPages.openSidePanel();
    try {
      await expect(sidePanel.getByText(/1\s*\/\s*1/).first()).toBeVisible();
      await expect(sidePanel.getByText(/10\s*\/\s*20/).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }

    const auditLogs = await workerDb.query<{ action_type: string; outcome: string }>(
      'SELECT action_type, outcome FROM action_audit_logs',
    );
    expect(auditLogs.length).toBeGreaterThanOrEqual(4);
  });

  test('T4-04: Emergency Kill Switch Abort interrupts active sweep & drops to draft_only', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 5,
        max_connects_per_day: 100,
        min_job_score: 0,
      }),
    });

    await mockClient.setScenario({
      totalSearchPages: 5,
      delayMsByPath: { '/nx/search/jobs/.*page=[2-5]': 1200 },
    });

    const inFlightPromise = callToolSafely(() =>
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'python',
        max_pages: 5,
      }),
    );

    // Wait until page 1 is requested on mock server
    await expect
      .poll(
        async () => {
          const reqs = await mockClient.getRequests('/nx/search/jobs/');
          return reqs.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const popup = await extPages.openPopup();
    try {
      const killBtn = popup
        .locator('[data-testid="kill-switch-btn"]')
        .or(popup.getByRole('button', { name: /kill\s*switch/i }))
        .first();
      await killBtn.click();
    } finally {
      await popup.close();
    }

    const sweepResult = await inFlightPromise;
    expect(sweepResult.ok).toBe(false);
    expect(sweepResult.errorText).toMatch(/abort|kill|draft_only|cancel/i);

    const policyRes = (await (await daemon.apiFetch('/api/policy')).json()) as { mode: string };
    expect(policyRes.mode).toBe('draft_only');

    const searchReqs = await mockClient.getRequests('/nx/search/jobs/');
    expect(searchReqs.some((r) => r.query.page === '5')).toBe(false);

    const auditRows = await workerDb.query<{ action_type: string }>(
      "SELECT action_type FROM action_audit_logs WHERE action_type LIKE '%kill%'",
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // Subsequent submit blocked because policy is now draft_only
    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~040400000000000000001',
        cover_letter: 'Blocked post-kill-switch.',
        bid_type: 'fixed',
        bid_amount: 1100,
      }),
    );
    const propId = draft.proposal?.id ?? draft.id;
    const postKillSubmit = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: propId }),
    );
    expect(postKillSubmit.ok).toBe(false);
  });

  test('T4-05: Client Reply Triage & Approval-Gated Messaging (unread -> draft -> Approve & Send)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~09msg/',
    });
    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~09msg',
        cover_letter: 'Go architecture proposal.',
        bid_type: 'fixed',
        bid_amount: 2000,
      }),
    );
    const propId = draft.proposal?.id ?? draft.id;
    await workerDb.query("UPDATE proposals SET status = 'submitted' WHERE id = $1", [propId]);

    await mockClient.setScenario({
      unreadMessages: [
        {
          roomId: 'room_901',
          sender: 'Fiona Sterling',
          body: 'Can you share your Go architecture approach?',
        },
      ],
    });

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });

    const unreadRes = await mcpHttp.readResource('upwork://messages/unread');
    expect(unreadRes.contents[0]?.text ?? '').toContain('room_901');

    const conv = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_901',
      sync: true,
    });
    expect(conv.content.map((c) => c.text ?? '').join('\n')).toContain(
      'Can you share your Go architecture approach?',
    );

    const draftReply = await mcpHttp.callTool('upwork_draft_message', {
      room_id: 'room_901',
      body: 'Happy to walk through our Go + Postgres architecture and migration plan.',
      prefill_composer: true,
    });
    expect(draftReply.isError).not.toBe(true);

    const blockedSend = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', { room_id: 'room_901' }),
    );
    expect(blockedSend.ok).toBe(false);
    expect(blockedSend.errorText).toContain('APPROVAL_REQUIRED');

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
      const approveBtn = sidePanel
        .locator('[data-testid="approve-send-btn"]')
        .or(sidePanel.getByRole('button', { name: /approve\s*&\s*send/i }))
        .first();
      await approveBtn.click();
      await expect(sidePanel.getByText(/sent/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await sidePanel.close();
    }

    const state = await mockClient.getState();
    expect(
      state.rooms.room_901.messages.some((m) => m.body.includes('Go + Postgres architecture')),
    ).toBe(true);
    expect(state.rooms.room_901.unreadCount).toBe(0);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const unreadAfter = await mcpHttp.readResource('upwork://messages/unread');
    expect(unreadAfter.contents[0]?.text ?? '').not.toContain('room_901');
  });

  test('T4-06: Upwork DOM Drift Detection & Hot-Reload Recovery (BROKEN -> YAML update -> HEALTHY)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    await mockClient.configure({ driftMode: 'broken_v2_card' });

    const brokenAudit = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
      }),
    );
    expect(brokenAudit.overall_status).toBe('BROKEN');

    const dbAudits = await workerDb.query<{ overall_status: string }>(
      "SELECT overall_status FROM selector_audits WHERE overall_status = 'BROKEN'",
    );
    expect(dbAudits.length).toBeGreaterThanOrEqual(1);

    const healthBefore = await mcpHttp.readResource('upwork://selectors/health');
    expect(healthBefore.contents[0]?.text ?? '').toContain('BROKEN');

    const sidePanel = await extPages.openSidePanel();
    try {
      const selTab = sidePanel
        .locator('[data-testid="tab-selectors"]')
        .or(sidePanel.getByRole('tab', { name: /selector/i }))
        .or(sidePanel.getByRole('button', { name: /selector/i }))
        .first();
      if ((await selTab.count()) > 0) {
        await selTab.click();
      }
      await expect(sidePanel.getByText(/BROKEN/i).first()).toBeVisible();

      await daemon.updateSelectorsYaml((yamlText) =>
        yamlText
          .replace(
            '  search_listings:\n    container_selectors:\n',
            '  search_listings:\n    container_selectors:\n      - "section[data-test=\'v2-job-card\']"\n',
          )
          .replace(
            '      title:\n        selectors:\n',
            '      title:\n        selectors:\n          - "a[data-qa=\'v2-title-anchor\']"\n',
          )
          .replace(
            '      url:\n        selectors:\n',
            '      url:\n        selectors:\n          - "a[data-qa=\'v2-title-anchor\']"\n',
          ),
      );

      const refreshBtn = sidePanel
        .locator('[data-testid="refresh-selectors-btn"]')
        .or(sidePanel.getByRole('button', { name: /refresh selectors/i }))
        .first();
      if ((await refreshBtn.count()) > 0) {
        await refreshBtn.click();
      }

      const recoveredAudit = parseMcpToolJson<DriftAuditReport>(
        await mcpHttp.callTool('upwork_audit_selectors', {
          view: 'search_listings',
          url: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
        }),
      );
      expect(getRule(recoveredAudit, 'title')?.status).toBe('HEALTHY');

      const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'typescript',
        max_pages: 1,
      });
      expect(searchRes.isError).not.toBe(true);
      const searchData = parseMcpToolJson<{ jobs?: ApiJobRow[]; items?: ApiJobRow[] }>(searchRes);
      const jobs = searchData.jobs ?? searchData.items ?? [];
      expect(jobs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await sidePanel.close();
      await daemon.restoreSelectorsYaml();
    }
  });

  test('T4-07: Multi-Agent Concurrent Workflow (stdio + Streamable HTTP) & Won-Job Delivery Blueprint Handoff', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    createMcpStdioClient,
    daemon,
    workerDb,
    extPages,
  }) => {
    test.setTimeout(150_000);

    const mcpStdio = await createMcpStdioClient();

    // Agent A (HTTP) sweeps saved_jobs while Agent B (stdio) syncs proposals concurrently
    const [savedSearchRes, syncPropRes] = await Promise.all([
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'saved_jobs',
        max_pages: 1,
      }),
      mcpStdio.callTool('upwork_sync_proposals', {}),
    ]);
    expect(savedSearchRes.isError).not.toBe(true);
    expect(syncPropRes.isError).not.toBe(true);

    const enrichRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~07won/',
    });
    expect(enrichRes.isError).not.toBe(true);

    const hotRes = await mcpHttp.readResource('upwork://jobs/hot');
    expect((hotRes.contents[0]?.text ?? '').length).toBeGreaterThan(0);

    const activeRes = await mcpStdio.readResource('upwork://proposals/active');
    expect(activeRes.contents[0]?.text ?? '').toContain('~07won');

    const genClaude = await mcpStdio.callTool('upwork_generate_project_agents', {
      job_id: '~07won',
      template_name: 'golang',
      agent_names: ['go-api-agent'],
      format: 'claude',
    });
    expect(genClaude.isError).not.toBe(true);

    const genCodex = await mcpStdio.callTool('upwork_generate_project_agents', {
      job_id: '~07won',
      template_name: 'golang',
      agent_names: ['go-api-agent'],
      format: 'codex',
    });
    expect(genCodex.isError).not.toBe(true);

    const dbAgents = await workerDb.query<{ format: string; blueprint_name: string }>(
      "SELECT format, blueprint_name FROM generated_agents WHERE blueprint_name = 'go-api-agent'",
    );
    const formats = dbAgents.map((a) => a.format);
    expect(formats).toContain('claude');
    expect(formats).toContain('codex');

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
        agent_names: ['go-api-agent'],
      }),
    });
    expect(zipRes.status).toBe(200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBuf.subarray(0, 2).toString('utf8')).toBe('PK');
  });
});
