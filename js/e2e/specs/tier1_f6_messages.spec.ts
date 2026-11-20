import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface MessageThreadEntry {
  room_id?: string;
  upwork_room_id?: string;
  client_name: string;
  unread_count: number;
  job_id?: number | null;
  upwork_job_id?: string;
}

interface ThreadMessageEntry {
  id: number | string;
  sender: string;
  body: string;
  timestamp?: string;
  created_at?: string;
  attachments?: unknown[];
  interview_card?: string;
  status?: string;
  approval_token?: string;
}

test.describe('Tier 1 F6 — Upwork Messages & Client Communication', () => {
  test('T1-F6-01: message rooms listing & persistence (upwork_list_conversations)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const listToolRes = await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    expect(listToolRes.isError).not.toBe(true);

    const res = await daemon.apiFetch('/api/messages/threads');
    expect(res.status).toBe(200);
    const { threads } = (await res.json()) as { threads: MessageThreadEntry[] };

    const alpha = threads.find((t) => (t.upwork_room_id ?? t.room_id) === 'room_alpha');
    const beta = threads.find((t) => (t.upwork_room_id ?? t.room_id) === 'room_beta');

    expect(alpha).toBeDefined();
    expect(alpha?.unread_count).toBe(2);
    expect(alpha?.client_name).toBe('Alice Vance');
    expect(alpha?.upwork_job_id ?? '').toContain('~022115332344639171');

    expect(beta).toBeDefined();
    expect(beta?.unread_count).toBe(0);
  });

  test('T1-F6-02: thread history reading & attachment/interview-card capture (upwork_get_conversation)', async ({
    pairedExtension,
    daemon,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const convRes = await mcpHttp.callTool('upwork_get_conversation', {
      room_id: 'room_alpha',
    });
    expect(convRes.isError).not.toBe(true);

    const res = await daemon.apiFetch('/api/messages/threads/room_alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread?: MessageThreadEntry;
      messages: ThreadMessageEntry[];
    };

    expect(body.messages.length).toBeGreaterThanOrEqual(3);
    expect(body.messages[0].sender).toBe('Alice Vance');
    expect(body.messages[0].body).toContain('site brief');
    expect(body.messages[0].timestamp ?? body.messages[0].created_at).toBeTruthy();

    const serialized = JSON.stringify(body.messages);
    expect(serialized).toContain('brief.pdf');
    expect(serialized).toContain('Interview Invitation');
  });

  test('T1-F6-03: draft reply & composer pre-fill without Send (upwork_draft_message)', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    await mcpHttp.callTool('upwork_list_conversations', { sync: true });

    const draftBody = 'Happy to walk through the architecture today.';
    const draftRes = await mcpHttp.callTool('upwork_draft_message', {
      room_id: 'room_alpha',
      body: draftBody,
      prefill_composer: true,
    });
    expect(draftRes.isError).not.toBe(true);
    const draftPayload = parseMcpToolJson<{
      status: string;
      approval_token?: string;
    }>(draftRes);
    expect(draftPayload.status).toBe('pending_approval');
    expect((draftPayload.approval_token ?? '').length).toBeGreaterThan(0);

    // Verify composer textarea in room_alpha retains the drafted message without sending.
    const threadPage = pairedExtension.context
      .pages()
      .find((p) => p.url().includes('/ab/messages/rooms/room_alpha'));
    expect(threadPage).toBeDefined();
    const composerVal = await threadPage?.locator('[data-test="composer-textarea"]').inputValue();
    expect(composerVal).toBe(draftBody);

    const sendRequests = await mockClient.getRequests('/api/mock/messages/');
    expect(sendRequests.length).toBe(0);

    const threadRes = await daemon.apiFetch('/api/messages/threads/room_alpha');
    const threadData = (await threadRes.json()) as { messages: ThreadMessageEntry[] };
    const pendingDraft = threadData.messages.find(
      (m) => m.status === 'pending_approval' && m.body === draftBody,
    );
    expect(pendingDraft).toBeDefined();
    expect((pendingDraft?.approval_token ?? '').length).toBeGreaterThan(0);

    const sidePanel = await extPages.openSidePanel();
    try {
      const messagesTab = sidePanel
        .getByRole('tab', { name: /messages?|inbox/i })
        .or(sidePanel.getByRole('button', { name: /messages?|inbox/i }))
        .first();
      await messagesTab.click();
      await expect(sidePanel.getByText(draftBody)).toBeVisible({ timeout: 10_000 });
      await expect(
        sidePanel.getByRole('button', { name: /approve\s*&\s*send/i }).first(),
      ).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });

  test('T1-F6-04: Side Panel Approve & Send reply execution & audit log verification', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const replyBody = 'Confirmed: sharing the milestone timeline and staging link now.';
    await mcpHttp.callTool('upwork_draft_message', {
      room_id: 'room_alpha',
      body: replyBody,
      prefill_composer: true,
    });

    const sidePanel = await extPages.openSidePanel();
    try {
      const messagesTab = sidePanel
        .getByRole('tab', { name: /messages?|inbox/i })
        .or(sidePanel.getByRole('button', { name: /messages?|inbox/i }))
        .first();
      await messagesTab.click();

      await sidePanel
        .getByRole('button', { name: /approve\s*&\s*send/i })
        .first()
        .click();

      await expect
        .poll(
          async () => {
            const state = await mockClient.getState();
            return state.rooms.room_alpha.messages.some((m) => m.body === replyBody);
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      await expect
        .poll(
          async () => {
            const res = await daemon.apiFetch('/api/messages/threads/room_alpha');
            if (!res.ok) return '';
            const data = (await res.json()) as { messages: ThreadMessageEntry[] };
            return data.messages.find((m) => m.body === replyBody)?.status ?? '';
          },
          { timeout: 15_000 },
        )
        .toBe('sent');
    } finally {
      await sidePanel.close();
    }

    const threadRes = await daemon.apiFetch('/api/messages/threads/room_alpha');
    const threadData = (await threadRes.json()) as { messages: ThreadMessageEntry[] };
    const sentMsg = threadData.messages.find((m) => m.body === replyBody);
    expect(sentMsg?.status).toBe('sent');

    const auditRes = await daemon.apiFetch('/api/audit-logs');
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      logs: Array<{ action_type?: string; action?: string }>;
    };
    const hasMessageSent = auditBody.logs.some(
      (l) => (l.action_type ?? l.action) === 'message_sent',
    );
    expect(hasMessageSent).toBe(true);
  });

  test('T1-F6-05: unread message polling alarm & Side Panel badge update', async ({
    pairedExtension,
    daemon,
    extPages,
    mockClient,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    const initialRes = await daemon.apiFetch('/api/messages/threads');
    const initialData = (await initialRes.json()) as { threads: MessageThreadEntry[] };
    const initialBeta = initialData.threads.find(
      (t) => (t.upwork_room_id ?? t.room_id) === 'room_beta',
    );
    expect(initialBeta?.unread_count).toBe(0);

    await mockClient.configure({
      unreadMessages: [
        {
          roomId: 'room_beta',
          sender: 'Bob Mercer',
          body: 'Can we kick off the FastAPI audit tomorrow morning?',
        },
      ],
    });

    const pollRes = await daemon.apiFetch('/api/messages/poll', { method: 'POST' });
    if (!pollRes.ok) {
      await mcpHttp.callTool('upwork_list_conversations', { sync: true });
    }

    await expect
      .poll(
        async () => {
          const res = await daemon.apiFetch('/api/messages/threads');
          const { threads } = (await res.json()) as { threads: MessageThreadEntry[] };
          const beta = threads.find((t) => (t.upwork_room_id ?? t.room_id) === 'room_beta');
          return beta?.unread_count ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBe(1);

    const sidePanel = await extPages.openSidePanel();
    try {
      const messagesTab = sidePanel
        .getByRole('tab', { name: /messages?|inbox/i })
        .or(sidePanel.getByRole('button', { name: /messages?|inbox/i }))
        .first();
      await messagesTab.click();

      await expect(sidePanel.getByText('Bob Mercer')).toBeVisible({ timeout: 10_000 });
      await expect(
        sidePanel.locator('[data-testid="unread-badge"], [data-unread="true"]').first(),
      ).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });
});
