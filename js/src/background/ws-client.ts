import { browser } from 'wxt/browser';
import {
  type BadgeConnectionState,
  type BridgeErrorCode,
  type ChallengeType,
  type JsonRpcId,
  WsAuthRequestSchema,
  WsAuthSuccessResponseSchema,
  WsPongSchema,
  WsRpcRequestSchema,
  WsTaskProgressSchema,
} from '../shared/protocol';
import { DEFAULT_API_URL } from '../shared/schemas';
import { normalizeBaseApiUrl } from './api-proxy';

export const HEARTBEAT_INTERVAL_MS = 20_000;
export const AUTH_ACK_TIMEOUT_MS = 5_000;
export const WATCHDOG_ALARM_NAME = 'upwork-buddy-ws-watchdog';
export const WS_CLOSE_UNAUTHORIZED = 4001;

export class HumanActionRequiredError extends Error {
  readonly code = 'HUMAN_ACTION_REQUIRED' as const;
  readonly challengeType: ChallengeType;
  readonly url?: string;

  constructor(message: string, challengeType: ChallengeType = 'unknown', url?: string) {
    super(message);
    this.name = 'HumanActionRequiredError';
    this.challengeType = challengeType;
    this.url = url;
  }
}

export class TaskAbortedError extends Error {
  readonly code = 'ABORTED' as const;

  constructor(message = 'Task aborted by kill switch') {
    super(message);
    this.name = 'TaskAbortedError';
  }
}

export class BridgeRpcError extends Error {
  readonly code: BridgeErrorCode;
  readonly rpcCode: number;

