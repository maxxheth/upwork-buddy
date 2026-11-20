import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationTabController,
  computeJitteredDelayMs,
  isChallengeOrLoginUrl,
} from './tab-controller';
import { type BridgeRpcError, HumanActionRequiredError, TaskAbortedError } from './ws-client';

describe('Automation Tab Controller', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('computes jittered pacing around 4.5s ± 50% by default and honors configured overrides', () => {
    expect(computeJitteredDelayMs(undefined, () => 0)).toBe(2250);
    expect(computeJitteredDelayMs(undefined, () => 1)).toBe(6750);
    expect(computeJitteredDelayMs(0.1, () => 0)).toBe(50);
    expect(computeJitteredDelayMs(0.1, () => 1)).toBe(150);
  });

  it('serializes concurrent tasks on one reused automation tab', async () => {
    const controller = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0.01, jitterRatio: 0 }),
    });

    const events: string[] = [];
    const p1 = controller.runSerialized('req-1', async () => {
      events.push('start-1');
      await controller.ensureAutomationTab('https://www.upwork.com/nx/search/jobs/?q=go');
      await new Promise((r) => setTimeout(r, 25));
      events.push('end-1');
      return 1;
    });

    const p2 = controller.runSerialized('req-2', async () => {
      events.push('start-2');
      await controller.ensureAutomationTab('https://www.upwork.com/jobs/~022115332344639171/');
      events.push('end-2');
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);

    const allTabs = await fakeBrowser.tabs.query({});
    const tabs = allTabs.filter((t) => (t.url ?? '').includes('upwork.com'));
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.active).toBe(false);
    expect(controller.getState().automationTabId).toBe(tabs[0]?.id);
  });

  it('aborts immediately with HUMAN_ACTION_REQUIRED on login or challenge without retries', async () => {
    const challenges: string[] = [];
    const messenger = vi.fn(async () => ({
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: 'captcha',
      reason: 'Cloudflare challenge iframe detected',
      url: 'https://www.upwork.com/nx/search/jobs/',
    }));

    const controller = new AutomationTabController({
      tabMessenger: messenger,
      onChallengeDetected: (d) => challenges.push(d.challengeType),
    });

    expect(isChallengeOrLoginUrl('https://www.upwork.com/ab/account-security/login').matched).toBe(
      true,
    );

    await expect(
      controller.navigateAndWaitForHydration('https://www.upwork.com/ab/account-security/login'),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
    expect(messenger).not.toHaveBeenCalled();

    // Create a completed tab so navigateAndWaitForHydration reaches tabMessenger
    const tab = await fakeBrowser.tabs.create({
      url: 'https://www.upwork.com/nx/search/jobs/',
      active: false,
    });
    if (tab.id === undefined) {
      throw new Error('Expected tab.id');
    }
    await fakeBrowser.tabs.update(tab.id, { status: 'complete' } as unknown as { url?: string });

    // Force controller to reuse that tab
    await controller.ensureAutomationTab('https://www.upwork.com/nx/search/jobs/');
    const autoTabId = controller.getState().automationTabId ?? tab.id;

    const navPromise = controller.navigateAndWaitForHydration(
      'https://www.upwork.com/nx/search/jobs/',
    );
    // Simulate tab completing load in fakeBrowser
    setTimeout(() => {
      void fakeBrowser.tabs.onUpdated.trigger(
        autoTabId,
        { status: 'complete', url: 'https://www.upwork.com/nx/search/jobs/' },
        {
          id: autoTabId,
          url: 'https://www.upwork.com/nx/search/jobs/',
          status: 'complete',
        } as never,
      );
    }, 10);

    await expect(navPromise).rejects.toBeInstanceOf(HumanActionRequiredError);
    // Zero retry: messenger called exactly once
    expect(messenger).toHaveBeenCalledTimes(1);
    expect(challenges).toContain('captcha');
  });

  it('abortAll immediately cancels active task and rejects queued tasks', async () => {
    const controller = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 5, jitterRatio: 0 }),
    });

    const p1 = controller.runSerialized('req-active', async (signal) => {
      await controller.pace(signal);
      return 'done-1';
    });
    const p2 = controller.runSerialized('req-queued', async () => 'done-2');

    const res = controller.abortAll('Emergency stop');
    expect(res.aborted).toBe(true);
    expect(res.activeRequestId).toBe('req-active');

    await expect(p1).rejects.toBeInstanceOf(TaskAbortedError);
    await expect(p2).rejects.toBeInstanceOf(TaskAbortedError);
  });

  it('does not issue redundant tabs.update when a stale automationTabId was closed and recreated', async () => {
    const controller = new AutomationTabController({
      tabMessenger: vi.fn(async () => ({
        ok: true,
        loggedIn: true,
        url: 'https://www.upwork.com/nx/search/jobs/',
      })),
    });

    const { tabId: firstId, navigated } = await controller.ensureAutomationTab(
      'https://www.upwork.com/nx/search/jobs/',
    );
    expect(navigated).toBe(true);
    // Simulate externally closed tab: tabs.get rejects, forcing ensureAutomationTab to recreate
    vi.spyOn(fakeBrowser.tabs, 'get').mockRejectedValueOnce(new Error('No tab with id'));

    const updateSpy = vi.spyOn(fakeBrowser.tabs, 'update');
    const origCreate = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
    vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (props) => {
      const created = await origCreate(props);
      if (created.id !== undefined) {
        // Mark tab complete in fakeBrowser so waitForTabComplete resolves immediately
        await fakeBrowser.tabs.update(created.id, { status: 'complete' } as never);
      }
      return created;
    });

    expect(firstId).toBeDefined();
    updateSpy.mockClear();
    await controller.navigateAndWaitForHydration('https://www.upwork.com/nx/search/jobs/');
    // Should call tabs.update with { url: ... } at most once (initial navigation from about:blank, no redundant second update)
    const urlUpdateCalls = updateSpy.mock.calls.filter(
      ([, props]) =>
        typeof props === 'object' &&
        props !== null &&
        'url' in props &&
        typeof (props as { url?: unknown }).url === 'string',
    );
    expect(urlUpdateCalls).toHaveLength(1);
  });

  it('rejects credentialed Upwork URLs in validateTargetUrl', () => {
    const controller = new AutomationTabController();
    expect(() =>
      controller.validateTargetUrl('https://user:pass@www.upwork.com/nx/search/jobs/'),
    ).toThrow(/credentials/i);
    expect(() =>
      controller.validateTargetUrl('https://user@www.upwork.com/nx/search/jobs/'),
    ).toThrow(/credentials/i);
  });

  it('waits for async navigation when tabs.get initially still reports complete on about:blank', async () => {
    const targetUrl = 'https://www.upwork.com/nx/search/jobs/?q=go';
    let guardCheckedBeforeComplete = false;
    let navCompleted = false;

    const messenger = vi.fn(async () => {
      if (!navCompleted) {
        guardCheckedBeforeComplete = true;
      }
      return {
        ok: true,
        loggedIn: true,
        url: targetUrl,
      };
    });

    const controller = new AutomationTabController({
      tabMessenger: messenger,
      tabLoadTimeoutMs: 2000,
    });

    const tabState = {
      id: 77,
      url: 'about:blank',
      status: 'complete',
      active: false,
      windowId: 1,
      index: 0,
      highlighted: false,
      incognito: false,
      pinned: false,
      autoDiscardable: false,
      discarded: false,
      frozen: false,
      groupId: 0,
      selected: false,
    };

    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValueOnce({ ...tabState } as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id) => {
      if (id === 77) {
        return { ...tabState } as never;
      }
      throw new Error('Unknown tab');
    });
    vi.spyOn(fakeBrowser.tabs, 'update').mockImplementation(async (id, props) => {
      if (id === 77 && props.url) {
        // Async browser: tabs.update returns while tabs.get still sees about:blank complete
        setTimeout(() => {
          tabState.status = 'loading';
          void fakeBrowser.tabs.onUpdated.trigger(77, { status: 'loading', url: props.url }, {
            ...tabState,
          } as never);
        }, 15);
        setTimeout(() => {
          navCompleted = true;
          tabState.url = props.url ?? targetUrl;
          tabState.status = 'complete';
          void fakeBrowser.tabs.onUpdated.trigger(77, { status: 'complete', url: tabState.url }, {
            ...tabState,
          } as never);
        }, 35);
      }
      return { ...tabState } as never;
    });

    const res = await controller.navigateAndWaitForHydration(targetUrl);
    expect(guardCheckedBeforeComplete).toBe(false);
    expect(res).toEqual({ tabId: 77, url: targetUrl, loggedIn: true });
    expect(messenger).toHaveBeenCalledTimes(1);
  });

  it('waits for async navigation when reusing an existing tab whose tabs.get initially reports stale priorUrl as complete', async () => {
    const priorUrl = 'https://www.upwork.com/jobs/~job1';
    const nextUrl = 'https://www.upwork.com/jobs/~job2';
    const messenger = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      url: tabState.url,
    }));

    const controller = new AutomationTabController({
      tabMessenger: messenger,
      tabLoadTimeoutMs: 2000,
    });

    const tabState = {
      id: 88,
      url: 'about:blank',
      status: 'complete',
      active: false,
      windowId: 1,
      index: 0,
      highlighted: false,
      incognito: false,
      pinned: false,
      autoDiscardable: false,
      discarded: false,
      frozen: false,
      groupId: 0,
      selected: false,
    };

    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValueOnce({ ...tabState } as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id) => {
      if (id === 88) {
        return { ...tabState } as never;
      }
      throw new Error('Unknown tab');
    });
    vi.spyOn(fakeBrowser.tabs, 'update').mockImplementation(async (_id, props) => {
      if (props.url === priorUrl) {
        tabState.url = priorUrl;
        tabState.status = 'complete';
        return { ...tabState } as never;
      }
      // For nextUrl, simulate async transition where tabs.get still shows priorUrl + complete initially
      setTimeout(() => {
        tabState.status = 'loading';
        void fakeBrowser.tabs.onUpdated.trigger(88, { status: 'loading' }, {
          ...tabState,
        } as never);
      }, 15);
      setTimeout(() => {
        tabState.url = nextUrl;
        tabState.status = 'complete';
        void fakeBrowser.tabs.onUpdated.trigger(88, { status: 'complete' }, {
          ...tabState,
        } as never);
      }, 35);
      return { ...tabState } as never;
    });

    const firstRes = await controller.navigateAndWaitForHydration(priorUrl);
    expect(firstRes.url).toBe(priorUrl);

    const secondRes = await controller.navigateAndWaitForHydration(nextUrl);
    expect(secondRes).toEqual({ tabId: 88, url: nextUrl, loggedIn: true });
    expect(messenger).toHaveBeenCalledTimes(2);
  });

  it('does not issue redundant tabs.update even if recreated tab reuses the same tabId', async () => {
    const controller = new AutomationTabController({
      tabMessenger: vi.fn(async () => ({
        ok: true,
        loggedIn: true,
        url: 'https://www.upwork.com/nx/search/jobs/',
      })),
    });

    const { tabId: initialId } = await controller.ensureAutomationTab(
      'https://www.upwork.com/nx/search/jobs/',
    );
    // Simulate externally closed tab, then browser reuses exact same tabId on recreate
    vi.spyOn(fakeBrowser.tabs, 'get').mockRejectedValueOnce(new Error('No tab with id'));
    const origCreate = fakeBrowser.tabs.create.bind(fakeBrowser.tabs);
    vi.spyOn(fakeBrowser.tabs, 'create').mockImplementationOnce(async (props) => {
      const created = await origCreate(props);
      await fakeBrowser.tabs.update(initialId, {
        url: 'about:blank',
        status: 'complete',
      } as never);
      return { ...created, id: initialId, url: 'about:blank', status: 'complete' } as never;
    });
    const updateSpy = vi.spyOn(fakeBrowser.tabs, 'update');

    await controller.navigateAndWaitForHydration('https://www.upwork.com/nx/search/jobs/');
    const urlUpdateCalls = updateSpy.mock.calls.filter(
      ([, props]) =>
        typeof props === 'object' &&
        props !== null &&
        'url' in props &&
        props.url === 'https://www.upwork.com/nx/search/jobs/',
    );
    expect(urlUpdateCalls).toHaveLength(1);
  });

  it('ignores stale login priorUrl during async tab reuse navigation while still halting on genuine login redirects', async () => {
    const loginUrl = 'https://www.upwork.com/ab/account-security/login';
    const roomMissingUrl = 'https://www.upwork.com/ab/messages/rooms/room_missing';
    const challenges: string[] = [];

    const messenger = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      url: roomMissingUrl,
    }));

    const controller = new AutomationTabController({
      tabMessenger: messenger,
      tabLoadTimeoutMs: 2000,
      onChallengeDetected: (d) => challenges.push(d.challengeType),
    });

    const tabState = {
      id: 99,
      url: loginUrl,
      status: 'complete',
      active: false,
      windowId: 1,
      index: 0,
      highlighted: false,
      incognito: false,
      pinned: false,
      autoDiscardable: false,
      discarded: false,
      frozen: false,
      groupId: 0,
      selected: false,
    };

    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValueOnce({ ...tabState } as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id) => {
      if (id === 99) {
        return { ...tabState } as never;
      }
      throw new Error('Unknown tab');
    });

    let redirectBackToLogin = false;
    vi.spyOn(fakeBrowser.tabs, 'update').mockImplementation(async (_id, props) => {
      if (props.url === roomMissingUrl && !redirectBackToLogin) {
        // Browser fires loading with stale tab.url === loginUrl before committing roomMissingUrl
        setTimeout(() => {
          tabState.status = 'loading';
          void fakeBrowser.tabs.onUpdated.trigger(99, { status: 'loading' }, {
            ...tabState,
          } as never);
        }, 10);
        setTimeout(() => {
          tabState.url = roomMissingUrl;
          tabState.status = 'complete';
          void fakeBrowser.tabs.onUpdated.trigger(99, { status: 'complete', url: roomMissingUrl }, {
            ...tabState,
          } as never);
        }, 30);
      } else if (props.url && redirectBackToLogin) {
        setTimeout(() => {
          tabState.status = 'loading';
          void fakeBrowser.tabs.onUpdated.trigger(99, { status: 'loading' }, {
            ...tabState,
          } as never);
        }, 10);
        setTimeout(() => {
          tabState.url = loginUrl;
          tabState.status = 'complete';
          void fakeBrowser.tabs.onUpdated.trigger(99, { status: 'complete', url: loginUrl }, {
            ...tabState,
          } as never);
        }, 30);
      }
      return { ...tabState } as never;
    });

    // Seed controller with existing tab stuck on loginUrl (as left by a prior login challenge test)
    await controller.ensureAutomationTab('https://www.upwork.com/nx/search/jobs/');

    // Navigating to roomMissingUrl must NOT falsely abort on stale loginUrl
    const res = await controller.navigateAndWaitForHydration(roomMissingUrl);
    expect(res).toEqual({ tabId: 99, url: roomMissingUrl, loggedIn: true });
    expect(challenges).toEqual([]);

    // Genuine redirect back to loginUrl MUST still trigger HumanActionRequiredError
    redirectBackToLogin = true;
    await expect(
      controller.navigateAndWaitForHydration('https://www.upwork.com/jobs/~022115332344639171/'),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
    expect(challenges).toEqual(['login']);
  });

  it('navigateAndWaitForHydration respects allowSelectorTimeout on TIMEOUT while preserving HUMAN_ACTION_REQUIRED and strict default TIMEOUT', async () => {
    const targetUrl = 'https://www.upwork.com/nx/search/jobs/?q=typescript';
    let guardMode: 'timeout' | 'challenge' = 'timeout';

    const messenger = vi.fn(async () => {
      if (guardMode === 'challenge') {
        return {
          ok: false,
          errorCode: 'HUMAN_ACTION_REQUIRED',
          challengeType: 'captcha',
          reason: 'Challenge iframe detected',
          url: targetUrl,
        };
      }
      return {
        ok: false,
        errorCode: 'TIMEOUT',
        loggedIn: true,
        reason: 'Timed out waiting for selectors: article.job-tile',
        url: targetUrl,
      };
    });

    const controller = new AutomationTabController({
      tabMessenger: messenger,
      tabLoadTimeoutMs: 2000,
    });

    const tab = await fakeBrowser.tabs.create({ url: targetUrl, active: false });
    if (tab.id === undefined) {
      throw new Error('Expected tab.id');
    }
    await fakeBrowser.tabs.update(tab.id, { status: 'complete' } as never);
    await controller.ensureAutomationTab(targetUrl);
    const autoTabId = controller.getState().automationTabId ?? tab.id;

    const triggerComplete = () => {
      setTimeout(() => {
        void fakeBrowser.tabs.onUpdated.trigger(autoTabId, { status: 'complete', url: targetUrl }, {
          id: autoTabId,
          url: targetUrl,
          status: 'complete',
        } as never);
      }, 10);
    };

    // 1. Default (allowSelectorTimeout omitted) -> throws BridgeRpcError('TIMEOUT')
    triggerComplete();
    await expect(controller.navigateAndWaitForHydration(targetUrl)).rejects.toMatchObject({
      name: 'BridgeRpcError',
      code: 'TIMEOUT',
    } satisfies Partial<BridgeRpcError>);

    // 2. allowSelectorTimeout: true on TIMEOUT -> resolves cleanly
    triggerComplete();
    const res = await controller.navigateAndWaitForHydration(targetUrl, {
      allowSelectorTimeout: true,
    });
    expect(res).toEqual({ tabId: autoTabId, url: targetUrl, loggedIn: true });

    // 3. allowSelectorTimeout: true on HUMAN_ACTION_REQUIRED -> still throws HumanActionRequiredError
    guardMode = 'challenge';
    triggerComplete();
    await expect(
      controller.navigateAndWaitForHydration(targetUrl, { allowSelectorTimeout: true }),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });

  it('unwinds hung sendGuardCheckWithRetry immediately on abortAll and maps ABORTED to TaskAbortedError', async () => {
    const controller = new AutomationTabController({
      tabMessenger: () => new Promise(() => {}),
      tabLoadTimeoutMs: 2000,
    });
    const targetUrl = 'https://www.upwork.com/nx/find-work/';
    const tab = await fakeBrowser.tabs.create({ url: targetUrl, active: false });
    if (tab.id === undefined) {
      throw new Error('Expected tab.id');
    }
    await fakeBrowser.tabs.update(tab.id, { status: 'complete' } as never);
    await controller.ensureAutomationTab(targetUrl);
    const autoTabId = controller.getState().automationTabId ?? tab.id;

    setTimeout(() => {
      void fakeBrowser.tabs.onUpdated.trigger(autoTabId, { status: 'complete', url: targetUrl }, {
        id: autoTabId,
        url: targetUrl,
        status: 'complete',
      } as never);
    }, 10);

    const task = controller.runSerialized('hung-1', (sig) =>
      controller.navigateAndWaitForHydration(targetUrl, {}, sig),
    );
    await new Promise((r) => setTimeout(r, 30));
    controller.abortAll('kill switch');
    await expect(task).rejects.toBeInstanceOf(TaskAbortedError);

    // Direct ABORTED response from content guard check also throws TaskAbortedError
    const abortedCtrl = new AutomationTabController({
      tabMessenger: async () => ({
        ok: false,
        errorCode: 'ABORTED',
        reason: 'Aborted by kill switch',
        url: targetUrl,
      }),
      tabLoadTimeoutMs: 2000,
    });
    const tab2 = await fakeBrowser.tabs.create({ url: targetUrl, active: false });
    if (tab2.id === undefined) throw new Error('Expected tab2.id');
    await fakeBrowser.tabs.update(tab2.id, { status: 'complete' } as never);
    await abortedCtrl.ensureAutomationTab(targetUrl);
    const autoTab2 = abortedCtrl.getState().automationTabId ?? tab2.id;
    setTimeout(() => {
      void fakeBrowser.tabs.onUpdated.trigger(autoTab2, { status: 'complete', url: targetUrl }, {
        id: autoTab2,
        url: targetUrl,
        status: 'complete',
      } as never);
    }, 10);
    await expect(abortedCtrl.navigateAndWaitForHydration(targetUrl)).rejects.toBeInstanceOf(
      TaskAbortedError,
    );
  });

  it('does not false-positive HUMAN_ACTION_REQUIRED on legitimate /jobs/ slugs or search query strings containing 2fa, two-factor, or referrer_url_path', () => {
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/nx/search/jobs/?q=2fa&page=1').matched,
    ).toBe(false);
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/nx/search/jobs/?q=two-factor&page=1').matched,
    ).toBe(false);
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/jobs/Implement-2FA-in-React_~0123456789abcdef/')
        .matched,
    ).toBe(false);
    expect(
      isChallengeOrLoginUrl(
        'https://www.upwork.com/jobs/~0123?referrer_url_path=/ab/account-security/login',
      ).matched,
    ).toBe(false);

    // Genuine challenge/login/2FA paths must still match
    expect(isChallengeOrLoginUrl('https://www.upwork.com/ab/account-security/login')).toMatchObject(
      { matched: true, challengeType: 'login' },
    );
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/ab/account-security/two-factor'),
    ).toMatchObject({ matched: true, challengeType: 'two_factor' });
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/ab/account-security/deviceAuth'),
    ).toMatchObject({ matched: true, challengeType: 'two_factor' });
    expect(isChallengeOrLoginUrl('https://challenges.cloudflare.com/turnstile/v0')).toMatchObject({
      matched: true,
      challengeType: 'cloudflare',
    });
    expect(
      isChallengeOrLoginUrl('https://www.upwork.com/cdn-cgi/challenge-platform/h/b'),
    ).toMatchObject({ matched: true, challengeType: 'cloudflare' });
  });
});
