import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { UpworkBuddy } from '../main';
import { PASSIVE_TAP_EVENT } from '../shared/protocol';
import { StateManager } from '../state';
import { ProjectsListUI } from '../ui/projects-list';
import { detectChallengeOrAuth, mountUpworkOverlay, waitForHydration } from './overlay';

describe('Upwork Overlay, Challenge Detection & Shadow DOM Scoping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
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

  it('waitForHydration returns HUMAN_ACTION_REQUIRED immediately on challenge DOM', async () => {
    document.body.innerHTML = '<div id="cf-challenge-running">Checking your browser</div>';
    const res = await waitForHydration({
      doc: document,
      loc: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
      waitForSelectors: ['article.job-tile'],
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('HUMAN_ACTION_REQUIRED');
    }
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
});
