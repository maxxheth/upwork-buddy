import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiProposal {
  id: number;
  status: string;
  approval_token?: string;
}

interface PolicyResponse {
  mode: string;
  proposals_today?: number;
  connects_today?: number;
  messages_today?: number;
  max_proposals_per_day?: number;
  max_connects_per_day?: number;
  max_messages_per_day?: number;
}

interface AuditLogEntry {
  action_type: string;
  outcome: string;
  target_id?: string;
  details?: Record<string, unknown>;
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

test.describe('Tier 2 — F7: Policy Engine, Guardrails, Kill Switch & Challenge Safety', () => {
  test('T2-F7-01: Login wall redirect immediately halts automation & returns HUMAN_ACTION_REQUIRED', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    extPages,
  }) => {
    const loginSearch = await callToolSafely(() =>
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'login_wall',
        max_pages: 1,
      }),
    );
    expect(loginSearch.ok).toBe(false);
    expect(loginSearch.errorText).toContain('HUMAN_ACTION_REQUIRED');

    // Also verify challenge: 'login' on messages.list & proposal.fill
    await mockClient.configure({ challenge: 'login' });

    const loginMsgs = await callToolSafely(() =>
      mcpHttp.callTool('upwork_list_conversations', { sync: true }),
    );
    expect(loginMsgs.ok).toBe(false);
    expect(loginMsgs.errorText).toContain('HUMAN_ACTION_REQUIRED');

    const loginReqs = await mockClient.getRequests('/ab/account-security/login');
    expect(loginReqs.every((r) => r.method === 'GET')).toBe(true);

