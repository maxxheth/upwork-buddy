import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { UpworkBuddy } from '../main';
import {
  PASSIVE_SEARCH_BATCH_EVENT,
  PASSIVE_SEARCH_STATUS_EVENT,
  PASSIVE_SPA_NAV_EVENT,
  PASSIVE_TAP_EVENT,
} from '../shared/protocol';
import { BUNDLED_SELECTORS } from '../shared/selectors';
import { StateManager } from '../state';
import { ProjectsListUI } from '../ui/projects-list';
import {
  detectChallengeOrAuth,
  mountUpworkOverlay,
  sanitizePassiveSearchBatch,
  waitForHydration,
} from './overlay';

function captureMessageListener() {
  let listener:
    | ((
        msg: unknown,
        sender: unknown,
        sendResponse: (res?: unknown) => void,
      ) => boolean | undefined)
    | undefined;
  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation(((fn: unknown) => {
    listener = fn as typeof listener;
  }) as never);
  return {
    send: <T = unknown>(msg: Record<string, unknown>): Promise<T> => {
      if (!listener) {
        throw new Error('Overlay message listener was not registered');
      }
      return new Promise<T>((resolve) => {
        const res = listener?.(msg, {}, (payload) => resolve(payload as T));
        if (res === undefined) {
          resolve(undefined as T);
        }
      });
    },
  };
}

function getSentMessagesByType(
  spy: ReturnType<typeof vi.fn>,
  type: string,
): Record<string, unknown>[] {
  return (spy.mock.calls as unknown[][])
    .map((call) => call[0] as Record<string, unknown> | undefined)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg && msg.type === type));
}

