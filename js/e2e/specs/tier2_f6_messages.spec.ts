import { type McpToolCallResult, parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface MessageRecord {
  id: number;
  sender: string;
  body: string;
  attachments?: unknown[];
  card?: unknown;
  attachments_json?: unknown[];
  card_json?: unknown;
  status?: string;
  approval_token?: string;
}

interface ThreadResponse {
  thread?: { upwork_room_id: string; unread_count: number };
  messages: MessageRecord[];
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

test.describe('Tier 2 — F6: Upwork Messages & Client Communication', () => {
  test('T2-F6-01: Non-existent or 404 message room (room_missing) handled cleanly', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
  }) => {
    const alphaRes = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_alpha',
      sync: true,
    });
    expect(alphaRes.isError).not.toBe(true);

    const missingRes = await callToolSafely(() =>
      mcpHttp.callTool('upwork_get_conversation', {
        room_id: 'room_missing',
        sync: true,
      }),
    );
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errorText).toMatch(/ROOM_NOT_FOUND|not found|unavailable|404/i);

    const threadRes = await daemon.apiFetch('/api/messages/threads/room_alpha');
    expect(threadRes.status).toBe(200);
    const threadBody = (await threadRes.json()) as ThreadResponse;
    expect(threadBody.messages.length).toBeGreaterThanOrEqual(3);
  });

  test('T2-F6-02: Empty or whitespace-only reply draft rejected before touching composer', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    daemon,
    upworkPage,
    extPages,
  }) => {
    await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_alpha',
      sync: true,
    });

    const apiDraft = await daemon.apiFetch('/api/messages/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room_id: 'room_alpha',
        body: '   \n\t  ',
        prefill_composer: true,
      }),
    });
    expect([400, 422]).toContain(apiDraft.status);

    const mcpDraft = await callToolSafely(() =>
      mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: '   \n\t  ',
        prefill_composer: true,
      }),
    );
    expect(mcpDraft.ok).toBe(false);

    await upworkPage.goto('https://www.upwork.com/ab/messages/rooms/room_alpha', {
      waitUntil: 'domcontentloaded',
    });
    await expect(upworkPage.locator('[data-test="composer-textarea"]')).toHaveValue('');

    const sidePanel = await extPages.openSidePanel();
    try {
      await expect(sidePanel.locator('[data-testid="approve-send-btn"]')).toHaveCount(0);
    } finally {
      await sidePanel.close();
    }
  });

  test('T2-F6-03: Incremental history sync idempotency & multi-attachment/offer-card edge cases', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    // Initial sync of room_alpha (3 messages, with brief.pdf + requirements-v2.pdf + interviewCard)
    const first = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_alpha',
      sync: true,
    });
    expect(first.isError).not.toBe(true);

    // Also verify room_e2e_103 preserves offerCard
    const offerThread = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_e2e_103',
      sync: true,
    });
    expect(offerThread.isError).not.toBe(true);

    // Inject 1 new inbound message into room_alpha
    await mockClient.setScenario({
      unreadMessages: [
        {
          roomId: 'room_alpha',
          sender: 'Alice Vance',
          body: 'Attached updated scope and interview schedule.',
        },
      ],
    });

    // Sync room_alpha twice consecutively to verify idempotent deduplication
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    const threadRes = await daemon.apiFetch('/api/messages/threads/room_alpha');
    expect(threadRes.status).toBe(200);
    const body = (await threadRes.json()) as ThreadResponse;
    expect(body.messages).toHaveLength(4);

    const firstMsg = body.messages[0];
    const atts = JSON.stringify(firstMsg.attachments ?? firstMsg.attachments_json ?? []);
    expect(atts).toContain('brief.pdf');
    expect(atts).toContain('requirements-v2.pdf');

    const offerRes = await daemon.apiFetch('/api/messages/threads/room_e2e_103');
    expect(offerRes.status).toBe(200);
    const offerBody = (await offerRes.json()) as ThreadResponse;
    expect(JSON.stringify(offerBody.messages)).toContain('Contract Offer');
  });

  test('T2-F6-04: allowed_room_ids guardrail enforcement under auto_with_guardrails', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_beta', sync: true });

    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto_with_guardrails',
        max_messages_per_day: 10,
        allowed_room_ids: ['room_alpha'],
      }),
    });

    const betaAttempt = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_beta',
        body: 'Autonomous reply to non-allowlisted room.',
      }),
    );
    expect(betaAttempt.ok).toBe(false);
    expect(betaAttempt.errorText).toMatch(/APPROVAL_REQUIRED|allowlist|allowed_room_ids|room/i);

    const stateAfterBeta = await mockClient.getState();
    expect(stateAfterBeta.rooms.room_beta.messages).toHaveLength(1);

    const alphaSend = await mcpHttp.callTool('upwork_send_message', {
      room_id: 'room_alpha',
      body: 'Autonomous reply to allowlisted room_alpha.',
    });
    expect(alphaSend.isError).not.toBe(true);

    const stateAfterAlpha = await mockClient.getState();
    expect(
      stateAfterAlpha.rooms.room_alpha.messages.some((m) =>
        m.body.includes('Autonomous reply to allowlisted room_alpha.'),
      ),
    ).toBe(true);
  });

  test('T2-F6-05: Replayed approval_token & draft_only rejection for send_message', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    await mcpHttp.callTool('upwork_get_conversation', { room_id: 'room_alpha', sync: true });

    const draft1 = parseMcpToolJson<{ approval_token?: string; message?: MessageRecord }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: 'First approved message M1.',
        prefill_composer: true,
      }),
    );
    const tokenM1 = draft1.approval_token ?? draft1.message?.approval_token;
    expect(tokenM1).toBeTruthy();

    const send1 = await mcpHttp.callTool('upwork_send_message', {
      room_id: 'room_alpha',
      approval_token: tokenM1,
    });
    expect(send1.isError).not.toBe(true);

    const draft2 = parseMcpToolJson<{ approval_token?: string; message?: MessageRecord }>(
      await mcpHttp.callTool('upwork_draft_message', {
        room_id: 'room_alpha',
        body: 'Second message M2 blocked by draft_only.',
        prefill_composer: false,
      }),
    );
    const tokenM2 = draft2.approval_token ?? draft2.message?.approval_token;
    expect(tokenM2).toBeTruthy();

    // Replay tokenM1
    const replayM1 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        approval_token: tokenM1,
      }),
    );
    expect(replayM1.ok).toBe(false);
    expect(replayM1.errorText).toMatch(/APPROVAL_REQUIRED|token|consumed|invalid/i);

    // Switch to draft_only and try valid tokenM2
    await daemon.apiFetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'draft_only' }),
    });

    const blockedM2 = await callToolSafely(() =>
      mcpHttp.callTool('upwork_send_message', {
        room_id: 'room_alpha',
        approval_token: tokenM2,
      }),
    );
    expect(blockedM2.ok).toBe(false);
    expect(blockedM2.errorText).toMatch(/draft_only|POLICY_DRAFT_ONLY|blocked/i);

    const state = await mockClient.getState();
    expect(state.rooms.room_alpha.messages.some((m) => m.body.includes('M2'))).toBe(false);
  });
});
