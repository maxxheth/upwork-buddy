import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiProposal {
  id: number;
  job_id?: number;
  upwork_job_id?: string;
  cover_letter: string;
  bid_type: string;
  bid_amount?: number;
  status: string;
  approval_token?: string;
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

test.describe('Tier 2 — F5: Proposal Automation & Status Sync', () => {
  test('T2-F5-01: Unanswered required screening question blocks proposal.submit & Side Panel Submit', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    extPages,
  }) => {
    const jobRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    expect(jobRes.isError).not.toBe(true);

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Experienced WordPress & Go SEO architect ready to audit your site.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: ['', '30 hours/week available'],
        boost_connects: 0,
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    expect(proposalId).toBeTruthy();

    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId });

    // 1. Test under confirm_in_ui via Side Panel Approve & Submit
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
      await expect(approveBtn).toBeVisible();
      await approveBtn.click();
      await expect(sidePanel.getByText(/screening|required|unanswered/i).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }

    // 2. Test under auto_with_guardrails via MCP upwork_submit_proposal
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

    const submitRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId }),
    );
    expect(submitRes.ok).toBe(false);
    expect(submitRes.errorText).toMatch(/screening|question|required|unanswered/i);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(0);

    const propRes = await daemon.apiFetch(`/api/proposals/${proposalId}`);
    if (propRes.ok) {
      const propBody = (await propRes.json()) as { proposal?: ApiProposal; status?: string };
      expect(propBody.proposal?.status ?? propBody.status).not.toBe('submitted');
    }
  });

  test('T2-F5-02: Vue/Air3 reactive read-back mismatch aborts before queueing corrupt snapshot', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mockClient.configure({ lockApplyBid: true });

    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Ready to deliver your WordPress audit.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: ['Completed 20+ CWV audits.', 'Available immediately.'],
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    expect(proposalId).toBeTruthy();

    const fillRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId }),
    );
    expect(fillRes.ok).toBe(false);
    expect(fillRes.errorText).toMatch(/fill_verification_failed|mismatch|read-back|1400/i);

    const listRes = await daemon.apiFetch('/api/proposals');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { proposals: ApiProposal[] };
    const stored = listBody.proposals.find((p) => p.id === proposalId);
    expect(stored?.status).not.toBe('pending_approval');
  });

  test('T2-F5-03: Expired, invalid, or already-consumed approval_token rejected (no replay)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    workerDb,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639172/',
    });

    const draftA = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal A tailored cover letter.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['CWV audit answer', 'Full-time'],
      }),
    );
    const idA = draftA.proposal?.id ?? draftA.id;
    expect(idA).toBeTruthy();

    const fillA = parseMcpToolJson<{ approval_token?: string; proposal?: ApiProposal }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idA }),
    );
    const tokenA = fillA.approval_token ?? fillA.proposal?.approval_token;
    expect(tokenA).toBeTruthy();

    // Consume tokenA legitimately
    const submitA = await mcpHttp.callTool('upwork_submit_proposal', {
      proposal_id: idA,
      approval_token: tokenA,
    });
    expect(submitA.isError).not.toBe(true);

    // Create Proposal B
    const draftB = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639172',
        cover_letter: 'Proposal B tailored cover letter.',
        bid_type: 'fixed',
        bid_amount: 250,
      }),
    );
    const idB = draftB.proposal?.id ?? draftB.id;
    expect(idB).toBeTruthy();

    const fillB = parseMcpToolJson<{ approval_token?: string; proposal?: ApiProposal }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idB }),
    );
    const tokenB = fillB.approval_token ?? fillB.proposal?.approval_token;
    expect(tokenB).toBeTruthy();

    // Replay tokenA on A and on B
    const replayOnA = await daemon.apiFetch(`/api/proposals/${idA}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: tokenA }),
    });
    expect([400, 403, 409]).toContain(replayOnA.status);

    const replayOnB = await daemon.apiFetch(`/api/proposals/${idB}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: tokenA }),
    });
    expect([400, 403, 409]).toContain(replayOnB.status);

    // Invalid token on B
    const invalidOnB = await daemon.apiFetch(`/api/proposals/${idB}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: 'invalid-tok' }),
    });
    expect([400, 403, 409]).toContain(invalidOnB.status);

    // Expire tokenB by aging approved_at/updated_at beyond TTL
    await workerDb.query(
      "UPDATE proposals SET updated_at = NOW() - INTERVAL '2 days', approved_at = NOW() - INTERVAL '2 days' WHERE id = $1",
      [idB],
    );
    const expiredOnB = await daemon.apiFetch(`/api/proposals/${idB}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: tokenB }),
    });
    expect([400, 403, 409]).toContain(expiredOnB.status);

    // Confirm only Proposal A was submitted on mock server
    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(1);
    expect(state.submittedProposals[0].jobId).toBe('~022115332344639171');
  });

  test('T2-F5-04: Closed / already-applied proposal page aborts cleanly', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const saveClosedJob = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Closed Job For Apply Check',
        url: 'https://www.upwork.com/jobs/~022115332344639404/',
        upwork_job_id: '~022115332344639404',
      }),
    });
    expect(saveClosedJob.ok).toBe(true);

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639404',
        cover_letter: 'Attempting fill on already-applied job.',
        bid_type: 'fixed',
        bid_amount: 500,
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;

    const fillRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId }),
    );
    expect(fillRes.ok).toBe(false);
    expect(fillRes.errorText).toMatch(/ALREADY_APPLIED|JOB_UNAVAILABLE|already submitted|missing/i);

    const listRes = await daemon.apiFetch('/api/proposals');
    const listBody = (await listRes.json()) as { proposals: ApiProposal[] };
    const stored = listBody.proposals.find((p) => p.id === proposalId);
    expect(stored?.status).not.toBe('pending_approval');
  });

  test('T2-F5-05: Insufficient Upwork Connects balance on apply page blocks submit', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    upworkPage,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Cover letter with 4 boost connects exceeding 6 available.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Completed audits.', 'Available now.'],
        boost_connects: 4,
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;

    // Pre-open apply page with ?connects=6 so the DOM reflects 6 available connects (< 16 required)
    await upworkPage.goto(
      'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/?connects=6',
      { waitUntil: 'domcontentloaded' },
    );

    const fillRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_fill_proposal_form', {
        proposal_id: proposalId,
        apply_url: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/?connects=6',
      }),
    );

    if (fillRes.ok && fillRes.result) {
      const filled = parseMcpToolJson<{ approval_token?: string }>(fillRes.result);
      const submitRes = await callToolSafely(() =>
        mcpHttp.callTool('upwork_submit_proposal', {
          proposal_id: proposalId,
          approval_token: filled.approval_token,
        }),
      );
      expect(submitRes.ok).toBe(false);
      expect(submitRes.errorText).toMatch(/connects|insufficient/i);
    } else {
      expect(fillRes.errorText).toMatch(/connects|insufficient/i);
    }

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(0);
  });

  test('T2-F5-06: Invalid proposal draft payloads rejected (empty cover_letter, negative bid, missing job_id)', async ({
    daemon,
  }) => {
    const emptyCover = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: 1,
        cover_letter: '   ',
        bid_type: 'fixed',
        bid_amount: 500,
      }),
    });
    expect([400, 404, 422]).toContain(emptyCover.status);

    const negativeBid = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: 1,
        cover_letter: 'Valid cover letter text',
        bid_type: 'fixed',
        bid_amount: -50,
      }),
    });
    expect([400, 404, 422]).toContain(negativeBid.status);

    const missingJob = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: 999999,
        cover_letter: 'Valid cover letter text',
        bid_type: 'fixed',
        bid_amount: 500,
      }),
    });
    expect([400, 404, 422]).toContain(missingJob.status);

    const listRes = await daemon.apiFetch('/api/proposals');
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { proposals: ApiProposal[] };
    expect(body.proposals).toHaveLength(0);
  });
});
