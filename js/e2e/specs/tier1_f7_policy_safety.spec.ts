import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface PolicyState {
  mode: string;
  max_proposals_per_day?: number;
  max_connects_per_day?: number;
  max_messages_per_day?: number;
  proposals_today?: number;
  connects_today?: number;
  messages_today?: number;
}

test.describe('Tier 1 F7 — Policy Engine, Guardrails, Kill Switch & Challenge Safety', () => {
  test('T1-F7-01: default confirm_in_ui policy on clean daemon boot', async ({
    pairedExtension,
    daemon,
    extPages,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const policyRes = await daemon.apiFetch('/api/policy');
    expect(policyRes.status).toBe(200);
    const policy = (await policyRes.json()) as PolicyState;
    expect(policy.mode).toBe('confirm_in_ui');

    const popup = await extPages.openPopup();
    try {
      await expect(popup.getByText(/confirm_in_ui/i).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await popup.close();
    }

    const saveJob = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upwork_job_id: '~022115332344639171',
        job_title: 'On-Page SEO Expert Needed',
        job_description: 'Policy gating verification job.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        score: 85,
      }),
    });
    const job = (await saveJob.json()) as { id: number };

    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: job.id,
      cover_letter: 'Policy gate test cover letter.',
      bid_type: 'fixed',
      bid_amount: 1500,
      screening_answers: ['Completed CWV audits.', 'Available now.'],
    });
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    const proposalId = draft.proposal_id ?? draft.id;

    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: proposalId,
    });
    expect(fillRes.isError).not.toBe(true);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const msgDraftRes = await mcpHttp.callTool('upwork_draft_message', {
      room_id: 'room_alpha',
      body: 'Draft message succeeds under confirm_in_ui.',
      prefill_composer: false,
    });
    expect(msgDraftRes.isError).not.toBe(true);

    const submitWithoutToken = await mcpHttp.callTool('upwork_submit_proposal', {
      proposal_id: proposalId,
    });
    expect(submitWithoutToken.isError).toBe(true);
    expect(JSON.stringify(submitWithoutToken)).toContain('APPROVAL_REQUIRED');
  });

  test('T1-F7-02: auto_with_guardrails happy path & daily usage gauge increment', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const updatePolicyRes = await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 5,
        max_connects_per_day: 50,
        max_messages_per_day: 10,
        min_job_score: 60,
        allowed_room_ids: ['room_alpha'],
        quiet_hours: null,
      }),
    });
    expect(updatePolicyRes.ok).toBe(true);

    const saveJob = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upwork_job_id: '~022115332344639171',
        job_title: 'On-Page SEO Expert Needed',
        job_description: 'High score job for auto_with_guardrails.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        connects_required: 12,
        score: 85,
        fit_label: 'hot',
      }),
    });
    const job = (await saveJob.json()) as { id: number };

    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: job.id,
      cover_letter: 'Autonomous proposal submission within daily guardrails.',
      bid_type: 'fixed',
      bid_amount: 1500,
      boost_connects: 4,
      screening_answers: ['Completed 10+ WordPress CWV audits.', '30+ hrs/week.'],
    });
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    const proposalId = draft.proposal_id ?? draft.id;

    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId });
    const submitRes = await mcpHttp.callTool('upwork_submit_proposal', {
      proposal_id: proposalId,
    });
    expect(submitRes.isError).not.toBe(true);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const sendRes = await mcpHttp.callTool('upwork_send_message', {
      room_id: 'room_alpha',
      body: 'Autonomous reply to allowed room_alpha.',
    });
    expect(sendRes.isError).not.toBe(true);

    const mockState = await mockClient.getState();
    expect(mockState.submittedProposals.length).toBe(1);
    expect(
      mockState.rooms.room_alpha.messages.some(
        (m) => m.body === 'Autonomous reply to allowed room_alpha.',
      ),
    ).toBe(true);

    const policyRes = await daemon.apiFetch('/api/policy');
    const policy = (await policyRes.json()) as PolicyState;
    expect(policy.proposals_today).toBe(1);
    expect(policy.connects_today).toBe(16);
    expect(policy.messages_today).toBe(1);

    const sidePanel = await extPages.openSidePanel();
    try {
      const activityTab = sidePanel
        .getByRole('tab', { name: /activity|policy/i })
        .or(sidePanel.getByRole('button', { name: /activity|policy/i }))
        .first();
      await activityTab.click();
      await expect(sidePanel.getByText(/1\s*\/\s*5/)).toBeVisible({ timeout: 10_000 });
      await expect(sidePanel.getByText(/16\s*\/\s*50/)).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });

  test('T1-F7-03: instant Kill Switch from Popup aborts active search & drops to draft_only', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto_with_guardrails' }),
    });

    await mockClient.configure({
      totalSearchPages: 5,
      delayMsByPath: { '/nx/search/jobs/': 1500 },
    });

    const inFlightSearch = mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 5,
    });

    await expect
      .poll(async () => (await mockClient.getRequests('/nx/search/jobs/')).length, {
        timeout: 15_000,
      })
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

    const searchResult = await inFlightSearch;
    const serializedSearch = JSON.stringify(searchResult);
    expect(searchResult.isError === true || serializedSearch.toLowerCase().includes('abort')).toBe(
      true,
    );

    const hits = await mockClient.getRequests('/nx/search/jobs/');
    expect(hits.length).toBeLessThan(5);

    const policyRes = await daemon.apiFetch('/api/policy');
    const policy = (await policyRes.json()) as PolicyState;
    expect(policy.mode).toBe('draft_only');

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    const auditBody = (await auditRes.json()) as {
      logs: Array<{ action_type?: string; action?: string }>;
    };
    expect(
      auditBody.logs.some((l) => (l.action_type ?? l.action) === 'kill_switch_activated'),
    ).toBe(true);
  });

  test('T1-F7-04: instant Kill Switch from Side Panel aborts active enrichment & drops to draft_only', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await mockClient.configure({
      delayMsByPath: { '/jobs/': 1500 },
    });

    const inFlightEnrich = mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'WordPress',
      max_pages: 1,
      enrich_top_n: 4,
    });

    await expect
      .poll(async () => (await mockClient.getRequests('/jobs/')).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    const sidePanel = await extPages.openSidePanel();
    try {
      const killBtn = sidePanel
        .locator('[data-testid="kill-switch-btn"]')
        .or(sidePanel.getByRole('button', { name: /kill\s*switch/i }))
        .first();
      await killBtn.click();
    } finally {
      await sidePanel.close();
    }

    const result = await inFlightEnrich;
    const serialized = JSON.stringify(result).toLowerCase();
    expect(result.isError === true || serialized.includes('abort')).toBe(true);

    const detailHits = await mockClient.getRequests('/jobs/');
    expect(detailHits.length).toBeLessThan(4);

    const policyRes = await daemon.apiFetch('/api/policy');
    const policy = (await policyRes.json()) as PolicyState;
    expect(policy.mode).toBe('draft_only');
  });

  test('T1-F7-05: immutable action_audit_logs trail visible via API & Side Panel Activity Log', async ({
    pairedExtension,
    daemon,
    extPages,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto_with_guardrails' }),
    });

    const jobRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upwork_job_id: '~022115332344639171',
        job_title: 'Audit Trail Verification Job',
        job_description: 'Audit trail test job.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        score: 90,
      }),
    });
    const job = (await jobRes.json()) as { id: number };

    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: job.id,
      cover_letter: 'Audit log verification cover letter.',
      bid_type: 'fixed',
      bid_amount: 1500,
      screening_answers: ['CWV summary.', 'Available immediately.'],
    });
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    const proposalId = draft.proposal_id ?? draft.id;

    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId });
    await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId });
    await daemon.apiFetch('/api/policy/kill-switch', { method: 'POST' });

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    expect(auditRes.status).toBe(200);
    const { logs } = (await auditRes.json()) as {
      logs: Array<{
        action_type?: string;
        action?: string;
        created_at?: string;
        timestamp?: string;
        actor?: string;
        outcome?: string;
      }>;
    };
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const entry of logs) {
      expect(entry.action_type ?? entry.action).toBeTruthy();
      expect(entry.created_at ?? entry.timestamp).toBeTruthy();
    }

    const sidePanel = await extPages.openSidePanel();
    try {
      const activityTab = sidePanel
        .getByRole('tab', { name: /activity|policy/i })
        .or(sidePanel.getByRole('button', { name: /activity|policy/i }))
        .first();
      await activityTab.click();
      await expect(sidePanel.getByText(/kill_switch_activated/i).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(sidePanel.getByText(/proposal_submitted/i).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });
});
