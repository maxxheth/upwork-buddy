import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { waitForExtensionConnected } from '../helpers/pairing.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

function waitForWsClose(
  ws: WebSocket,
  timeoutMs = 8_000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket close after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('close', (evt) => {
      clearTimeout(timer);
      resolve({ code: evt.code, reason: evt.reason });
    });
    ws.addEventListener('error', () => {
      // Wait for close event carrying close code.
    });
  });
}

function waitForWsOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('Timed out opening WebSocket'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket failed to open'));
    });
  });
}

test.describe('Tier 2 F1 — Extension Shell, Auth, WS Bridge Boundary Cases', () => {
  test('T2-F1-01: invalid or missing Bearer token rejected (401 Unauthorized, zero secret leak)', async ({
    daemon,
  }) => {
    const targets: Array<{ method: string; path: string; body?: string }> = [
      { method: 'GET', path: '/api/jobs' },
      { method: 'GET', path: '/api/selectors' },
      { method: 'POST', path: '/api/proposals', body: '{}' },
      { method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' },
    ];

    const authHeaders = [undefined, 'Bearer wrong-token-value', 'Basic YWJj'];

    for (const target of targets) {
      for (const authHeader of authHeaders) {
        const headers: Record<string, string> = {};
        if (target.body) {
          headers['content-type'] = 'application/json';
        }
        if (authHeader) {
          headers.authorization = authHeader;
        }
        const res = await fetch(`${daemon.baseUrl}${target.path}`, {
          method: target.method,
          headers,
          body: target.body,
        });
        expect(res.status).toBe(401);
        const rawBody = await res.text();
        expect(rawBody).not.toContain(daemon.apiToken);
        const rawHeaders = JSON.stringify(Object.fromEntries(res.headers.entries()));
        expect(rawHeaders).not.toContain(daemon.apiToken);
      }
    }
  });

  test('T2-F1-02: WebSocket /ws/extension invalid token & missing auth frame timeout (4001)', async ({
    daemon,
  }) => {
    const wsInvalid = new WebSocket(daemon.wsUrl);
    await waitForWsOpen(wsInvalid);
    const invalidClosePromise = waitForWsClose(wsInvalid, 5_000);
    wsInvalid.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-auth-1',
        method: 'auth',
        params: { token: 'bad-token' },
      }),
    );
    const invalidClose = await invalidClosePromise;
    expect(invalidClose.code).toBe(4001);

    const wsSilent = new WebSocket(daemon.wsUrl);
    await waitForWsOpen(wsSilent);
    const startedAt = Date.now();
    const silentClose = await waitForWsClose(wsSilent, 7_500);
    const elapsedMs = Date.now() - startedAt;
    expect(silentClose.code).toBe(4001);
    expect(elapsedMs).toBeLessThanOrEqual(6_500);
  });

  test('T2-F1-03: disallowed CORS origins blocked while chrome-extension:// and moz-extension:// allowed', async ({
    extensionCtx,
    daemon,
  }) => {
    const blockedOrigins = ['https://evil.example.com', 'https://www.upwork.com'];
    for (const origin of blockedOrigins) {
      const preflight = await fetch(`${daemon.baseUrl}/api/jobs`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
        },
      });
      const acaoPreflight = preflight.headers.get('access-control-allow-origin');
      expect(acaoPreflight).not.toBe('*');
      expect(acaoPreflight).not.toBe(origin);

      const getRes = await daemon.apiFetch('/api/jobs', {
        headers: { origin },
      });
      const acaoGet = getRes.headers.get('access-control-allow-origin');
      expect(acaoGet).not.toBe('*');
      expect(acaoGet).not.toBe(origin);
    }

    const allowedOrigins = [
      `chrome-extension://${extensionCtx.extensionId}`,
      'moz-extension://1234-5678',
    ];
    for (const origin of allowedOrigins) {
      const preflight = await fetch(`${daemon.baseUrl}/api/jobs`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  test('T2-F1-04: malformed JSON & unknown JSON-RPC method over authenticated /ws/extension', async ({
    daemon,
  }) => {
    const ws = new WebSocket(daemon.wsUrl);
    await waitForWsOpen(ws);

    const messages: string[] = [];
    ws.addEventListener('message', (evt) => {
      messages.push(String(evt.data));
    });

    try {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'auth-1',
          method: 'auth',
          params: { token: daemon.apiToken, extension_version: '2.0.0', browser: 'chrome' },
        }),
      );

      await expect
        .poll(() => messages.some((m) => m.includes('"auth-1"')), { timeout: 5_000 })
        .toBe(true);

      ws.send('{broken-json');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'bad-method-1',
          method: 'does.not.exist',
        }),
      );
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }));

      await expect
        .poll(() => messages.some((m) => m.includes('pong')), { timeout: 5_000 })
        .toBe(true);

      const healthRes = await fetch(`${daemon.baseUrl}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      ws.close();
    }
  });

  test('T2-F1-05: extension WS disconnect triggers EXTENSION_DISCONNECTED & auto-reconnect recovers', async ({
    pairedExtension,
    daemon,
    createMcpHttpClient,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await daemon.stop();
    // Wait ~1,300 ms so WS attempt 0 (800-1200 ms) fails while daemon is down and advances to attempt 1 (1,600-2,400 ms).
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await daemon.start();
    await waitForExtensionConnected(daemon, false, 10_000);

    const freshMcp = await createMcpHttpClient();

    // While extension is disconnected after daemon restart, browser RPC fails cleanly.
    const downRes = await freshMcp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
    });
    expect(downRes.isError).toBe(true);
    const downJson = JSON.stringify(downRes);
    expect(downJson).toContain('EXTENSION_DISCONNECTED');

    // Extension exponential-backoff reconnect / watchdog re-establishes WS connection automatically.
    const reconnected = await waitForExtensionConnected(daemon, true, 25_000);
    expect(reconnected.extension_connected).toBe(true);

    const statusRes = await freshMcp.callTool('upwork_session_status', {});
    expect(statusRes.isError).not.toBe(true);
    const status = parseMcpToolJson<{ extension_connected: boolean }>(statusRes);
    expect(status.extension_connected).toBe(true);
  });

  test('T2-F1-06: POST /api/jobs malformed JSON vs flexible time_estimate & questions_for_client types', async ({
    daemon,
  }) => {
    const malformedRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformedRes.status).toBe(400);

    const stringFormRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Flexible String Job',
        job_description: 'Testing string variants.',
        url: 'https://www.upwork.com/jobs/~022188888888888801/',
        time_estimate: '3 weeks',
        workload_division: 'Solo engineer',
        questions_for_client: 'Any blockers?',
      }),
    });
    expect([200, 201]).toContain(stringFormRes.status);

    const objectFormRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Flexible Object Job',
        job_description: 'Testing object/array variants.',
        url: 'https://www.upwork.com/jobs/~022188888888888802/',
        time_estimate: { hours: 24 },
        workload_division: { phase1: 'Backend', phase2: 'QA' },
        questions_for_client: ['Q1?', 'Q2?'],
      }),
    });
    expect([200, 201]).toContain(objectFormRes.status);
  });
});