    const popup = await extPages.openPopup();
    try {
      await expect(popup.getByText(/human action|login|challenge/i).first()).toBeVisible();
    } finally {
      await popup.close();
    }
  });

  test('T2-F7-02: 2FA / CAPTCHA human verification challenge immediately halts & returns HUMAN_ACTION_REQUIRED', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    const seedJobRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'On-Page SEO Expert Needed',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        upwork_job_id: '~022115332344639171',
      }),
    });
    expect(seedJobRes.ok).toBe(true);

    await mockClient.configure({ challenge: 'captcha' });

    const detailHalt = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
      }),
    );
    expect(detailHalt.ok).toBe(false);
    expect(detailHalt.errorText).toContain('HUMAN_ACTION_REQUIRED');

    await mockClient.configure({ challenge: 'two_factor' });
    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Draft before 2FA challenge.',
        bid_type: 'fixed',
        bid_amount: 1500,
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    const fillHalt = await callToolSafely(() =>
      mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId }),
    );
    expect(fillHalt.ok).toBe(false);
    expect(fillHalt.errorText).toContain('HUMAN_ACTION_REQUIRED');

    const allReqs = await mockClient.getRequests();
    expect(
      allReqs.filter((r) => r.method === 'POST' && !r.path.startsWith('/api/graphql')),
    ).toHaveLength(0);

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      logs?: AuditLogEntry[];
      audit_logs?: AuditLogEntry[];
    };
    const entries = auditBody.logs ?? auditBody.audit_logs ?? [];
    expect(entries.some((e) => JSON.stringify(e).includes('HUMAN_ACTION_REQUIRED'))).toBe(true);
  });

  test('T2-F7-03: draft_only mode hard-blocks submit_proposal & send_message even with valid approval_token', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    const propDraft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Valid draft ready for approval token.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Completed 15 CWV audits.', 'Available 30+ hrs.'],
      }),
    );
    const propId = propDraft.proposal?.id ?? propDraft.id;
    const filledProp = parseMcpToolJson<{ approval_token?: string; proposal?: ApiProposal }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propId }),
    );
    const propToken = filledProp.approval_token ?? filledProp.proposal?.approval_token;
    expect(propToken).toBeTruthy();

    const msgDraft = parseMcpToolJson<{
      approval_token?: string;
      message?: { approval_token?: string };
    }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: 'Message draft with valid token.',
        prefill_composer: true,
      }),
    );
    const msgToken = msgDraft.approval_token ?? msgDraft.message?.approval_token;
    expect(msgToken).toBeTruthy();

    // Switch to draft_only
    const policyPut = await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'draft_only' }),
    });
    expect(policyPut.ok).toBe(true);

    const submitRes = await daemon.apiFetch(`/api/proposals/${propId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: propToken }),
    });
    expect(submitRes.status).toBe(403);
    expect(await submitRes.text()).toMatch(/draft_only|POLICY_DRAFT_ONLY/i);

    const sendRes = await daemon.apiFetch('/api/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: 'room_alpha', approval_token: msgToken }),
    });
    expect(sendRes.status).toBe(403);
    expect(await sendRes.text()).toMatch(/draft_only|POLICY_DRAFT_ONLY/i);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(0);
    expect(state.rooms.room_alpha.messages).toHaveLength(3);
  });

  test('T2-F7-04: max_proposals_per_day daily cap boundary (1/1 passes, 2/1 returns DAILY_CAP_EXCEEDED)', async ({
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
        max_proposals_per_day: 1,
        max_connects_per_day: 100,
        min_job_score: 0,
      }),
    });

    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639180/',
    });

    const d1 = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal 1 for daily cap boundary.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Audit answer.', 'Available.'],
      }),
    );
    const id1 = d1.proposal?.id ?? d1.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id1 });

    const d2 = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639180',
        cover_letter: 'Proposal 2 exceeding daily proposal cap.',
        bid_type: 'hourly',
        bid_amount: 85,
        screening_answers: ['Go concurrency profiling answer.'],
      }),
    );
    const id2 = d2.proposal?.id ?? d2.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id2 });

    const sub1 = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id1 });
    expect(sub1.isError).not.toBe(true);

    const policyMid = (await (await daemon.apiFetch('/api/policy')).json()) as PolicyResponse;
    expect(policyMid.proposals_today).toBe(1);

    const sub2 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id2 }),
    );
    expect(sub2.ok).toBe(false);
    expect(sub2.errorText).toContain('DAILY_CAP_EXCEEDED');

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(1);
    expect(state.submittedProposals[0].jobId).toBe('~022115332344639171');
  });

  test('T2-F7-05: max_connects_per_day boundary (20/20 passes, 21/20 returns DAILY_CAP_EXCEEDED)', async ({
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
        max_proposals_per_day: 10,
        max_connects_per_day: 20,
        min_job_score: 0,
      }),
    });

    // Submit proposal 0 costing 15 connects (12 base + 3 boost) -> connects_today = 15
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    const d0 = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Initial 15-connect proposal.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Audit experience.', 'Full availability.'],
        boost_connects: 3,
      }),
    );
    const id0 = d0.proposal?.id ?? d0.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id0 });
    const sub0 = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id0 });
    expect(sub0.isError).not.toBe(true);

    // Prepare 6-connect proposal (4 base + 2 boost -> 15 + 6 = 21 > 20)
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~030100000000000000002/',
    });
    const d6 = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~030100000000000000002',
        cover_letter: '6-connect proposal that exceeds 20 cap.',
        bid_type: 'fixed',
        bid_amount: 80,
        boost_connects: 2,
      }),
    );
    const id6 = d6.proposal?.id ?? d6.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id6 });

    const sub6 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id6 }),
    );
    expect(sub6.ok).toBe(false);
    expect(sub6.errorText).toContain('DAILY_CAP_EXCEEDED');

    const policyMid = (await (await daemon.apiFetch('/api/policy')).json()) as PolicyResponse;
    expect(policyMid.connects_today).toBe(15);

    // Prepare 5-connect proposal (4 base + 1 boost -> 15 + 5 = 20 <= 20)
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~030100000000000000003/',
    });
    const d5 = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~030100000000000000003',
        cover_letter: '5-connect proposal hitting exact 20 cap.',
        bid_type: 'fixed',
        bid_amount: 50,
        boost_connects: 1,
      }),
    );
    const id5 = d5.proposal?.id ?? d5.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: id5 });

    const sub5 = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: id5 });
    expect(sub5.isError).not.toBe(true);

    const policyAfter = (await (await daemon.apiFetch('/api/policy')).json()) as PolicyResponse;
    expect(policyAfter.connects_today).toBe(20);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(2);
  });

  test('T2-F7-06: max_messages_per_day daily cap boundary (1/1 passes, 2/1 returns DAILY_CAP_EXCEEDED)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_messages_per_day: 1,
        allowed_room_ids: ['room_alpha'],
      }),
    });

    const msg1 = await mcpHttp.callTool('upwork_send_message', {
      room_id: 'room_alpha',
      body: 'Message 1 within daily cap.',
    });
    expect(msg1.isError).not.toBe(true);

    const policyMid = (await (await daemon.apiFetch('/api/policy')).json()) as PolicyResponse;
    expect(policyMid.messages_today).toBe(1);

    const msg2 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        body: 'Message 2 exceeding daily cap.',
      }),
    );
    expect(msg2.ok).toBe(false);
    expect(msg2.errorText).toContain('DAILY_CAP_EXCEEDED');

    const state = await mockClient.getState();
    expect(state.rooms.room_alpha.messages).toHaveLength(4);
  });

  test('T2-F7-07: min_job_score boundary (score = 74 blocked, score = 75 permitted under min_job_score = 75)', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    const saveA = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Job Score 74 Boundary',
        url: 'https://www.upwork.com/jobs/~022115332344639172/',
        upwork_job_id: '~022115332344639172',
        score: 74,
        connects_required: 8,
      }),
    });
    expect(saveA.ok).toBe(true);

    const saveB = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Job Score 75 Boundary',
        url: 'https://www.upwork.com/jobs/~022115332344639180/',
        upwork_job_id: '~022115332344639180',
        score: 75,
        connects_required: 10,
      }),
    });
    expect(saveB.ok).toBe(true);

    const dA = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639172',
        cover_letter: 'Proposal for score 74 job.',
        bid_type: 'fixed',
        bid_amount: 250,
      }),
    );
    const idA = dA.proposal?.id ?? dA.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idA });

    const dB = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639180',
        cover_letter: 'Proposal for score 75 job.',
        bid_type: 'hourly',
        bid_amount: 85,
        screening_answers: ['Go concurrency bottleneck resolved via pprof.'],
      }),
    );
    const idB = dB.proposal?.id ?? dB.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: idB });

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 10,
        max_connects_per_day: 100,
        min_job_score: 75,
      }),
    });

    const subA = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: idA }),
    );
    expect(subA.ok).toBe(false);
    expect(subA.errorText).toMatch(/score|min_job_score|APPROVAL_REQUIRED|guardrail/i);

    const subB = await mcpHttp.callTool('upwork_submit_proposal', { proposal_id: idB });
    expect(subB.isError).not.toBe(true);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(1);
    expect(state.submittedProposals[0].jobId).toBe('~022115332344639180');
  });

  test('T2-F7-08: quiet_hours window blocks autonomous submit/send', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal blocked by quiet hours.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Audit completed.', 'Available.'],
      }),
    );
    const propId = draft.proposal?.id ?? draft.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propId });

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 10,
        max_connects_per_day: 100,
        max_messages_per_day: 10,
        min_job_score: 0,
        allowed_room_ids: ['room_alpha'],
        quiet_hours: '00:00-23:59',
      }),
    });

    const subQuiet = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: propId }),
    );
    expect(subQuiet.ok).toBe(false);
    expect(subQuiet.errorText).toMatch(/quiet/i);

    const msgQuiet = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        body: 'Message blocked by quiet hours.',
      }),
    );
    expect(msgQuiet.ok).toBe(false);
    expect(msgQuiet.errorText).toMatch(/quiet/i);

    const state = await mockClient.getState();
    expect(state.submittedProposals).toHaveLength(0);
    expect(state.rooms.room_alpha.messages).toHaveLength(3);

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    expect(auditRes.status).toBe(200);
    const auditText = await auditRes.text();
    expect(auditText.toLowerCase()).toContain('quiet');
  });
});
