import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import {
  getSessionStatus,
  pairExtensionWithDaemon,
  waitForExtensionConnected,
} from '../helpers/pairing.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

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

test.describe('Tier 2 — F8: Embedded Go MCP Server (Streamable HTTP + stdio)', () => {
  test('T2-F8-01: /mcp rejects unauthenticated/invalid Bearer (401) and malformed JSON-RPC (-32700 / 400)', async ({
    daemon,
  }) => {
    const noAuth = await fetch(daemon.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).not.toContain(daemon.apiToken);

    const badAuth = await fetch(daemon.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token-value',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(badAuth.status).toBe(401);
    expect(await badAuth.text()).not.toContain(daemon.apiToken);

    const malformed = await fetch(daemon.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.apiToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{broken',
    });
    const malformedBody = await malformed.text();
    const isExpectedParseError = malformed.status === 400 || malformedBody.includes('-32700');
    expect(isExpectedParseError).toBe(true);
    expect(malformedBody).not.toMatch(/goroutine|panic|runtime error/i);
  });

  test('T2-F8-02: Unknown MCP tool, unknown resource URI & invalid params (-32602 / isError: true)', async ({
    mcpHttp,
  }) => {
    const unknownTool = await callToolSafely(() => mcpHttp.callTool('upwork_unknown_tool', {}));
    expect(unknownTool.ok).toBe(false);
    expect(unknownTool.errorText).toMatch(/unknown|not found|-32601|-32602/i);

    const invalidView = await callToolSafely(() =>
      mcpHttp.callTool('upwork_audit_selectors', { view: 'invalid_view' }),
    );
    expect(invalidView.ok).toBe(false);

    const missingParams = await callToolSafely(() => mcpHttp.callTool('upwork_draft_proposal', {}));
    expect(missingParams.ok).toBe(false);

    let resourceFailed = false;
    try {
      const resRead = await mcpHttp.readResource('upwork://nonexistent');
      if (resRead.contents.length === 0) {
        resourceFailed = true;
      }
    } catch (err) {
      resourceFailed = err instanceof Error;
    }
    expect(resourceFailed).toBe(true);

    // Session remains healthy for valid calls
    const statusRes = await mcpHttp.callTool('upwork_session_status', {});
    expect(statusRes.isError).not.toBe(true);
  });

  test('T2-F8-03: Browser-backed MCP tools return EXTENSION_DISCONNECTED when WS is down', async ({
    extensionCtx,
    daemon,
    mcpHttp,
  }) => {
    let wasConnected = false;
    try {
      const s = await getSessionStatus(daemon);
      wasConnected = s.extension_connected;
    } catch {
      wasConnected = false;
    }

    if (wasConnected && extensionCtx.manifest.optionsPath) {
      const optionsPage = await extensionCtx.context.newPage();
      try {
        await optionsPage.goto(extensionCtx.getExtensionUrl(extensionCtx.manifest.optionsPath), {
          waitUntil: 'domcontentloaded',
        });
        const urlInput = optionsPage
          .locator(
            '[data-testid="daemon-url-input"], input[name="daemonUrl"], input[name="apiBaseUrl"], input[type="url"]',
          )
          .or(optionsPage.getByLabel(/daemon.*url|api.*url|server.*url/i))
          .first();
        await urlInput.fill('http://127.0.0.1:1');
        const explicitSaveBtn = optionsPage.locator('[data-testid="save-options-btn"]');
        const saveBtn =
          (await explicitSaveBtn.count()) > 0
            ? explicitSaveBtn.first()
            : optionsPage.getByRole('button', { name: /save|pair/i }).first();
        await saveBtn.click();
      } finally {
        await optionsPage.close();
      }
      await waitForExtensionConnected(daemon, false, 15_000);
    }

    try {
      const browserBackedCalls: Array<[string, Record<string, unknown>]> = [
        ['upwork_search_jobs', { source: 'search', query: 'WordPress', max_pages: 1 }],
        ['upwork_get_job_details', { url: 'https://www.upwork.com/jobs/~022115332344639171/' }],
        ['upwork_audit_selectors', { view: 'search_listings' }],
        ['upwork_fill_proposal_form', { proposal_id: 1 }],
        ['upwork_list_conversations', { sync: true }],
      ];

      for (const [toolName, args] of browserBackedCalls) {
        const res = await callToolSafely(() => mcpHttp.callTool(toolName, args));
        expect(res.ok).toBe(false);
        expect(res.errorText).toContain('EXTENSION_DISCONNECTED');
      }

      // DB-only tools continue working
      const savedJobs = await mcpHttp.callTool('upwork_list_saved_jobs', {});
      expect(savedJobs.isError).not.toBe(true);

      const profile = await mcpHttp.callTool('upwork_profile', { action: 'get' });
      expect(profile.isError).not.toBe(true);
    } finally {
      if (wasConnected) {
        await pairExtensionWithDaemon(extensionCtx, daemon, { pacingSeconds: 0.1 });
      }
    }
  });

  test('T2-F8-04: MCP upwork_submit_proposal & upwork_send_message surface APPROVAL_REQUIRED & DAILY_CAP_EXCEEDED', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_get_job_details', {
      url: 'https://www.upwork.com/jobs/~022115332344639171/',
    });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    const draft = parseMcpToolJson<{ proposal?: { id: number }; id?: number }>(
      await mcpHttp.callTool('upwork_draft_proposal', {
        job_id: '~022115332344639171',
        cover_letter: 'MCP approval & cap test proposal.',
        bid_type: 'fixed',
        bid_amount: 1500,
        screening_answers: ['Completed CWV audits.', 'Available immediately.'],
      }),
    );
    const proposalId = draft.proposal?.id ?? draft.id;
    await mcpHttp.callTool('upwork_fill_proposal_form', { proposal_id: proposalId });

    // Step 1: confirm_in_ui without approval_token
    const subNoToken = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId }),
    );
    expect(subNoToken.ok).toBe(false);
    expect(subNoToken.errorText).toContain('APPROVAL_REQUIRED');

    const msgNoToken = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        body: 'Needs UI approval.',
      }),
    );
    expect(msgNoToken.ok).toBe(false);
    expect(msgNoToken.errorText).toContain('APPROVAL_REQUIRED');

    // Step 2: auto_with_guardrails with 0 daily caps
    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_proposals_per_day: 0,
        max_messages_per_day: 0,
        max_connects_per_day: 100,
        min_job_score: 0,
        allowed_room_ids: ['room_alpha'],
      }),
    });

    const subCapZero = await callToolSafely(() =>
      mcpHttp.callTool('upwork_submit_proposal', { proposal_id: proposalId }),
    );
    expect(subCapZero.ok).toBe(false);
    expect(subCapZero.errorText).toContain('DAILY_CAP_EXCEEDED');

    const msgCapZero = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        body: 'Blocked by zero daily cap.',
      }),
    );
    expect(msgCapZero.ok).toBe(false);
    expect(msgCapZero.errorText).toContain('DAILY_CAP_EXCEEDED');
  });

  test('T2-F8-05: MCP tools return HUMAN_ACTION_REQUIRED on login wall / CAPTCHA challenge', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
  }) => {
    await mockClient.configure({ challenge: 'captcha' });

    const searchHalt = await callToolSafely(() =>
      mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 1,
      }),
    );
    expect(searchHalt.ok).toBe(false);
    expect(searchHalt.errorText).toContain('HUMAN_ACTION_REQUIRED');

    await mockClient.configure({ challenge: 'login' });

    const detailHalt = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_job_details', {
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
      }),
    );
    expect(detailHalt.ok).toBe(false);
    expect(detailHalt.errorText).toContain('HUMAN_ACTION_REQUIRED');
  });

  test('T2-F8-06: MCP entity-not-found & unsupported format errors', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const analyzeMissing = await callToolSafely(() =>
      mcpHttp.callTool('upwork_analyze_job', { job_id: '999999' }),
    );
    expect(analyzeMissing.ok).toBe(false);
    expect(analyzeMissing.errorText).toMatch(/not found|999999|missing/i);

    // Save a valid job so format validation is isolated from missing job
    await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Go Backend Service',
        url: 'https://www.upwork.com/jobs/~030100000000000000001/',
        upwork_job_id: '~030100000000000000001',
      }),
    });

    const badFormat = await callToolSafely(() =>
      mcpHttp.callTool('upwork_generate_project_agents', {
        job_id: '~030100000000000000001',
        template_name: 'golang',
        agent_names: ['go-api-agent'],
        format: 'unsupported_agent',
      }),
    );
    expect(badFormat.ok).toBe(false);
    expect(badFormat.errorText).toMatch(/format|unsupported|invalid/i);

    const missingRoom = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_conversation', {
        room_id: 'room_missing',
        sync: true,
      }),
    );
    expect(missingRoom.ok).toBe(false);
    expect(missingRoom.errorText).toMatch(/ROOM_NOT_FOUND|not found|404/i);

    // Daemon & MCP remain responsive
    const statusRes = await mcpHttp.callTool('upwork_session_status', {});
    expect(statusRes.isError).not.toBe(true);
  });
});