  constructor(code: BridgeErrorCode, message: string, rpcCode = -32000) {
    super(message);
    this.name = 'BridgeRpcError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface RpcHandlerContext {
  requestId: string;
  sendProgress: (stage: string, current: number, total: number, message?: string) => void;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  ctx: RpcHandlerContext,
) => Promise<Record<string, unknown>>;

export interface WsClientStateDetail {
  sessionId?: string | null;
  lastError?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface WsClientOptions {
  WebSocketImpl?: WebSocketConstructor;
  getConfig: () => Promise<{ apiUrl: string; token: string }>;
  onStateChange?: (state: BadgeConnectionState, detail: WsClientStateDetail) => void;
  getHeartbeatParams?: () => Promise<{ upwork_logged_in?: boolean }>;
  extensionVersion?: string;
  browserName?: string;
  randomFn?: () => number;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

export function deriveWsUrl(apiUrl: string): string {
  const normalized = normalizeBaseApiUrl(apiUrl || DEFAULT_API_URL);
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/extension';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function computeBackoffMs(attempt: number, randomFn: () => number = Math.random): number {
  const baseMs = 1000;
  const maxMs = 30_000;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + randomFn() * 0.4;
  return Math.round(exp * jitter);
}

export class ExtensionWsClient {
  private readonly WebSocketImpl: WebSocketConstructor | undefined;
  private readonly getConfig: WsClientOptions['getConfig'];
  private readonly onStateChange?: WsClientOptions['onStateChange'];
  private readonly getHeartbeatParams?: WsClientOptions['getHeartbeatParams'];
  private readonly extensionVersion: string;
  private readonly browserName: string;
  private readonly randomFn: () => number;

  private readonly handlers = new Map<string, RpcHandler>();
  private ws: WebSocketLike | null = null;
  private state: BadgeConnectionState = 'disconnected';
  private sessionId: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastError: string | null = null;
  private authenticated = false;
  private authHalted = false;
  private disposed = false;
  private attempt = 0;
  private connectInFlight = false;
  private pendingReconnect = false;

  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsClientOptions) {
    this.WebSocketImpl =
      options.WebSocketImpl ??
      (globalThis.WebSocket as unknown as WebSocketConstructor | undefined);
    this.getConfig = options.getConfig;
    this.onStateChange = options.onStateChange;
    this.getHeartbeatParams = options.getHeartbeatParams;
    this.extensionVersion = options.extensionVersion ?? '2.0.0';
    this.browserName = options.browserName ?? 'chrome';
    this.randomFn = options.randomFn ?? Math.random;
  }

  registerMethod(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  getState(): {
    state: BadgeConnectionState;
    connected: boolean;
    sessionId: string | null;
    lastHeartbeatAt: string | null;
    lastError: string | null;
  } {
    return {
      state: this.state,
      connected: this.authenticated && this.ws?.readyState === WS_OPEN,
      sessionId: this.sessionId,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
    };
  }

  async ensureWatchdogAlarm(): Promise<void> {
    try {
      const existing = await browser.alarms.get(WATCHDOG_ALARM_NAME);
      if (!existing) {
        await browser.alarms.create(WATCHDOG_ALARM_NAME, { periodInMinutes: 1 });
      }
    } catch {
      // alarms API unavailable in restricted contexts
    }
  }

  async handleAlarm(alarm: { name?: string }): Promise<void> {
    if (alarm.name !== WATCHDOG_ALARM_NAME || this.disposed || this.authHalted) {
      return;
    }
    const ready = this.ws?.readyState;
    if (ready !== WS_OPEN && ready !== WS_CONNECTING) {
      await this.connect();
    }
  }

  async reconnectNow(): Promise<void> {
    this.authHalted = false;
    this.attempt = 0;
    this.clearReconnectTimer();
    this.teardownSocket(1000, 'Reconnecting');
    if (this.connectInFlight) {
      this.pendingReconnect = true;
      return;
    }
    await this.connect();
  }

  async connect(): Promise<void> {
    if (this.disposed || this.connectInFlight) {
      return;
    }
    if (!this.WebSocketImpl) {
      this.setState('disconnected', { lastError: 'WebSocket API unavailable' });
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WS_OPEN ||
        this.ws.readyState === WS_CONNECTING ||
        this.ws.readyState === WS_CLOSING)
    ) {
      return;
    }

    this.connectInFlight = true;
    try {
      const { apiUrl, token } = await this.getConfig();
      if (this.disposed || this.pendingReconnect) {
        return;
      }
      const trimmedToken = token.trim();
      if (!trimmedToken) {
        this.authHalted = true;
        this.setState('auth-required', {
          sessionId: null,
          lastError: 'API token not configured in Extension Options',
        });
        return;
      }

      const wsUrl = deriveWsUrl(apiUrl);
      const ws = new this.WebSocketImpl(wsUrl);
      this.ws = ws;
      this.authenticated = false;
      this.authHalted = false;

      ws.onopen = () => {
        if (this.ws !== ws || this.disposed) {
          return;
        }
        const authFrame = WsAuthRequestSchema.parse({
          jsonrpc: '2.0',
          id: 'auth-1',
          method: 'auth',
          params: {
            token: trimmedToken,
            extension_version: this.extensionVersion,
            browser: this.browserName,
          },
        });
        try {
          ws.send(JSON.stringify(authFrame));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.lastError = errMsg;
          ws.close(1011, errMsg);
          return;
        }

        this.clearAuthTimer();
        this.authTimer = setTimeout(() => {
          if (!this.authenticated && this.ws === ws) {
            this.lastError = 'Auth handshake timed out';
            ws.close(WS_CLOSE_UNAUTHORIZED, 'Auth timeout');
          }
        }, AUTH_ACK_TIMEOUT_MS);
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws || this.disposed) {
          return;
        }
        void this.handleMessage(ws, String(event.data));
      };

      ws.onerror = () => {
        if (this.ws === ws) {
          this.lastError = 'WebSocket connection error';
        }
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) {
          return;
        }
        this.clearTimers();
        this.ws = null;
        this.authenticated = false;
        this.sessionId = null;

        if (this.disposed) {
          return;
        }

        if (event.code === WS_CLOSE_UNAUTHORIZED) {
          this.authHalted = true;
          this.setState('auth-required', {
            sessionId: null,
            lastError: event.reason || 'Unauthorized (4001)',
          });
          return;
        }

        this.setState('disconnected', {
          sessionId: null,
          lastError: event.reason || `Closed (${event.code})`,
        });
        this.scheduleReconnect();
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setState('disconnected', { sessionId: null, lastError: msg });
      this.scheduleReconnect();
    } finally {
      this.connectInFlight = false;
      if (this.pendingReconnect && !this.disposed) {
        this.pendingReconnect = false;
        await this.connect();
      }
    }
  }

