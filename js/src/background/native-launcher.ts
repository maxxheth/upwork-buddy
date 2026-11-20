import { browser } from 'wxt/browser';
import type { BadgeConnectionState } from '../shared/protocol';
import { apiUrlItem, authTokenItem } from '../shared/storage-items';

export const NATIVE_HOST_NAME = 'com.upworkbuddy.host';

export type NativeCommand = 'ping' | 'status' | 'start_daemon' | 'get_token';

export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
  };
}

export interface NativeHostResult {
  ok: boolean;
  available: boolean;
  action?: string;
  pong?: boolean;
  version?: string;
  daemon_running?: boolean;
  already_running?: boolean;
  started?: boolean;
  pid?: number;
  daemon_url?: string;
  api_url?: string;
  token?: string;
  token_source?: string;
  error?: string;
}

export interface NativeLauncherOptions {
  connectNative?: (name: string) => NativePortLike;
  timeoutMs?: number;
}

export class NativeLauncher {
  private readonly connectNative?: (name: string) => NativePortLike;
  private readonly timeoutMs: number;

  constructor(options: NativeLauncherOptions = {}) {
    if ('connectNative' in options) {
      this.connectNative = options.connectNative;
    } else if (
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.connectNative === 'function'
    ) {
      this.connectNative = (name) =>
        chrome.runtime.connectNative(name) as unknown as NativePortLike;
    }
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async sendCommand(command: NativeCommand): Promise<NativeHostResult> {
    if (!this.connectNative) {
      return {
        ok: false,
        available: false,
        action: command,
        error: 'Native messaging unavailable in this browser runtime',
      };
    }

    let port: NativePortLike;
    try {
      port = this.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const friendly = msg.includes('not implemented')
        ? 'Native messaging unavailable in this browser runtime'
        : msg;
      return {
        ok: false,
        available: false,
        action: command,
        error: friendly,
      };
    }

    const result = await new Promise<NativeHostResult>((resolve) => {
      let settled = false;
      const finish = (res: NativeHostResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // ignore
        }
        resolve(res);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          available: true,
          action: command,
          error: `Native host ${command} timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      port.onMessage.addListener((raw) => {
        if (typeof raw !== 'object' || raw === null) {
          finish({
            ok: false,
            available: true,
            action: command,
            error: 'Invalid native host response',
          });
          return;
        }
        const msg = raw as Record<string, unknown>;
        finish({
          ok: Boolean(msg.ok),
          available: true,
          action: typeof msg.action === 'string' ? msg.action : command,
          pong: typeof msg.pong === 'boolean' ? msg.pong : undefined,
          version: typeof msg.version === 'string' ? msg.version : undefined,
          daemon_running: typeof msg.daemon_running === 'boolean' ? msg.daemon_running : undefined,
          already_running:
            typeof msg.already_running === 'boolean' ? msg.already_running : undefined,
          started: typeof msg.started === 'boolean' ? msg.started : undefined,
          pid: typeof msg.pid === 'number' ? msg.pid : undefined,
          daemon_url: typeof msg.daemon_url === 'string' ? msg.daemon_url : undefined,
          api_url: typeof msg.api_url === 'string' ? msg.api_url : undefined,
          token: typeof msg.token === 'string' ? msg.token : undefined,
          token_source: typeof msg.token_source === 'string' ? msg.token_source : undefined,
          error: typeof msg.error === 'string' ? msg.error : undefined,
        });
      });

      port.onDisconnect.addListener(() => {
        const lastError =
          typeof chrome !== 'undefined' ? chrome.runtime?.lastError?.message : undefined;
        finish({
          ok: false,
          available: false,
          action: command,
          error: lastError ?? 'Native host disconnected',
        });
      });

      try {
        port.postMessage({ action: command, command });
      } catch (err) {
        finish({
          ok: false,
          available: false,
          action: command,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    if (result.ok) {
      const targetUrl = result.daemon_url ?? result.api_url;
      if (targetUrl) {
        const existingUrl = await apiUrlItem.getValue().catch(() => '');
        if (!existingUrl) {
          await apiUrlItem.setValue(targetUrl).catch(() => undefined);
        }
      }
      if (result.token) {
        const existingToken = await authTokenItem.getValue().catch(() => '');
        if (!existingToken) {
          await authTokenItem.setValue(result.token).catch(() => undefined);
        }
      }
    }

    return result;
  }
}

export class BadgeManager {
  private connectionState: BadgeConnectionState = 'disconnected';
  private pendingApprovals = 0;
  private unreadMessages = 0;

  async setConnectionState(state: BadgeConnectionState): Promise<void> {
    this.connectionState = state;
    await this.render();
  }

  async setPendingApprovals(count: number): Promise<void> {
    this.pendingApprovals = Math.max(0, count);
    await this.render();
  }

  async setUnreadMessages(count: number): Promise<void> {
    this.unreadMessages = Math.max(0, count);
    await this.render();
  }

  getSnapshot(): {
    connectionState: BadgeConnectionState;
    pendingApprovals: number;
    unreadMessages: number;
  } {
    return {
      connectionState: this.connectionState,
      pendingApprovals: this.pendingApprovals,
      unreadMessages: this.unreadMessages,
    };
  }

  private async render(): Promise<void> {
    const actionApi =
      browser.action ??
      (browser as unknown as { browserAction?: typeof browser.action }).browserAction;
    if (!actionApi) {
      return;
    }

    let text = 'OFF';
    let color = '#6b7280';
    let title = 'Upwork Buddy — Disconnected';

    if (this.connectionState === 'auth-required') {
      text = '!';
      color = '#dc2626';
      title = 'Upwork Buddy — Action / Auth Required';
    } else if (this.pendingApprovals > 0 || this.connectionState === 'pending-approval') {
      text = String(this.pendingApprovals > 0 ? this.pendingApprovals : '!');
      color = '#d97706';
      title = `Upwork Buddy — ${this.pendingApprovals} pending approval(s)${this.unreadMessages > 0 ? `, ${this.unreadMessages} unread` : ''}`;
    } else if (this.connectionState === 'connected') {
      text = this.unreadMessages > 0 ? `M${this.unreadMessages}` : '';
      color = this.unreadMessages > 0 ? '#108ee9' : '#14a800';
      title =
        this.unreadMessages > 0
          ? `Upwork Buddy — Connected (${this.unreadMessages} unread message(s))`
          : 'Upwork Buddy — Connected';
    }

    await Promise.all([
      actionApi.setBadgeText?.({ text }).catch(() => undefined),
      actionApi.setBadgeBackgroundColor?.({ color }).catch(() => undefined),
      actionApi.setTitle?.({ title }).catch(() => undefined),
    ]);
  }
}
