import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ProposalRecord {
  id: number;
  job_id: number;
  status: string;
  bid_type: string;
  bid_amount: number | string;
  boost_connects: number;
  approval_token?: string;
  submitted_at?: string | null;
  upwork_proposal_url?: string;
  milestones_json?: unknown;
  screening_answers_json?: unknown;
}

async function seedJob(
  daemon: { apiFetch: (path: string, init?: RequestInit) => Promise<Response> },
  upworkId: string,
  title: string,
  contractType: 'fixed' | 'hourly' = 'fixed',
): Promise<number> {
  const res = await daemon.apiFetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      upwork_job_id: upworkId,
      job_title: title,
      job_description: `Detailed specification for ${title}.`,
      url: `https://www.upwork.com/jobs/${upworkId}/`,
      contract_type: contractType,
      connects_required: contractType === 'hourly' ? 10 : 12,
      score: 88,
      fit_label: 'hot',
    }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { id: number };
  return body.id;
}

test.describe('Tier 1 F5 — Proposal Automation & Status Sync', () => {
  test('T1-F5-01: structured proposal draft creation via POST /api/proposals', async ({
    daemon,
  }) => {
    const jobId = await seedJob(daemon, '~022115332344639171', 'On-Page SEO Expert Needed');

    const createRes = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        cover_letter: 'I can audit your WordPress/Elementor stack and ship Core Web Vitals fixes.',
        bid_type: 'fixed',
        bid_amount: 1400,
        milestones_json: [
          { description: 'Technical SEO Audit', due_date: '2026-12-01', amount: 700 },
          { description: 'CWV & Schema Rollout', due_date: '2026-12-15', amount: 700 },
        ],
        screening_answers_json: [
          'Completed 12 WordPress CWV audits reaching 95+ Lighthouse scores.',
          'Available 30+ hrs/week starting immediately.',
        ],
        boost_connects: 4,
        portfolio_refs_json: [{ title: 'HVAC SEO Audit', url: 'https://example.com/hvac' }],
      }),
    });
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as { proposal?: ProposalRecord } & ProposalRecord;
    const status = created.proposal?.status ?? created.status;
    expect(status).toBe('draft');

    const listRes = await daemon.apiFetch('/api/proposals');
    expect(listRes.status).toBe(200);
    const { proposals } = (await listRes.json()) as { proposals: ProposalRecord[] };
    expect(proposals.length).toBe(1);
    expect(proposals[0].boost_connects).toBe(4);
    expect(JSON.stringify(proposals[0].milestones_json)).toContain('Technical SEO Audit');
    expect(JSON.stringify(proposals[0].screening_answers_json)).toContain('95+ Lighthouse');
  });

  test('T1-F5-02: Vue/Air3-safe proposal form fill & pre-submit verification snapshot', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
  }) => {
    const jobId = await seedJob(daemon, '~022115332344639171', 'On-Page SEO Expert Needed');

    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: jobId,
      cover_letter: 'Detailed WordPress SEO audit plan with measurable CWV benchmarks.',
      bid_type: 'fixed',
      bid_amount: 1400,
      screening_answers: [
        'Audited 15 HVAC WordPress sites to 95+ mobile LCP.',
        'Available 35 hrs/week.',
      ],
      boost_connects: 4,
    });
    expect(draftRes.isError).not.toBe(true);
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    const proposalId = draft.proposal_id ?? draft.id;

    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: proposalId,
    });
    expect(fillRes.isError).not.toBe(true);
    const snapshot = parseMcpToolJson<{
      cover_letter_length: number;
      bid_amount: number;
      total_connects: number;
      screening_answers: unknown[];
      status: string;
    }>(fillRes);

    expect(snapshot.cover_letter_length).toBeGreaterThan(20);
    expect(Number(snapshot.bid_amount)).toBe(1400);
    expect(snapshot.total_connects).toBe(16);
    expect(snapshot.screening_answers.length).toBe(2);
    expect(snapshot.status).toBe('pending_approval');

    // Verify reactive state on the live mock apply tab retained all inputs and did NOT click Submit.
    const applyPage = pairedExtension.context
      .pages()
      .find((p) => p.url().includes('/nx/proposals/job/~022115332344639171/apply/'));
    expect(applyPage).toBeDefined();
    const reactiveState = await applyPage?.evaluate(() => {
      return (
        window as unknown as {
          __mockProposalState?: {
            bidAmount: string;
            coverLetter: string;
            boostConnects: number;
            screeningAnswers: string[];
          };
        }
      ).__mockProposalState;
    });
    expect(Number(reactiveState?.bidAmount)).toBe(1400);
    expect(reactiveState?.coverLetter).toContain('Detailed WordPress SEO audit plan');
    expect(Number(reactiveState?.boostConnects)).toBe(4);
    expect(reactiveState?.screeningAnswers.length).toBe(2);

    const mockState = await mockClient.getState();
    expect(mockState.submittedProposals.length).toBe(0);
  });

  test('T1-F5-03: confirm_in_ui approval queue card & extension badge increment', async ({
    pairedExtension,
    daemon,
    extPages,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const jobId = await seedJob(daemon, '~022115332344639171', 'On-Page SEO Expert Needed');
    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: jobId,
      cover_letter: 'Proposal cover letter ready for Side Panel approval review.',
      bid_type: 'fixed',
      bid_amount: 1400,
      screening_answers: ['CWV case study attached.', '30+ hrs/week.'],
      boost_connects: 4,
    });
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: draft.proposal_id ?? draft.id,
    });

    const listRes = await daemon.apiFetch('/api/proposals');
    const { proposals } = (await listRes.json()) as { proposals: ProposalRecord[] };
    expect(proposals[0].status).toBe('pending_approval');
    expect((proposals[0].approval_token ?? '').length).toBeGreaterThan(0);

    const popup = await extPages.openPopup();
    try {
      await expect(
        popup.locator('[data-testid="pending-approvals-count"]').or(popup.getByText(/1/)).first(),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await popup.close();
    }

    const sidePanel = await extPages.openSidePanel();
    try {
      const approvalsTab = sidePanel
        .getByRole('tab', { name: /approvals?/i })
        .or(sidePanel.getByRole('button', { name: /approvals?/i }))
        .first();
      await approvalsTab.click();

      await expect(sidePanel.getByText(/1,400|1400/)).toBeVisible({ timeout: 10_000 });
      await expect(sidePanel.getByText(/16\s*Connects/i)).toBeVisible();
      await expect(
        sidePanel.getByRole('button', { name: /approve\s*&\s*submit/i }).first(),
      ).toBeVisible();
      await expect(sidePanel.getByRole('button', { name: /reject/i }).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });

  test('T1-F5-04: Side Panel Approve & Submit execution & confirmation verification', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const jobId = await seedJob(daemon, '~022115332344639171', 'On-Page SEO Expert Needed');
    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: jobId,
      cover_letter: 'Ready to submit upon 1-click Side Panel approval.',
      bid_type: 'fixed',
      bid_amount: 1400,
      screening_answers: ['CWV audit summary.', 'Immediate availability.'],
      boost_connects: 4,
    });
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);
    const proposalId = draft.proposal_id ?? draft.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId });

    const sidePanel = await extPages.openSidePanel();
    try {
      const approvalsTab = sidePanel
        .getByRole('tab', { name: /approvals?/i })
        .or(sidePanel.getByRole('button', { name: /approvals?/i }))
        .first();
      await approvalsTab.click();

      await sidePanel
        .getByRole('button', { name: /approve\s*&\s*submit/i })
        .first()
        .click();

      await expect
        .poll(
          async () => {
            const propRes = await daemon.apiFetch(`/api/proposals/${proposalId}`);
            if (!propRes.ok) return '';
            const body = (await propRes.json()) as { proposal?: ProposalRecord } & ProposalRecord;
            return (body.proposal ?? body).status;
          },
          { timeout: 15_000 },
        )
        .toBe('submitted');
    } finally {
      await sidePanel.close();
    }

    const mockState = await mockClient.getState();
    expect(mockState.submittedProposals.length).toBe(1);
    expect(mockState.submittedProposals[0].jobId).toBe('~022115332344639171');

    const propRes = await daemon.apiFetch(`/api/proposals/${proposalId}`);
    const body = (await propRes.json()) as { proposal?: ProposalRecord } & ProposalRecord;
    const prop = body.proposal ?? body;
    expect(prop.submitted_at).toBeTruthy();
    expect(prop.upwork_proposal_url ?? '').toContain('/nx/proposals/confirmation/');

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      logs: Array<{ action_type?: string; action?: string }>;
    };
    const hasSubmitLog = auditBody.logs.some(
      (l) => (l.action_type ?? l.action) === 'proposal_submitted',
    );
    expect(hasSubmitLog).toBe(true);
  });

  test('T1-F5-05: hourly proposal form fill (rate, rate-increase selector)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    const jobId = await seedJob(
      daemon,
      '~022115332344639180',
      'Senior Go Systems Consultant (Hourly)',
      'hourly',
    );

    const draftRes = await mcpHttp.callTool('upwork_draft_proposal', {
      job_id: jobId,
      cover_letter: 'Experienced Go systems engineer for long-term performance tuning.',
      bid_type: 'hourly',
      bid_amount: 85,
      rate_increase: '3m',
      screening_answers: ['Diagnosed mutex contention via pprof on high-throughput gRPC workers.'],
    });
    expect(draftRes.isError).not.toBe(true);
    const draft = parseMcpToolJson<{ proposal_id?: number; id?: number }>(draftRes);

    const fillRes = await mcpHttp.callTool('upwork_fill_proposal_form', {
      proposal_id: draft.proposal_id ?? draft.id,
    });
    expect(fillRes.isError).not.toBe(true);
    const snapshot = parseMcpToolJson<{
      bid_type: string;
      bid_amount: number;
      status: string;
    }>(fillRes);

    expect(snapshot.bid_type).toBe('hourly');
    expect(Number(snapshot.bid_amount)).toBe(85);
    expect(snapshot.status).toBe('pending_approval');

    const applyPage = pairedExtension.context
      .pages()
      .find((p) => p.url().includes('/nx/proposals/job/~022115332344639180/apply/'));
    expect(applyPage).toBeDefined();
    const reactiveState = await applyPage?.evaluate(() => {
      return (
        window as unknown as {
          __mockProposalState?: { bidAmount: string; rateIncrease: string };
        }
      ).__mockProposalState;
    });
    expect(Number(reactiveState?.bidAmount)).toBe(85);
    expect(['3m', '6m', 'never']).toContain(reactiveState?.rateIncrease);
  });

  test('T1-F5-06: proposals status sync from /nx/proposals/ (proposals.sync)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const jobId = await seedJob(daemon, '~022115332344639171', 'On-Page SEO Expert Needed');
    const createRes = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        cover_letter: 'Initial submitted proposal.',
        bid_type: 'fixed',
        bid_amount: 1500,
        status: 'submitted',
      }),
    });
    expect(createRes.ok).toBe(true);

    const syncRes = await mcpHttp.callTool('upwork_sync_proposals', {});
    expect(syncRes.isError).not.toBe(true);

    const listRes = await daemon.apiFetch('/api/proposals');
    expect(listRes.status).toBe(200);
    const { proposals } = (await listRes.json()) as {
      proposals: Array<ProposalRecord & { upwork_job_id?: string }>;
    };

    const updated171 = proposals.find(
      (p) => p.job_id === jobId || p.upwork_job_id === '~022115332344639171',
    );
    expect(updated171?.status).toBe('interviewing');

    const statuses = new Set(proposals.map((p) => p.status));
    expect(statuses.has('offer') || statuses.has('offers')).toBe(true);
    expect(statuses.has('archived')).toBe(true);
  });
});