describe('Upwork Overlay, Challenge Detection & Shadow DOM Scoping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('detects login walls, 2FA prompts, Cloudflare challenges, and logged-in state', () => {
    expect(
      detectChallengeOrAuth(document, {
        href: 'https://www.upwork.com/ab/account-security/login',
        pathname: '/ab/account-security/login',
      }),
    ).toMatchObject({
      loggedIn: false,
      challengeDetected: true,
      challengeType: 'login',
    });

    document.body.innerHTML = '<div data-test="two-factor-auth">Enter code</div>';
    expect(
      detectChallengeOrAuth(document, {
        href: 'https://www.upwork.com/nx/find-work/',
        pathname: '/nx/find-work/',
      }),
    ).toMatchObject({
      loggedIn: false,
      challengeDetected: true,
      challengeType: 'two_factor',
    });

    document.body.innerHTML = '<main>Verify</main>';
    for (const tfaUrl of [
      'https://www.upwork.com/ab/account-security/two-factor',
      'https://www.upwork.com/nx/2fa/verify',
      'https://www.upwork.com/ab/account-security/deviceauth',
    ]) {
      expect(
        detectChallengeOrAuth(document, {
          href: tfaUrl,
          pathname: new URL(tfaUrl).pathname,
        }),
      ).toMatchObject({
        loggedIn: false,
        challengeDetected: true,
        challengeType: 'two_factor',
      });
    }

    document.body.innerHTML = '<iframe src="https://challenges.cloudflare.com/turnstile"></iframe>';
    expect(
      detectChallengeOrAuth(document, {
        href: 'https://www.upwork.com/nx/search/jobs/',
        pathname: '/nx/search/jobs/',
      }),
    ).toMatchObject({
      loggedIn: false,
      challengeDetected: true,
      challengeType: 'cloudflare',
    });

    document.body.innerHTML = '<div data-test="captcha-challenge">Please solve puzzle</div>';
    expect(
      detectChallengeOrAuth(document, {
        href: 'https://www.upwork.com/nx/search/jobs/',
        pathname: '/nx/search/jobs/',
      }),
    ).toMatchObject({
      loggedIn: false,
      challengeDetected: true,
      challengeType: 'captcha',
    });

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';
    expect(
      detectChallengeOrAuth(document, {
        href: 'https://www.upwork.com/nx/search/jobs/',
        pathname: '/nx/search/jobs/',
      }),
    ).toMatchObject({
      loggedIn: true,
      challengeDetected: false,
    });
  });

  it('waitForHydration returns HUMAN_ACTION_REQUIRED immediately on challenge DOM without progressive scrolling', async () => {
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    document.body.innerHTML = '<div id="cf-challenge-running">Checking your browser</div>';
    const res = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.job-tile'],
      scroll: { steps: 3, intervalMs: 0 },
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('HUMAN_ACTION_REQUIRED');
    }
    expect(scrollBySpy).not.toHaveBeenCalled();
  });

  it('scopes UpworkBuddy, Modal, ButtonManager, and ProjectsListUI inside ShadowRoot without global DOM leaks', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'getCacheSize').mockReturnValue(2);

    const host = document.createElement('upwork-buddy-ui');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const uiContainer = document.createElement('div');
    shadow.appendChild(uiContainer);

    const buddy = new UpworkBuddy({
      uiRoot: uiContainer,
      styleRoot: shadow,
      skipLegacyStyleTag: true,
      alwaysShowToolbar: true,
    });

    await new Promise((r) => setTimeout(r, 25));

    // Must be inside ShadowRoot, NOT in document body
    expect(document.getElementById('upwork-buddy-button-container')).toBeNull();
    expect(document.getElementById('upwork-buddy-modal-overlay')).toBeNull();

    const toolbar = shadow.querySelector('[data-testid="upwork-buddy-toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.classList.contains('visible')).toBe(true);

    const projectsBtn = shadow.querySelector('#upwork-buddy-view-projects-btn');
    expect(projectsBtn?.querySelector('.badge')?.textContent).toBe('2');
    expect(projectsBtn?.classList.contains('visible')).toBe(true);

    // ProjectsListUI scoped badgeRoot works independently too
    vi.restoreAllMocks();
    const state = new StateManager();
    const listUI = new ProjectsListUI(state, document.createElement('div'), shadow);
    listUI.updateBadge();
    expect(projectsBtn?.querySelector('.badge')?.textContent).toBe('0');

    // Modal close works inside ShadowRoot
    const modalClose = shadow.querySelector<HTMLButtonElement>('#upwork-buddy-close');
    const modalOverlay = shadow.querySelector<HTMLElement>('#upwork-buddy-modal-overlay');
    const analyzeBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-testid="toolbar-analyze-btn"]',
    );
    analyzeBtn?.click();
    expect(modalOverlay?.classList.contains('active')).toBe(true);
    modalClose?.click();
    expect(modalOverlay?.classList.contains('active')).toBe(false);

    buddy.destroy();
  });

  it('drops spoofed command type/fields from MAIN-world CustomEvent and survives cyclic data', async () => {
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          type: 'TRIGGER_KILL_SWITCH',
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1',
          data: { ok: 1 },
          capturedAt: '2026-11-20T00:00:00Z',
          extraAdminFlag: true,
        },
      }),
    );

    expect(sendMsgSpy).toHaveBeenCalledTimes(1);
    const msg = (sendMsgSpy.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(msg.type).toBe('PASSIVE_TAP_PAYLOAD');
    expect(msg).not.toHaveProperty('extraAdminFlag');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      window.dispatchEvent(
        new CustomEvent(PASSIVE_TAP_EVENT, {
          detail: {
            kind: 'graphql',
            url: 'https://www.upwork.com/api/graphql/v1',
            data: cyclic,
            capturedAt: '2026-11-20T00:00:00Z',
          },
        }),
      ),
    ).not.toThrow();

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('waitForHydration returns ABORTED (never TIMEOUT) when AbortSignal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const preAborted = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.job-tile'],
      signal: controller.signal,
    });
    expect(preAborted.ok).toBe(false);
    if (!preAborted.ok) {
      expect(preAborted.errorCode).toBe('ABORTED');
    }

    const midController = new AbortController();
    const midPromise = waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.job-tile'],
      timeoutMs: 5000,
      signal: midController.signal,
    });
    midController.abort();
    const midAborted = await midPromise;
    expect(midAborted.ok).toBe(false);
    if (!midAborted.ok) {
      expect(midAborted.errorCode).toBe('ABORTED');
    }
  });

  it('waitForHydration supports isApiReady, subscribeApiReady, synchronous unsubscribe, and challenge-first precedence', async () => {
    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const immediateRes = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.nonexistent-selector'],
      timeoutMs: 500,
      isApiReady: () => true,
    });
    expect(immediateRes).toEqual({
      ok: true,
      loggedIn: true,
      url: 'https://www.upwork.com/nx/search/jobs/',
    });

    let ready = false;
    const apiListeners = new Set<() => void>();
    const unsubSpy = vi.fn(() => {
      apiListeners.clear();
    });
    const waitPromise = waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.nonexistent-selector'],
      timeoutMs: 2000,
      isApiReady: () => ready,
      subscribeApiReady: (cb) => {
        apiListeners.add(cb);
        return unsubSpy;
      },
    });
    ready = true;
    for (const cb of apiListeners) {
      cb();
    }
    const subscribedRes = await waitPromise;
    expect(subscribedRes.ok).toBe(true);
    expect(unsubSpy).toHaveBeenCalledTimes(1);

    let syncReady = false;
    const syncUnsubSpy = vi.fn();
    const syncRes = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.nonexistent-selector'],
      timeoutMs: 500,
      isApiReady: () => syncReady,
      subscribeApiReady: (cb) => {
        syncReady = true;
        cb();
        return syncUnsubSpy;
      },
    });
    expect(syncRes.ok).toBe(true);
    expect(syncUnsubSpy).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '<div id="cf-challenge-running">Checking your browser</div>';
    const challengeRes = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.nonexistent-selector'],
      timeoutMs: 500,
      isApiReady: () => true,
    });
    expect(challengeRes.ok).toBe(false);
    if (!challengeRes.ok) {
      expect(challengeRes.errorCode).toBe('HUMAN_ACTION_REQUIRED');
    }
  });

  it('sanitizes PASSIVE_SEARCH_BATCH_EVENT via strict allowlist, rejects invalid origins/IDs, and deduplicates by fingerprint', async () => {
    expect(
      sanitizePassiveSearchBatch({
        captureSeq: 1,
        navigationEpoch: 0,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
        sourceFeed: 'search',
        jobs: [],
        capturedAt: '2026-11-22T10:00:00Z',
      }),
    ).toBeNull();

    for (const badReqUrl of [
      'https://evil.com/graphql',
      'https://evilupwork.com/graphql',
      'http://www.upwork.com/api/graphql/v1',
      'https://user:pass@www.upwork.com/api/graphql/v1',
      'https://www.upwork.com:8443/api/graphql/v1',
    ]) {
      expect(
        sanitizePassiveSearchBatch({
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: badReqUrl,
          pageUrl: 'https://www.upwork.com/nx/search/jobs/',
          sourceFeed: 'search',
          jobs: [],
          capturedAt: '2026-11-22T10:00:00Z',
        }),
      ).toBeNull();
    }

    expect(
      sanitizePassiveSearchBatch({
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://api.upwork.com/graphql',
        pageUrl: 'https://evil.upwork.com/nx/search/jobs/',
        sourceFeed: 'search',
        jobs: [],
        capturedAt: '2026-11-22T10:00:00Z',
      }),
    ).toBeNull();

    const oversizedJobs = Array.from({ length: 120 }, (_, i) => ({
      upwork_job_id: `~010000000000${String(i).padStart(4, '0')}`,
      job_title: `Job ${i}`,
      job_description: i === 0 ? 'x'.repeat(20_000) : 'desc',
      url: i === 0 ? 'javascript:alert(1)' : 'https://www.upwork.com/jobs/~01/',
      canonical_url: i === 0 ? 'https://evil.com/phish' : 'https://www.upwork.com/jobs/~01/',
      proposals_count: i === 0 ? -5 : 3,
      client_rating: i === 0 ? Number.NaN : 4.9,
      connects_required: i === 0 ? Number.POSITIVE_INFINITY : 12,
      evilField: 'drop-me',
    }));
    oversizedJobs.splice(1, 0, {
      upwork_job_id: 'invalid-no-tilde',
      job_title: 'Invalid ID',
    } as never);

    const sanitizedOversized = sanitizePassiveSearchBatch({
      type: 'TRIGGER_KILL_SWITCH',
      captureSeq: 5,
      navigationEpoch: 1,
      captureKind: 'graphql',
      requestUrl: 'https://api.upwork.com/api/graphql/v1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go',
      sourceFeed: 'search',
      jobs: oversizedJobs,
      capturedAt: '2026-11-22T10:00:00Z',
      extraAdminFlag: true,
    });

    expect(sanitizedOversized).not.toBeNull();
    expect(sanitizedOversized).not.toHaveProperty('type');
    expect(sanitizedOversized).not.toHaveProperty('extraAdminFlag');
    expect(sanitizedOversized?.jobs).toHaveLength(99);
    expect(sanitizedOversized?.jobs[0].job_description?.length).toBe(16_384);
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('url');
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('canonical_url');
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('proposals_count');
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('client_rating');
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('connects_required');
    expect(sanitizedOversized?.jobs[0]).not.toHaveProperty('evilField');

    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    const dispatchBatch = (seq: number, offset: number, jobId: string) => {
      window.dispatchEvent(
        new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
          detail: {
            type: 'TRIGGER_KILL_SWITCH',
            extraAdminFlag: true,
            captureSeq: seq,
            navigationEpoch: 1,
            captureKind: 'graphql',
            requestUrl: 'https://www.upwork.com/api/graphql/v1',
            pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go',
            operationName: 'userJobSearchV1',
            sourceFeed: 'search',
            query: 'go',
            paging: { offset, count: 20, totalCount: 40, hasNextPage: offset === 0 },
            jobs: [
              {
                upwork_job_id: jobId,
                job_title: 'Go Engineer',
                evilField: 'strip-me',
              },
            ],
            capturedAt: '2026-11-22T10:01:00Z',
          },
        }),
      );
    };

    dispatchBatch(1, 0, '~0111111111');
    dispatchBatch(2, 0, '~0111111111'); // duplicate fingerprint -> suppressed
    dispatchBatch(3, 20, '~0222222222'); // page 2 -> forwarded

    const sentBatches = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH');
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[0].type).toBe('PASSIVE_SEARCH_BATCH');
    const batch0 = sentBatches[0].batch as Record<string, unknown>;
    expect(batch0).not.toHaveProperty('extraAdminFlag');
    expect((batch0.jobs as Record<string, unknown>[])[0]).not.toHaveProperty('evilField');

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('forwards valid truncated and originalBytes on PASSIVE_TAP_PAYLOAD and omits invalid negative values', async () => {
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1',
          operationName: 'userJobSearchV1',
          data: { __projected: true, jobs: [] },
          capturedAt: '2026-11-22T10:02:00Z',
          truncated: true,
          originalBytes: 1_250_000,
        },
      }),
    );

    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1',
          data: { ok: 2 },
          capturedAt: '2026-11-22T10:02:01Z',
          truncated: 'not-bool',
          originalBytes: -42,
        },
      }),
    );

    const taps = getSentMessagesByType(sendMsgSpy, 'PASSIVE_TAP_PAYLOAD');
    expect(taps).toHaveLength(2);
    expect(taps[0].truncated).toBe(true);
    expect(taps[0].originalBytes).toBe(1_250_000);
    expect(taps[1]).not.toHaveProperty('truncated');
    expect(taps[1]).not.toHaveProperty('originalBytes');

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('suppresses PASSIVE_SEARCH_BATCH forwarding on challenge DOM and empty batches, while CONTENT_CHECK_GUARDS honors waitForSearchApi', async () => {
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    const rpc = captureMessageListener();

    document.body.innerHTML = '<div id="cf-challenge-running">Checking your browser</div>';
    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0333333333', job_title: 'Blocked Job' }],
          capturedAt: '2026-11-22T10:03:00Z',
        },
      }),
    );
    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH')).toHaveLength(0);

    const challengedGuards = await rpc.send<{ ok: boolean; errorCode?: string }>({
      type: 'CONTENT_CHECK_GUARDS',
      waitForSelectors: ['article.job-tile'],
      waitForSearchApi: true,
      timeoutMs: 1000,
    });
    expect(challengedGuards.ok).toBe(false);
    expect(challengedGuards.errorCode).toBe('HUMAN_ACTION_REQUIRED');

    // Switch to clean logged-in DOM with 0 article.job-tile elements
    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';
    const ctx2 = new ContentScriptContext('upwork');
    const rpc2 = captureMessageListener();
    const ui2 = await mountUpworkOverlay(ctx2);

    const guardPromise = rpc2.send<{ ok: boolean; loggedIn?: boolean }>({
      type: 'CONTENT_CHECK_GUARDS',
      waitForSelectors: ['article.job-tile'],
      waitForSearchApi: true,
      timeoutMs: 2000,
    });

    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 2,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/',
          sourceFeed: 'search',
          isExplicitEmpty: true,
          jobs: [],
          capturedAt: '2026-11-22T10:04:00Z',
        },
      }),
    );

    const guardRes = await guardPromise;
    expect(guardRes.ok).toBe(true);
    expect(guardRes.loggedIn).toBe(true);
    // Empty batch must NOT be forwarded to PASSIVE_SEARCH_BATCH
    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH')).toHaveLength(0);

    ctx.notifyInvalidated();
    ui.remove();
    ctx2.notifyInvalidated();
    ui2.remove();
  });

  it('CONTENT_SCRAPE_SEARCH waits for in-flight XHR, scopes to navigationEpoch and capturedSince, and aborts on CONTENT_KILL_ABORT', async () => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const rpc = captureMessageListener();

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    // Epoch 1 stale batch (Job A)
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=react',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0444444441', job_title: 'Stale Epoch 1 Job A' }],
          capturedAt: '2026-11-22T10:05:00.000Z',
        },
      }),
    );

    // SPA navigation advances to Epoch 2 with in-flight search XHR
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          pathname: '/nx/search/jobs/',
          search: '?q=golang',
          navigationEpoch: 2,
          ts: '2026-11-22T10:06:00.000Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_STATUS_EVENT, {
        detail: { inFlightCount: 1, navigationEpoch: 2 },
      }),
    );

    const scrapePromise = rpc.send<{
      ok: boolean;
      extractionSource?: string;
      jobs: Array<{ upwork_job_id?: string; job_title?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'golang',
      selectorConfig: BUNDLED_SELECTORS,
      capturedSince: '2026-11-22T10:06:01.000Z',
      waitForApiMs: 2000,
    });

    // Older batch within Epoch 2 (before capturedSince) must be excluded
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 2,
          navigationEpoch: 2,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0444444442', job_title: 'Before capturedSince Job' }],
          capturedAt: '2026-11-22T10:06:00.500Z',
        },
      }),
    );

    // Fresh Epoch 2 batch (Job B) settles
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 3,
          navigationEpoch: 2,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0444444443', job_title: 'Fresh Epoch 2 Job B' }],
          capturedAt: '2026-11-22T10:06:02.000Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_STATUS_EVENT, {
        detail: { inFlightCount: 0, navigationEpoch: 2 },
      }),
    );

    const scrapeRes = await scrapePromise;
    expect(scrapeRes.ok).toBe(true);
    expect(scrapeRes.extractionSource).toBe('graphql');
    expect(scrapeRes.jobs).toHaveLength(1);
    expect(scrapeRes.jobs[0].upwork_job_id).toBe('~0444444443');
    expect(scrapeRes.jobs[0].job_title).toBe('Fresh Epoch 2 Job B');

    // Kill switch abort during active waitForApiMs
    const abortWaitPromise = rpc.send<{ ok: boolean; errorCode?: string }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'abort-test',
      selectorConfig: BUNDLED_SELECTORS,
      capturedSince: '2026-11-22T10:07:00.000Z',
      waitForApiMs: 5000,
    });
    const killRes = await rpc.send<{ ok: boolean }>({ type: 'CONTENT_KILL_ABORT' });
    expect(killRes.ok).toBe(true);

    const abortedRes = await abortWaitPromise;
    expect(abortedRes.ok).toBe(false);
    expect(abortedRes.errorCode).toBe('ABORTED');

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('triggers 1200ms debounced SPA DOM fallback on PASSIVE_SPA_NAV_EVENT, cancels on GraphQL, and cleans up on ctx.onInvalidated', async () => {
    vi.useFakeTimers();
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);

    document.body.innerHTML = `
      <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
      <main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/SPA-DOM-Fallback_~0555555551/">SPA DOM Fallback Job</a>
          <div data-test="JobDescription"><p>Rendered via SSR/hydration only.</p></div>
        </article>
      </main>
    `;

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          pathname: '/nx/search/jobs/',
          search: '?q=golang',
          navigationEpoch: 2,
          ts: '2026-11-22T10:08:00Z',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1199);
    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH')).toHaveLength(1);
    });

    const spaMsgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH');
    const spaBatch = spaMsgs[0].batch as Record<string, unknown>;
    expect(spaBatch.captureKind).toBe('spa_dom');
    expect(spaBatch.navigationEpoch).toBe(2);
    expect(spaBatch.sourceFeed).toBe('search');
    expect((spaBatch.jobs as Array<Record<string, unknown>>)[0].upwork_job_id).toBe('~0555555551');

    // Epoch 3: GraphQL arrival cancels the 1200ms DOM fallback timer
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/find-work/best-matches',
          pathname: '/nx/find-work/best-matches',
          search: '',
          navigationEpoch: 3,
          ts: '2026-11-22T10:09:00Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 10,
          navigationEpoch: 3,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/find-work/best-matches',
          sourceFeed: 'best_matches',
          jobs: [{ upwork_job_id: '~0555555552', job_title: 'GraphQL Best Match' }],
          capturedAt: '2026-11-22T10:09:00.200Z',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    const afterGqlMsgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH');
    expect(afterGqlMsgs).toHaveLength(2);
    expect((afterGqlMsgs[1].batch as Record<string, unknown>).captureKind).toBe('graphql');

    // Epoch 4: ctx.notifyInvalidated() cancels pending timer and removes all 4 window listeners
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=rust',
          pathname: '/nx/search/jobs/',
          search: '?q=rust',
          navigationEpoch: 4,
          ts: '2026-11-22T10:10:00Z',
        },
      }),
    );
    ctx.notifyInvalidated();
    ui.remove();

    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 11,
          navigationEpoch: 4,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=rust',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0555555553', job_title: 'Post Invalidation' }],
          capturedAt: '2026-11-22T10:10:02Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1',
          data: { ok: 1 },
          capturedAt: '2026-11-22T10:10:02Z',
        },
      }),
    );

    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH')).toHaveLength(2);
    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_TAP_PAYLOAD')).toHaveLength(0);
  });

  it('scopes recentPassivePayloads by navigationEpoch and capturedSince for CONTENT_SCRAPE_SEARCH and runSpaDomFallback while preserving detail enrichment', async () => {
    vi.useFakeTimers();
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    const rpc = captureMessageListener();

    document.body.innerHTML = `
      <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
      <main>
        <div class="job-details-content">
          <h1>Epoch 1 Detail Drawer Job</h1>
          <div data-test="Description"><p>Short detail text.</p></div>
        </div>
      </main>
    `;

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    // Epoch 1: dispatch both PASSIVE_SEARCH_BATCH_EVENT and PASSIVE_TAP_EVENT with stale jobs
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=react',
          sourceFeed: 'search',
          jobs: [{ upwork_job_id: '~0777777701', job_title: 'Stale Epoch 1 Batch Job' }],
          capturedAt: '2026-11-22T12:00:00.000Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
          operationName: 'userJobSearchV1',
          capturedAt: '2026-11-22T12:00:00.000Z',
          data: {
            jobSearch: {
              results: [
                {
                  ciphertext: '~0777777702',
                  title: 'Stale Epoch 1 PassiveTap Job',
                  description: 'Enriched description from Epoch 1 PASSIVE_TAP_EVENT.',
                  connectPrice: 14,
                },
              ],
            },
          },
        },
      }),
    );

    // Advance to Epoch 2 via PASSIVE_SPA_NAV_EVENT
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          pathname: '/nx/search/jobs/',
          search: '?q=golang',
          navigationEpoch: 2,
          ts: '2026-11-22T12:01:00.000Z',
        },
      }),
    );

    // Pre-capturedSince PASSIVE_TAP_EVENT inside Epoch 2 (must be excluded by capturedSince)
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
          operationName: 'userJobSearchV1',
          capturedAt: '2026-11-22T12:01:00.500Z',
          data: {
            jobSearch: {
              results: [
                {
                  ciphertext: '~0777777703',
                  title: 'Pre-capturedSince Epoch 2 PassiveTap Job',
                },
              ],
            },
          },
        },
      }),
    );

    // Fresh Epoch 2 PASSIVE_TAP_EVENT after capturedSince
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
          operationName: 'userJobSearchV1',
          capturedAt: '2026-11-22T12:01:02.000Z',
          data: {
            jobSearch: {
              results: [
                {
                  ciphertext: '~0777777704',
                  title: 'Fresh Epoch 2 PassiveTap Job',
                },
              ],
            },
          },
        },
      }),
    );

    const scrapeRes = await rpc.send<{
      ok: boolean;
      jobs: Array<{ upwork_job_id?: string; job_title?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'golang',
      selectorConfig: BUNDLED_SELECTORS,
      capturedSince: '2026-11-22T12:01:01.000Z',
    });

    expect(scrapeRes.ok).toBe(true);
    expect(scrapeRes.jobs.map((j) => j.upwork_job_id)).toEqual(['~0777777704']);

    // Detail drawer opened after pushState still retains Epoch 1 PASSIVE_TAP_EVENT enrichment
    const detailRes = await rpc.send<{
      ok: boolean;
      detail?: { upwork_job_id?: string; connects_required?: number | null };
      payload?: { upwork_job_id?: string; connects_required?: number | null };
    }>({
      type: 'CONTENT_SCRAPE_DETAIL',
      url: 'https://www.upwork.com/jobs/Epoch-1-Detail_~0777777702/',
      requireDrawer: true,
      selectorConfig: BUNDLED_SELECTORS,
    });
    expect(detailRes.ok).toBe(true);
    expect(detailRes.detail?.connects_required).toBe(14);
    expect(detailRes.payload?.connects_required).toBe(14);

    // Epoch 3 SPA DOM fallback must NOT leak Epoch 1 or Epoch 2 PASSIVE_TAP_EVENT jobs
    document.body.innerHTML = `
      <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
      <main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Epoch3-Dom-Only_~0777777705/">Epoch 3 DOM Job</a>
          <div data-test="JobDescription"><p>Rendered in Epoch 3.</p></div>
        </article>
      </main>
    `;
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=rust',
          pathname: '/nx/search/jobs/',
          search: '?q=rust',
          navigationEpoch: 3,
          ts: '2026-11-22T12:02:00.000Z',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => {
      const spaMsgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
        (m) => (m.batch as Record<string, unknown>).navigationEpoch === 3,
      );
      expect(spaMsgs).toHaveLength(1);
    });

    const epoch3Msgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
      (m) => (m.batch as Record<string, unknown>).navigationEpoch === 3,
    );
    const epoch3Batch = epoch3Msgs[0].batch as {
      captureKind: string;
      jobs: Array<{ upwork_job_id: string }>;
    };
    expect(epoch3Batch.captureKind).toBe('spa_dom');
    expect(epoch3Batch.jobs.map((j) => j.upwork_job_id)).toEqual(['~0777777705']);

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('CONTENT_SCRAPE_SEARCH filters mismatched expectedPage batches while preserving batches with undefined paging.page', async () => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const rpc = captureMessageListener();

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go&page=1',
          sourceFeed: 'search',
          paging: { page: 1, hasNextPage: true },
          jobs: [{ upwork_job_id: '~0888888801', job_title: 'Page 1 Job (Exclude)' }],
          capturedAt: '2026-11-22T12:10:00.000Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 2,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go&page=2',
          sourceFeed: 'search',
          paging: { page: 2, hasNextPage: false },
          jobs: [{ upwork_job_id: '~0888888802', job_title: 'Page 2 Job (Keep)' }],
          capturedAt: '2026-11-22T12:10:01.000Z',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 3,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/find-work/best-matches',
          sourceFeed: 'best_matches',
          paging: { hasNextPage: true },
          jobs: [{ upwork_job_id: '~0888888803', job_title: 'Relay Unpaged Job (Keep)' }],
          capturedAt: '2026-11-22T12:10:02.000Z',
        },
      }),
    );

    const res = await rpc.send<{
      ok: boolean;
      jobs: Array<{ upwork_job_id?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'go',
      expectedPage: 2,
      selectorConfig: BUNDLED_SELECTORS,
    });

    expect(res.ok).toBe(true);
    expect(res.jobs.map((j) => j.upwork_job_id)).toEqual(['~0888888802', '~0888888803']);

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('correlates late in-flight Epoch 1 PASSIVE_TAP_EVENT arriving after Epoch 2 PASSIVE_SPA_NAV_EVENT so Epoch 1 jobs never leak into Epoch 2 CONTENT_SCRAPE_SEARCH or runSpaDomFallback', async () => {
    vi.useFakeTimers();
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    const rpc = captureMessageListener();

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    // Navigate to Epoch 2 (?q=golang) before an in-flight Epoch 1 (?q=react) fetch resolves
    const navTime = '2026-11-22T13:00:00.000Z';
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          pathname: '/nx/search/jobs/',
          search: '?q=golang',
          navigationEpoch: 2,
          ts: navTime,
        },
      }),
    );

    // Late Epoch 1 response resolves AFTER navTime: emits PASSIVE_SEARCH_BATCH_EVENT (navigationEpoch: 1)
    // followed by PASSIVE_TAP_EVENT (same requestUrl & capturedAt > navTime)
    const lateCapturedAt = '2026-11-22T13:00:00.250Z';
    const requestUrl = 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1';
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl,
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=react',
          operationName: 'userJobSearchV1',
          sourceFeed: 'search',
          query: 'react',
          jobs: [{ upwork_job_id: '~0999999901', job_title: 'Late Epoch 1 React Job' }],
          capturedAt: lateCapturedAt,
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: requestUrl,
          operationName: 'userJobSearchV1',
          capturedAt: lateCapturedAt,
          data: {
            jobSearch: {
              results: [
                {
                  ciphertext: '~0999999901',
                  title: 'Late Epoch 1 React Job',
                },
              ],
            },
          },
        },
      }),
    );

    // Epoch 2 CONTENT_SCRAPE_SEARCH (with capturedSince: navTime) must return 0 Epoch 1 jobs
    const scrapeRes = await rpc.send<{
      ok: boolean;
      jobs: Array<{ upwork_job_id?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'golang',
      selectorConfig: BUNDLED_SELECTORS,
      capturedSince: navTime,
    });
    expect(scrapeRes.ok).toBe(true);
    expect(scrapeRes.jobs).toEqual([]);

    // Render Epoch 2 DOM job and trigger 1200ms runSpaDomFallback -> must emit ONLY Epoch 2 DOM job
    document.body.innerHTML = `
      <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
      <main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Epoch2-Golang-DOM_~0999999902/">Epoch 2 Golang DOM Job</a>
          <div data-test="JobDescription"><p>Epoch 2 DOM description.</p></div>
        </article>
      </main>
    `;

    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => {
      const spaMsgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
        (m) => (m.batch as Record<string, unknown>).navigationEpoch === 2,
      );
      expect(spaMsgs).toHaveLength(1);
    });

    const epoch2Msgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
      (m) => (m.batch as Record<string, unknown>).navigationEpoch === 2,
    );
    const epoch2Batch = epoch2Msgs[0].batch as {
      captureKind: string;
      jobs: Array<{ upwork_job_id: string }>;
    };
    expect(epoch2Batch.captureKind).toBe('spa_dom');
    expect(epoch2Batch.jobs.map((j) => j.upwork_job_id)).toEqual(['~0999999902']);

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('retroactively updates already-buffered recentPassivePayloads when PASSIVE_TAP_EVENT arrives before PASSIVE_SEARCH_BATCH_EVENT (replay order)', async () => {
    vi.useFakeTimers();
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    const rpc = captureMessageListener();

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    const navTime = '2026-11-22T13:05:00.000Z';
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SPA_NAV_EVENT, {
        detail: {
          url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
          pathname: '/nx/search/jobs/',
          search: '?q=golang',
          navigationEpoch: 2,
          ts: navTime,
        },
      }),
    );

    // Replay order: PASSIVE_TAP_EVENT arrives FIRST during Epoch 2
    const replayCapturedAt = '2026-11-22T13:05:00.300Z';
    const requestUrl = 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1';
    window.dispatchEvent(
      new CustomEvent(PASSIVE_TAP_EVENT, {
        detail: {
          kind: 'graphql',
          url: requestUrl,
          operationName: 'userJobSearchV1',
          capturedAt: replayCapturedAt,
          data: {
            jobSearch: {
              results: [
                {
                  ciphertext: '~0999999903',
                  title: 'Replay-Order Epoch 1 Job',
                },
              ],
            },
          },
        },
      }),
    );

    // Companion PASSIVE_SEARCH_BATCH_EVENT (navigationEpoch: 1, empty error-coded batch) arrives SECOND
    window.dispatchEvent(
      new CustomEvent(PASSIVE_SEARCH_BATCH_EVENT, {
        detail: {
          captureSeq: 1,
          navigationEpoch: 1,
          captureKind: 'graphql',
          requestUrl,
          pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=react',
          operationName: 'userJobSearchV1',
          sourceFeed: 'search',
          query: 'react',
          graphqlErrorCodes: ['RATE_LIMITED'],
          jobs: [],
          capturedAt: replayCapturedAt,
        },
      }),
    );

    const scrapeRes = await rpc.send<{
      ok: boolean;
      jobs: Array<{ upwork_job_id?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'golang',
      selectorConfig: BUNDLED_SELECTORS,
      capturedSince: navTime,
    });
    expect(scrapeRes.ok).toBe(true);
    expect(scrapeRes.jobs).toEqual([]);

    document.body.innerHTML = `
      <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
      <main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Epoch2-Replay-DOM_~0999999904/">Epoch 2 Replay DOM Job</a>
          <div data-test="JobDescription"><p>Epoch 2 DOM only.</p></div>
        </article>
      </main>
    `;

    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => {
      const spaMsgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
        (m) => (m.batch as Record<string, unknown>).navigationEpoch === 2,
      );
      expect(spaMsgs).toHaveLength(1);
    });

    const epoch2Msgs = getSentMessagesByType(sendMsgSpy, 'PASSIVE_SEARCH_BATCH').filter(
      (m) => (m.batch as Record<string, unknown>).navigationEpoch === 2,
    );
    const epoch2Batch = epoch2Msgs[0].batch as {
      captureKind: string;
      jobs: Array<{ upwork_job_id: string }>;
    };
    expect(epoch2Batch.captureKind).toBe('spa_dom');
    expect(epoch2Batch.jobs.map((j) => j.upwork_job_id)).toEqual(['~0999999904']);

    ctx.notifyInvalidated();
    ui.remove();
  });

  it('ignores PASSIVE_TAP_EVENT with invalid capturedAt safely', async () => {
    fakeBrowser.reset();
    const sendMsgSpy = vi.fn(async () => ({ ok: true }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMsgSpy as never);
    const rpc = captureMessageListener();

    document.body.innerHTML =
      '<nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>';

    const ctx = new ContentScriptContext('upwork');
    const ui = await mountUpworkOverlay(ctx);

    for (const badCapturedAt of ['not-a-valid-date', '   ', '2026-99-99T99:99:99Z']) {
      window.dispatchEvent(
        new CustomEvent(PASSIVE_TAP_EVENT, {
          detail: {
            kind: 'graphql',
            url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
            operationName: 'userJobSearchV1',
            capturedAt: badCapturedAt,
            data: {
              jobSearch: {
                results: [{ ciphertext: '~0999999905', title: 'Bad Timestamp Job' }],
              },
            },
          },
        }),
      );
    }

    expect(getSentMessagesByType(sendMsgSpy, 'PASSIVE_TAP_PAYLOAD')).toHaveLength(0);

    const scrapeRes = await rpc.send<{
      ok: boolean;
      jobs: Array<{ upwork_job_id?: string }>;
    }>({
      type: 'CONTENT_SCRAPE_SEARCH',
      source: 'search',
      query: 'go',
      selectorConfig: BUNDLED_SELECTORS,
    });
    expect(scrapeRes.ok).toBe(true);
    expect(scrapeRes.jobs).toEqual([]);

    ctx.notifyInvalidated();
    ui.remove();
  });
});
