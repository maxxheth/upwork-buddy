import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrlItem, authTokenItem } from '../shared/storage-items';
import {
  handleApiProxyMessage,
  isContentScriptProxyAllowed,
  isRuntimeSenderAuthorized,
  resolveDaemonUrl,
  shouldAttachBearerToken,
} from './api-proxy';
import { extractPolicyPatchFromProxyResponse, parsePolicyStateFromJson } from './policy-sync';

describe('Background API Proxy', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('attaches Bearer token only for daemon /api/* routes and never /health or external origins', () => {
    const base = 'http://127.0.0.1:45678';
    expect(shouldAttachBearerToken(resolveDaemonUrl('/api/jobs', base), base)).toBe(true);
    expect(shouldAttachBearerToken(resolveDaemonUrl('/api/selectors', base), base)).toBe(true);
    expect(shouldAttachBearerToken(resolveDaemonUrl('/mcp', base), base)).toBe(true);
    expect(shouldAttachBearerToken(resolveDaemonUrl('/mcp/sse', base), base)).toBe(true);
    expect(shouldAttachBearerToken(new URL('/mcp-evil', base), base)).toBe(false);
    expect(shouldAttachBearerToken(resolveDaemonUrl('/health', base), base)).toBe(false);
    expect(shouldAttachBearerToken(new URL('https://www.upwork.com/api/graphql'), base)).toBe(
      false,
    );
    expect(() => resolveDaemonUrl('//evil.com/api/jobs', base)).toThrow(
      'Protocol-relative proxy URL is not allowed',
    );
    expect(() => resolveDaemonUrl('/\\evil.com/api/jobs', base)).toThrow(
      'Protocol-relative proxy URL is not allowed',
    );
    expect(() => resolveDaemonUrl('https://evil.example/api/steal', base)).toThrow(/cross-origin/i);
    expect(() => resolveDaemonUrl('http://127.0.0.1:6379/flush', base)).toThrow(/cross-origin/i);
    expect(() => resolveDaemonUrl('/admin/shutdown', base)).toThrow(/allowed daemon paths/i);
    expect(() => resolveDaemonUrl('/mcp-evil', base)).toThrow(/allowed daemon paths/i);
  });

  it('authorizes runtime senders strictly by extension ID and tab origin', () => {
    const extId = 'abcdefghijklmnop';
    // Foreign extension ID rejected
    expect(isRuntimeSenderAuthorized('PASSIVE_TAP_PAYLOAD', { id: 'evil-ext-id' }, extId)).toBe(
      false,
    );
    expect(isRuntimeSenderAuthorized('PASSIVE_SEARCH_BATCH', { id: 'evil-ext-id' }, extId)).toBe(
      false,
    );

    // Content script on upwork.com allowed only content-safe commands
    const contentSender = {
      id: extId,
      url: 'https://www.upwork.com/nx/search/jobs/',
      tab: { id: 1, url: 'https://www.upwork.com/nx/search/jobs/' },
    };
    expect(isRuntimeSenderAuthorized('PASSIVE_TAP_PAYLOAD', contentSender, extId)).toBe(true);
    expect(isRuntimeSenderAuthorized('PASSIVE_SEARCH_BATCH', contentSender, extId)).toBe(true);
    expect(isRuntimeSenderAuthorized('API_PROXY_REQUEST', contentSender, extId)).toBe(true);
    expect(isRuntimeSenderAuthorized('TRIGGER_KILL_SWITCH', contentSender, extId)).toBe(false);
    expect(isRuntimeSenderAuthorized('PAIR_AND_RECONNECT', contentSender, extId)).toBe(false);
    expect(isRuntimeSenderAuthorized('BG_RUN_SEARCH', contentSender, extId)).toBe(false);

    // Non-upwork tab rejected even for content commands
    expect(
      isRuntimeSenderAuthorized(
        'PASSIVE_TAP_PAYLOAD',
        { id: extId, url: 'https://evil.example/', tab: { id: 2, url: 'https://evil.example/' } },
        extId,
      ),
    ).toBe(false);
    expect(
      isRuntimeSenderAuthorized(
        'PASSIVE_SEARCH_BATCH',
        { id: extId, url: 'https://evil.example/', tab: { id: 2, url: 'https://evil.example/' } },
        extId,
      ),
    ).toBe(false);

    // Extension UI tab (options/sidepanel opened in tab) allowed privileged commands
    expect(
      isRuntimeSenderAuthorized(
        'TRIGGER_KILL_SWITCH',
        {
          id: extId,
          url: `chrome-extension://${extId}/sidepanel.html`,
          tab: { id: 3, url: `chrome-extension://${extId}/sidepanel.html` },
        },
        extId,
      ),
    ).toBe(true);
  });

  it('rewrites legacy 127.0.0.1:9090 URLs to configured ephemeral daemon port and injects Bearer token', async () => {
    await apiUrlItem.setValue('http://127.0.0.1:41234');
    await authTokenItem.setValue('secret-bearer-xyz');

    const capturedCalls: Array<{ url: string; authHeader: string | null }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedCalls.push({
        url: String(input),
        authHeader: headers.get('Authorization'),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const reply = await handleApiProxyMessage(
      {
        type: 'API_PROXY_REQUEST',
        url: 'http://127.0.0.1:9090/api/selectors',
        method: 'GET',
      },
      { fetchImpl: mockFetch },
    );

    expect(reply.ok).toBe(true);
    expect(reply.status).toBe(200);
    expect(capturedCalls[0]?.url).toBe('http://127.0.0.1:41234/api/selectors');
    expect(capturedCalls[0]?.authHeader).toBe('Bearer secret-bearer-xyz');

    // Never send token to /health or external URLs
    await handleApiProxyMessage(
      {
        type: 'API_PROXY_REQUEST',
        url: '/health',
        method: 'GET',
      },
      { fetchImpl: mockFetch },
    );
    expect(capturedCalls[1]?.url).toBe('http://127.0.0.1:41234/health');
    expect(capturedCalls[1]?.authHeader).toBeNull();
  });

  it('handles 304 Not Modified and base64 round-trip cleanly', async () => {
    await apiUrlItem.setValue('http://127.0.0.1:9090');
    await authTokenItem.setValue('tok');

    const mockFetch = vi.fn(
      async () => new Response(null, { status: 304, statusText: 'Not Modified' }),
    ) as unknown as typeof fetch;
    const reply = await handleApiProxyMessage(
      {
        type: 'API_PROXY_REQUEST',
        url: '/api/selectors',
        method: 'GET',
        headers: { 'If-None-Match': '"abc"' },
      },
      { fetchImpl: mockFetch },
    );

    expect(reply.status).toBe(304);
    expect(reply.bodyBase64).toBe('');
  });

  it('rejects empty senderUrl on sender.tab, missing sender.id, and foreign moz-extension tabs', () => {
    const extId = 'abcdefghijklmnop';

    // Empty/missing senderUrl when sender.tab is defined MUST be rejected
    expect(
      isRuntimeSenderAuthorized('API_PROXY_REQUEST', { id: extId, tab: { id: 99 } }, extId),
    ).toBe(false);
    expect(
      isRuntimeSenderAuthorized(
        'PASSIVE_TAP_PAYLOAD',
        { id: extId, url: '', origin: '', tab: { id: 99, url: '' } },
        extId,
      ),
    ).toBe(false);

    // Missing sender.id when runtimeId is known MUST be rejected even without sender.tab
    expect(isRuntimeSenderAuthorized('TRIGGER_KILL_SWITCH', {}, extId)).toBe(false);
    expect(
      isRuntimeSenderAuthorized(
        'TRIGGER_KILL_SWITCH',
        {
          url: 'moz-extension://evil-uuid/evil.html',
          tab: { id: 42, url: 'moz-extension://evil-uuid/evil.html' },
        },
        extId,
      ),
    ).toBe(false);
  });

  it('scopes content-script API_PROXY_REQUEST strictly to Shadow DOM toolbar endpoints', () => {
    const base = 'http://127.0.0.1:45678';

    // Allowed Shadow DOM toolbar routes
    expect(isContentScriptProxyAllowed('GET', '/api/profile', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/profile', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/analyze-job', base)).toBe(true);
    expect(isContentScriptProxyAllowed('GET', '/api/jobs', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/jobs', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/jobs/42/analyze', base)).toBe(true);
    expect(isContentScriptProxyAllowed('DELETE', '/api/jobs/42', base)).toBe(true);
    expect(isContentScriptProxyAllowed('GET', '/api/templates', base)).toBe(true);
    expect(isContentScriptProxyAllowed('GET', '/api/templates/golang', base)).toBe(true);
    expect(isContentScriptProxyAllowed('GET', '/api/agents', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/agents/generate', base)).toBe(true);
    expect(isContentScriptProxyAllowed('POST', '/api/agents/download', base)).toBe(true);

    // Blocked privileged/mutating routes from content script
    expect(isContentScriptProxyAllowed('PUT', '/api/policy', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/policy/kill-switch', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/proposals/1/approve', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/proposals/1/submit', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/messages/1/approve', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/messages/send', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/jobs/search', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/jobs/detail', base)).toBe(false);
    expect(isContentScriptProxyAllowed('GET', '/api/jobs/42/analyze', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/api/jobs/abc/analyze', base)).toBe(false);
    expect(isContentScriptProxyAllowed('POST', '/mcp', base)).toBe(false);
    expect(isContentScriptProxyAllowed('DELETE', '/api/jobs/batch', base)).toBe(false);

    // Reject dot-segment / encoded-slash path traversal attempts on /api/templates/*
    expect(isContentScriptProxyAllowed('GET', '/api/templates/..%2fpolicy', base)).toBe(false);
    expect(isContentScriptProxyAllowed('GET', '/api/templates/%2e%2e', base)).toBe(false);
    expect(isContentScriptProxyAllowed('GET', '/api/templates/%2e', base)).toBe(false);
    expect(isContentScriptProxyAllowed('GET', '/api/templates/%ZZ', base)).toBe(false);
  });

  it('syncs killSwitchActive and policyMode from /api/session/status and PUT/POST /api/policy responses', () => {
    const base = 'http://127.0.0.1:45678';
    let policyMode = 'draft_only';
    let killSwitchActive = true;

    const applyPatch = (patch: ReturnType<typeof parsePolicyStateFromJson>) => {
      if (patch?.policyMode !== undefined) {
        policyMode = patch.policyMode;
      }
      if (patch?.killSwitchActive !== undefined) {
        killSwitchActive = patch.killSwitchActive;
      }
    };

    // 1. PUT /api/policy recovery clears killSwitchActive and restores policyMode
    const putBody = Buffer.from(
      JSON.stringify({ mode: 'confirm_in_ui', kill_switch_active: false }),
    ).toString('base64');
    applyPatch(
      extractPolicyPatchFromProxyResponse(
        { method: 'PUT', url: '/api/policy' },
        { ok: true, bodyBase64: putBody },
        base,
      ),
    );
    expect(policyMode).toBe('confirm_in_ui');
    expect(killSwitchActive).toBe(false);

    // 2. Kill switch activation sets killSwitchActive = true and draft_only
    const ksBody = Buffer.from(
      JSON.stringify({ mode: 'draft_only', kill_switch_active: true }),
    ).toString('base64');
    applyPatch(
      extractPolicyPatchFromProxyResponse(
        { method: 'POST', url: '/api/policy/kill-switch' },
        { ok: true, bodyBase64: ksBody },
        base,
      ),
    );
    expect(policyMode).toBe('draft_only');
    expect(killSwitchActive).toBe(true);

    // 3. GET /api/session/status recovery clears killSwitchActive and restores policyMode
    applyPatch(
      parsePolicyStateFromJson({
        policy_mode: 'auto_with_guardrails',
        kill_switch_active: false,
      }),
    );
    expect(policyMode).toBe('auto_with_guardrails');
    expect(killSwitchActive).toBe(false);
  });
});
