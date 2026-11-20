import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrlItem, authTokenItem } from '../shared/storage-items';
import { BadgeManager, NativeLauncher, type NativePortLike } from './native-launcher';

function createMockPort(replyPayload: Record<string, unknown>): NativePortLike {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];

  return {
    postMessage: vi.fn(() => {
      setTimeout(() => {
        for (const cb of messageListeners) {
          cb(replyPayload);
        }
      }, 0);
    }),
    disconnect: vi.fn(() => {
      for (const cb of disconnectListeners) {
        cb();
      }
    }),
    onMessage: {
      addListener: (cb) => {
        messageListeners.push(cb);
      },
    },
    onDisconnect: {
      addListener: (cb) => {
        disconnectListeners.push(cb);
      },
    },
  };
}

describe('NativeLauncher & BadgeManager', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('falls back gracefully when connectNative is unavailable', async () => {
    const launcher = new NativeLauncher({ connectNative: undefined });
    const res = await launcher.sendCommand('ping');
    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
    expect(res.error).toContain('unavailable');
  });

  it('executes ping, status, start_daemon, and bootstraps token/url into local storage', async () => {
    const port = createMockPort({
      ok: true,
      action: 'get_token',
      token: 'bootstrapped-token-999',
      daemon_url: 'http://127.0.0.1:9090',
    });
    const launcher = new NativeLauncher({
      connectNative: () => port,
    });

    const res = await launcher.sendCommand('get_token');
    expect(res.ok).toBe(true);
    expect(res.available).toBe(true);
    expect(res.token).toBe('bootstrapped-token-999');

    expect(await authTokenItem.getValue()).toBe('bootstrapped-token-999');
    expect(await apiUrlItem.getValue()).toBe('http://127.0.0.1:9090');
  });

  it('updates extension badge state cleanly', async () => {
    const badge = new BadgeManager();
    const setBadgeText = vi.spyOn(fakeBrowser.action, 'setBadgeText');

    await badge.setConnectionState('connected');
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '' });

    await badge.setPendingApprovals(3);
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '3' });

    await badge.setConnectionState('auth-required');
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '!' });
  });
});
