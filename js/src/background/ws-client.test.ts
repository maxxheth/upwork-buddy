import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BadgeConnectionState } from '../shared/protocol';
import {
  computeBackoffMs,
  deriveWsUrl,
  ExtensionWsClient,
  HEARTBEAT_INTERVAL_MS,
  WATCHDOG_ALARM_NAME,
  type WebSocketLike,
  WS_CLOSE_UNAUTHORIZED,
} from './ws-client';

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
}

describe('Background WS Client', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives ws(s) URLs cleanly and computes bounded exponential backoff', () => {
    expect(deriveWsUrl('http://127.0.0.1:9090')).toBe('ws://127.0.0.1:9090/ws/extension');
    expect(deriveWsUrl('https://127.0.0.1:9443/api')).toBe('wss://127.0.0.1:9443/ws/extension');
    expect(computeBackoffMs(0, () => 0)).toBe(800);
    expect(computeBackoffMs(10, () => 1)).toBe(36_000);
  });

  it('performs first-frame auth handshake, 20s heartbeat ping, and RPC round-trip', async () => {
    const states: BadgeConnectionState[] = [];
    const client = new ExtensionWsClient({
      WebSocketImpl: MockWebSocket,
      getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok-abc' }),
      onStateChange: (s) => states.push(s),
    });

    client.registerMethod('session.status', async () => ({
      ok: true,
      extension_connected: true,
    }));

    await client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:9090/ws/extension');

    ws.simulateOpen();
    expect(ws.sent).toHaveLength(1);
    const authReq = JSON.parse(ws.sent[0]) as { method: string; params: { token: string } };
    expect(authReq.method).toBe('auth');
    expect(authReq.params.token).toBe('tok-abc');

    ws.simulateMessage({
      jsonrpc: '2.0',
      id: 'auth-1',
      result: { ok: true, session_id: 'ext-sess-1' },
    });
    expect(states).toContain('connected');
    expect(client.getState().sessionId).toBe('ext-sess-1');

    // Verify 20s heartbeat ping
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent.some((m) => m.includes('"method":"ping"'))).toBe(true);

    // Verify RPC call round-trip
    ws.simulateMessage({
      jsonrpc: '2.0',
      id: 'rpc-77',
      method: 'session.status',
      params: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    const rpcReply = ws.sent.find((m) => m.includes('"id":"rpc-77"'));
    expect(rpcReply).toBeDefined();
    expect(JSON.parse(rpcReply ?? '{}').result.extension_connected).toBe(true);

    client.dispose();
  });

  it('halts reconnects on 4001 Unauthorized until reconnectNow and revives via 1m watchdog alarm', async () => {
    let token = 'bad-token';
    const states: BadgeConnectionState[] = [];
    const client = new ExtensionWsClient({
      WebSocketImpl: MockWebSocket,
      getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token }),
      onStateChange: (s) => states.push(s),
    });

    await client.ensureWatchdogAlarm();
    await client.connect();

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.close(WS_CLOSE_UNAUTHORIZED, 'Unauthorized');

    expect(states.at(-1)).toBe('auth-required');

    // Advance timers + fire watchdog alarm: should NOT reconnect while auth-halted
    await vi.advanceTimersByTimeAsync(60_000);
    await client.handleAlarm({ name: WATCHDOG_ALARM_NAME });
    expect(MockWebSocket.instances).toHaveLength(1);

    // Update token and reconnectNow()
    token = 'good-token';
    await client.reconnectNow();
    expect(MockWebSocket.instances).toHaveLength(2);

    // Simulate clean network drop (not 4001): watchdog alarm revives connection
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();
    ws2.simulateMessage({
      jsonrpc: '2.0',
      id: 'auth-1',
      result: { ok: true, session_id: 'ext-sess-2' },
    });
    ws2.close(1006, 'Network dropped');

    await client.handleAlarm({ name: WATCHDOG_ALARM_NAME });
    expect(MockWebSocket.instances).toHaveLength(3);

    client.dispose();
  });

  it('queues pendingReconnect when reconnectNow is called while connect is awaiting getConfig', async () => {
    let resolveFirstConfig!: (val: { apiUrl: string; token: string }) => void;
    let callCount = 0;
    const client = new ExtensionWsClient({
      WebSocketImpl: MockWebSocket,
      getConfig: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirstConfig = resolve;
          });
        }
        return Promise.resolve({ apiUrl: 'http://127.0.0.1:9090', token: 'fresh-token' });
      },
    });

    const pConnect = client.connect();
    const pReconnect = client.reconnectNow();
    resolveFirstConfig({ apiUrl: 'http://127.0.0.1:9090', token: 'stale-token' });

    await Promise.all([pConnect, pReconnect]);
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const authReq = JSON.parse(ws.sent[0]) as { params: { token: string } };
    expect(authReq.params.token).toBe('fresh-token');

    client.dispose();
  });

  it('clears RPC timeout timer upon completion and handles ws.send failure in onopen', async () => {
    vi.useFakeTimers();
    try {
      const client = new ExtensionWsClient({
        WebSocketImpl: MockWebSocket,
        getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok' }),
      });
      client.registerMethod('fast.op', async () => ({ ok: true }));

      await client.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.simulateOpen();
      ws.simulateMessage({
        jsonrpc: '2.0',
        id: 'auth-1',
        result: { ok: true, session_id: 'sess-timer' },
      });

      const beforeTimers = vi.getTimerCount();
      ws.simulateMessage({
        jsonrpc: '2.0',
        id: 'rpc-fast-1',
        method: 'fast.op',
        params: {},
        timeout_ms: 60_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(beforeTimers);
      client.dispose();

      // ws.send throwing during onopen must close cleanly rather than throw unhandled
      class ThrowingOpenWebSocket extends MockWebSocket {
        override send(_data: string): void {
          throw new Error('socket write failed');
        }
      }
      const errClient = new ExtensionWsClient({
        WebSocketImpl: ThrowingOpenWebSocket,
        getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok' }),
      });
      await errClient.connect();
      const errWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      expect(() => errWs.simulateOpen()).not.toThrow();
      expect(errClient.getState().lastError).toContain('socket write failed');
      errClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches WsNotification frames without id, swallows handler errors, and ignores unregistered notifications without RPC errors', async () => {
    const receivedAlerts: Array<Record<string, unknown>> = [];
    const client = new ExtensionWsClient({
      WebSocketImpl: MockWebSocket,
      getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok-notif' }),
    });

    client.registerNotification('watch.alert', async (params) => {
      receivedAlerts.push(params);
    });
    client.registerNotification('broken.notice', async () => {
      throw new Error('notification handler boom');
    });

    await client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({
      jsonrpc: '2.0',
      id: 'auth-1',
      result: { ok: true, session_id: 'sess-notif' },
    });
    const sentCountAfterAuth = ws.sent.length;

    // Registered notification without id
    ws.simulateMessage({
      jsonrpc: '2.0',
      method: 'watch.alert',
      params: { event: 'match', pending_approvals: 2 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedAlerts).toEqual([{ event: 'match', pending_approvals: 2 }]);
    expect(ws.sent).toHaveLength(sentCountAfterAuth);

    // Unregistered notification without id must NOT emit an RPC -32601 error
    ws.simulateMessage({
      jsonrpc: '2.0',
      method: 'unregistered.notice',
      params: { foo: 'bar' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent).toHaveLength(sentCountAfterAuth);

    // Failing notification handler must be swallowed safely
    ws.simulateMessage({
      jsonrpc: '2.0',
      method: 'broken.notice',
      params: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent).toHaveLength(sentCountAfterAuth);

    client.dispose();
  });

  it('sendNotification enforces connection/auth state, non-blank method, and socket error safety', async () => {
    const client = new ExtensionWsClient({
      WebSocketImpl: MockWebSocket,
      getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok-out' }),
    });

    // Disconnected -> false
    expect(client.sendNotification('search.observed', { jobs: [] })).toBe(false);

    await client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // WS_OPEN but before auth-1 ack -> false
    expect(client.sendNotification('search.observed', { jobs: [] })).toBe(false);

    ws.simulateMessage({
      jsonrpc: '2.0',
      id: 'auth-1',
      result: { ok: true, session_id: 'sess-out' },
    });

    // Blank method -> false
    expect(client.sendNotification('   ', { jobs: [] })).toBe(false);

    // Authenticated + valid method -> true, sends JSON-RPC 2.0 notification (no id)
    const sentBefore = ws.sent.length;
    expect(
      client.sendNotification('search.observed', {
        page_url: 'https://www.upwork.com/nx/search/jobs/?q=go',
        source_feed: 'search',
        jobs: [{ upwork_job_id: '~0111' }],
      }),
    ).toBe(true);
    expect(ws.sent).toHaveLength(sentBefore + 1);
    const frame = JSON.parse(ws.sent[sentBefore] ?? '{}') as Record<string, unknown>;
    expect(frame).toEqual({
      jsonrpc: '2.0',
      method: 'search.observed',
      params: {
        page_url: 'https://www.upwork.com/nx/search/jobs/?q=go',
        source_feed: 'search',
        jobs: [{ upwork_job_id: '~0111' }],
      },
    });
    expect('id' in frame).toBe(false);

    // Socket close -> false
    ws.close(1000, 'bye');
    expect(client.sendNotification('search.observed', { jobs: [] })).toBe(false);

    // Throwing ws.send -> false
    class ThrowingAfterAuthSocket extends MockWebSocket {
      throwNext = false;
      override send(data: string): void {
        if (this.throwNext) {
          throw new Error('send boom');
        }
        super.send(data);
      }
    }
    const errClient = new ExtensionWsClient({
      WebSocketImpl: ThrowingAfterAuthSocket,
      getConfig: async () => ({ apiUrl: 'http://127.0.0.1:9090', token: 'tok-err' }),
    });
    await errClient.connect();
    const errWs = MockWebSocket.instances[
      MockWebSocket.instances.length - 1
    ] as ThrowingAfterAuthSocket;
    errWs.simulateOpen();
    errWs.simulateMessage({
      jsonrpc: '2.0',
      id: 'auth-1',
      result: { ok: true, session_id: 'sess-err' },
    });
    errWs.throwNext = true;
    expect(errClient.sendNotification('search.observed', { jobs: [] })).toBe(false);

    client.dispose();
    errClient.dispose();
  });
});