  sendProgress(params: {
    request_id: string;
    stage: string;
    current: number;
    total: number;
    message?: string;
  }): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN || !this.authenticated) {
      return;
    }
    const payload = WsTaskProgressSchema.parse({
      jsonrpc: '2.0',
      method: 'task.progress',
      params,
    });
    this.ws.send(JSON.stringify(payload));
  }

  dispose(): void {
    this.disposed = true;
    this.pendingReconnect = false;
    this.clearReconnectTimer();
    this.teardownSocket(1000, 'Disposed');
  }

  private async handleMessage(ws: WebSocketLike, raw: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.authenticated) {
      const authRes = WsAuthSuccessResponseSchema.safeParse(parsedJson);
      if (authRes.success && authRes.data.id === 'auth-1') {
        this.clearAuthTimer();
        this.authenticated = true;
        this.attempt = 0;
        this.sessionId = authRes.data.result.session_id;
        this.lastHeartbeatAt = new Date().toISOString();
        this.lastError = null;
        this.setState('connected', {
          sessionId: this.sessionId,
          lastHeartbeatAt: this.lastHeartbeatAt,
          lastError: null,
        });
        this.startHeartbeat(ws);
        return;
      }

      if (
        typeof parsedJson === 'object' &&
        parsedJson !== null &&
        'error' in parsedJson &&
        (parsedJson as { id?: unknown }).id === 'auth-1'
      ) {
        this.authHalted = true;
        this.setState('auth-required', { sessionId: null, lastError: 'Auth rejected' });
        ws.close(WS_CLOSE_UNAUTHORIZED, 'Auth rejected');
      }
      return;
    }

    // Check pong frames
    const pongCheck = WsPongSchema.safeParse(parsedJson);
    if (
      pongCheck.success &&
      (pongCheck.data.method === 'pong' || pongCheck.data.result?.pong === true)
    ) {
      this.lastHeartbeatAt = new Date().toISOString();
      this.onStateChange?.(this.state, {
        sessionId: this.sessionId,
        lastHeartbeatAt: this.lastHeartbeatAt,
        lastError: this.lastError,
      });
      return;
    }

    // Check RPC request frames
    const rpcReq = WsRpcRequestSchema.safeParse(parsedJson);
    if (!rpcReq.success) {
      return;
    }

    const { id, method, params, timeout_ms: timeoutMs } = rpcReq.data;
    const handler = this.handlers.get(method);
    if (!handler) {
      this.sendRpcError(ws, id, -32601, `Method not found: ${method}`);
      return;
    }

    const requestIdStr = String(id);
    const ctx: RpcHandlerContext = {
      requestId: requestIdStr,
      sendProgress: (stage, current, total, message) => {
        this.sendProgress({ request_id: requestIdStr, stage, current, total, message });
      },
    };

    let rpcTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const execPromise = handler(params ?? {}, ctx);
      const result =
        timeoutMs && timeoutMs > 0
          ? await Promise.race([
              execPromise,
              new Promise<never>((_, reject) => {
                rpcTimer = setTimeout(
                  () => reject(new BridgeRpcError('TIMEOUT', `RPC ${method} timed out`, -32004)),
                  timeoutMs,
                );
              }),
            ])
          : await execPromise;

      if (this.ws === ws && ws.readyState === WS_OPEN) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result,
          }),
        );
      }
    } catch (error) {
      if (this.ws !== ws || ws.readyState !== WS_OPEN) {
        return;
      }
      if (error instanceof HumanActionRequiredError) {
        this.sendRpcError(ws, id, -32001, error.message, {
          error_code: 'HUMAN_ACTION_REQUIRED',
          details: {
            challenge_type: error.challengeType,
            ...(error.url ? { url: error.url } : {}),
          },
        });
        return;
      }
      if (error instanceof TaskAbortedError) {
        this.sendRpcError(ws, id, -32002, error.message, {
          error_code: 'ABORTED',
        });
        return;
      }
      if (error instanceof BridgeRpcError) {
        this.sendRpcError(ws, id, error.rpcCode, error.message, {
          error_code: error.code,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.sendRpcError(ws, id, -32603, message, {
        error_code: 'INTERNAL_ERROR',
      });
    } finally {
      if (rpcTimer !== null) {
        clearTimeout(rpcTimer);
        rpcTimer = null;
      }
    }
  }

  private sendRpcError(
    ws: WebSocketLike,
    id: JsonRpcId,
    code: number,
    message: string,
    data?: { error_code?: BridgeErrorCode; details?: Record<string, unknown> },
  ): void {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message,
          ...(data ? { data } : {}),
        },
      }),
    );
  }

  private startHeartbeat(ws: WebSocketLike): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WS_OPEN || !this.authenticated) {
        return;
      }
      void this.sendPing(ws);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async sendPing(ws: WebSocketLike): Promise<void> {
    let params: { upwork_logged_in?: boolean } | undefined;
    if (this.getHeartbeatParams) {
      try {
        params = await this.getHeartbeatParams();
      } catch {
        // ignore probe error
      }
    }
    if (this.ws !== ws || ws.readyState !== WS_OPEN || !this.authenticated) {
      return;
    }
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'ping',
        ...(params ? { params } : {}),
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.authHalted || this.reconnectTimer) {
      return;
    }
    const delayMs = computeBackoffMs(this.attempt, this.randomFn);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private setState(state: BadgeConnectionState, detail: WsClientStateDetail): void {
    this.state = state;
    if (detail.sessionId !== undefined) {
      this.sessionId = detail.sessionId;
    }
    if (detail.lastHeartbeatAt !== undefined) {
      this.lastHeartbeatAt = detail.lastHeartbeatAt;
    }
    if (detail.lastError !== undefined) {
      this.lastError = detail.lastError;
    }
    this.onStateChange?.(state, {
      sessionId: this.sessionId,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
    });
  }

  private teardownSocket(code: number, reason: string): void {
    this.clearTimers();
    if (this.ws) {
      const prev = this.ws;
      this.ws = null;
      this.authenticated = false;
      this.sessionId = null;
      try {
        prev.close(code, reason);
      } catch {
        // ignore close error
      }
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearAuthTimer();
    this.clearHeartbeatTimer();
  }
}
