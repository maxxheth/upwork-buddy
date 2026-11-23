import { isUpworkContentRoutePath, matchChallengeOrLoginUrl } from '../shared/challenge-url';
import type {
  ChallengeType,
  ContentGuardCheckResponse,
  SessionProbeResult,
} from '../shared/protocol';
import { type AuthAndChallengeGuardsConfig, BUNDLED_SELECTORS } from '../shared/selectors';

const DEFAULT_HYDRATION_TIMEOUT_MS = 10_000;

function matchesAnySelector(doc: Document, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (doc.querySelector(sel)) {
        return true;
      }
    } catch {
      // ignore unsupported selector
    }
  }
  return false;
}

function classifyChallengeType(pattern: string): ChallengeType {
  const lower = pattern.toLowerCase();
  if (
    lower.includes('two-factor') ||
    lower.includes('two-step') ||
    lower.includes('verification code') ||
    lower.includes('deviceauth')
  ) {
    return 'two_factor';
  }
  if (lower.includes('recaptcha') || lower.includes('captcha') || lower.includes('arkose')) {
    return 'captcha';
  }
  if (
    lower.includes('cloudflare') ||
    lower.includes('cf-challenge') ||
    lower.includes('checking your browser')
  ) {
    return 'cloudflare';
  }
  if (lower.includes('login') || lower.includes('signup')) {
    return 'login';
  }
  return 'verification';
}

export function detectChallengeOrAuth(
  doc: Document,
  loc: Pick<Location, 'href' | 'pathname'>,
  guards?: AuthAndChallengeGuardsConfig,
): SessionProbeResult {
  const effectiveGuards = guards ?? BUNDLED_SELECTORS.auth_and_challenge_guards;
  const href = loc.href || '';
  const pathname = loc.pathname || '';

  const drawerOpen = Boolean(doc.querySelector('.job-details-content'));
  const isJobDetailPage = /^\/jobs\/~[a-zA-Z0-9]+/.test(pathname);
  const hydrated =
    doc.readyState === 'complete' ||
    Boolean(
      doc.querySelector(
        'main, .job-details-content, article.job-tile, [data-test="job-tile-list"]',
      ),
    );

  // 1. Check login, challenge & 2FA URL patterns (host + pathname only; query strings & content routes excluded for 2FA)
  const urlCheck = matchChallengeOrLoginUrl(href || pathname, effectiveGuards);
  if (urlCheck.matched) {
    const challengeReason =
      urlCheck.category === 'login'
        ? `Login page detected (${urlCheck.matchedPattern ?? ''})`
        : urlCheck.category === 'challenge'
          ? `Challenge URL detected (${urlCheck.matchedPattern ?? ''})`
          : 'Two-factor authentication challenge URL detected';
    return {
      url: href,
      pathname,
      loggedIn: false,
      challengeDetected: true,
      challengeType: urlCheck.challengeType,
      challengeReason,
      drawerOpen,
      isJobDetailPage,
      hydrated,
    };
  }

  // 2. Check challenge DOM selectors
  const challengeSelectors = Array.from(
    new Set([
      ...(effectiveGuards?.challenge_selectors ?? []),
      "[data-test='captcha-challenge']",
      "[data-test='login-wall']",
    ]),
  );
  for (const sel of challengeSelectors) {
    try {
      const matchedEl = doc.querySelector(sel);
      if (matchedEl) {
        const signalHint = [
          sel,
          matchedEl.id,
          matchedEl.getAttribute('class') ?? '',
          matchedEl.getAttribute('data-test') ?? '',
        ].join(' ');
        return {
          url: href,
          pathname,
          loggedIn: false,
          challengeDetected: true,
          challengeType: classifyChallengeType(signalHint),
          challengeReason: `Verification challenge selector matched: ${sel}`,
          drawerOpen,
          isJobDetailPage,
          hydrated,
        };
      }
    } catch {
      // ignore invalid selector
    }
  }

  // 3. Positive logged-in vs logged-out detection
  const hasLoggedOutMarker = matchesAnySelector(
    doc,
    effectiveGuards?.logged_out_selectors ?? [
      "a[href*='/ab/account-security/login']",
      "[data-test='login-link']",
      "form[action*='login']",
    ],
  );
  const hasLoggedInMarker = matchesAnySelector(
    doc,
    effectiveGuards?.logged_in_selectors ?? [
      "[data-test='nav-user-menu']",
      '.air3-avatar',
      "[data-test='find-work-home']",
      "button[aria-label*='User menu']",
      'nav.air3-nav-freelancer',
      "[data-cy='user-menu']",
      '#nav-right .air3-dropdown',
    ],
  );

  // 4. Check challenge text in headings / alerts only when not clearly on a logged-in Upwork content route
  const lowerPath = pathname.toLowerCase();
  const isContentRoute =
    isUpworkContentRoutePath(lowerPath) ||
    lowerPath === '/nx/proposals' ||
    lowerPath.startsWith('/freelance-jobs/') ||
    lowerPath.startsWith('/nx/job-details');
  const isAuthenticatedContentPage = hasLoggedInMarker && !hasLoggedOutMarker && isContentRoute;

  if (!isAuthenticatedContentPage) {
    const textTargets = doc.querySelectorAll('h1, h2, .air3-alert, [role="alert"], main');
    let combinedVisibleText = '';
    textTargets.forEach((el) => {
      combinedVisibleText += ` ${(el.textContent ?? '').toLowerCase()}`;
    });
    for (const pattern of effectiveGuards?.challenge_text_patterns ?? []) {
      if (combinedVisibleText.includes(pattern.toLowerCase())) {
        return {
          url: href,
          pathname,
          loggedIn: false,
          challengeDetected: true,
          challengeType: classifyChallengeType(pattern),
          challengeReason: `Challenge text detected: "${pattern}"`,
          drawerOpen,
          isJobDetailPage,
          hydrated,
        };
      }
    }
  }

  const loggedIn = hasLoggedInMarker || !hasLoggedOutMarker;

  return {
    url: href,
    pathname,
    loggedIn,
    challengeDetected: false,
    drawerOpen,
    isJobDetailPage,
    hydrated,
  };
}

export async function waitForHydration(options: {
  doc?: Document;
  loc?: Pick<Location, 'href' | 'pathname'>;
  guards?: AuthAndChallengeGuardsConfig;
  waitForSelectors?: string[];
  timeoutMs?: number;
  scroll?: { steps?: number; intervalMs?: number };
  signal?: AbortSignal;
  isApiReady?: () => boolean;
  subscribeApiReady?: (cb: () => void) => () => void;
}): Promise<ContentGuardCheckResponse> {
  const doc = options.doc ?? document;
  const loc = options.loc ?? window.location;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
  const selectors = options.waitForSelectors ?? [];

  const checkNow = (): ContentGuardCheckResponse | null => {
    const probe = detectChallengeOrAuth(doc, loc, options.guards);
    if (probe.challengeDetected) {
      return {
        ok: false,
        errorCode: 'HUMAN_ACTION_REQUIRED',
        challengeType: probe.challengeType ?? 'unknown',
        reason: probe.challengeReason ?? 'Human verification required',
        url: probe.url,
      };
    }
    if (!probe.loggedIn) {
      return {
        ok: false,
        errorCode: 'HUMAN_ACTION_REQUIRED',
        challengeType: 'login',
        reason: 'Upwork session is not logged in',
        url: probe.url,
      };
    }
    let apiReady = false;
    if (options.isApiReady) {
      try {
        apiReady = Boolean(options.isApiReady());
      } catch {
        apiReady = false;
      }
    }
    if (selectors.length === 0 || matchesAnySelector(doc, selectors) || apiReady) {
      return {
        ok: true,
        loggedIn: probe.loggedIn,
        url: probe.url,
      };
    }
    return null;
  };

  if (options.signal?.aborted) {
    return {
      ok: false,
      errorCode: 'ABORTED',
      reason: 'Aborted before hydration check',
      url: loc.href || '',
    };
  }

  const immediate = checkNow();
  if (immediate) {
    if (
      immediate.ok &&
      options.scroll?.steps &&
      options.scroll.steps > 0 &&
      typeof window.scrollBy === 'function'
    ) {
      await runProgressiveScroll(
        options.scroll.steps,
        options.scroll.intervalMs ?? 120,
        options.signal,
      );
    }
    return immediate;
  }

  const waitResult = await new Promise<ContentGuardCheckResponse>((resolve) => {
    let settled = false;
    let unsubscribeApi: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;

    const finish = (res: ContentGuardCheckResponse) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      const unsub = unsubscribeApi;
      unsubscribeApi = undefined;
      if (unsub) {
        try {
          unsub();
        } catch {
          // ignore unsubscribe errors
        }
      }
      resolve(res);
    };

    const evaluate = () => {
      const res = checkNow();
      if (res) {
        finish(res);
      }
    };

    const onAbort = () => {
      finish({
        ok: false,
        errorCode: 'ABORTED',
        reason: 'Aborted by kill switch',
        url: loc.href || '',
      });
    };

    observer = new MutationObserver(evaluate);
    if (doc.body) {
      observer.observe(doc.body, { childList: true, subtree: true });
    }

    timer = setTimeout(() => {
      const probe = detectChallengeOrAuth(doc, loc, options.guards);
      if (probe.challengeDetected || !probe.loggedIn) {
        finish({
          ok: false,
          errorCode: 'HUMAN_ACTION_REQUIRED',
          challengeType: probe.challengeType ?? 'login',
          reason: probe.challengeReason ?? 'Human verification required',
          url: probe.url,
        });
        return;
      }
      finish({
        ok: false,
        errorCode: 'TIMEOUT',
        loggedIn: probe.loggedIn,
        reason: `Timed out waiting for selectors: ${selectors.join(', ')}`,
        url: loc.href || '',
      });
    }, timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.subscribeApiReady) {
      try {
        const unsub = options.subscribeApiReady(evaluate);
        if (typeof unsub === 'function') {
          if (settled) {
            try {
              unsub();
            } catch {
              // ignore unsubscribe errors
            }
          } else {
            unsubscribeApi = unsub;
          }
        }
      } catch {
        // ignore subscribe errors so MutationObserver / timeout fallback remains active
      }
    }

    if (!settled) {
      evaluate();
    }
  });

  if (
    waitResult.ok &&
    options.scroll?.steps &&
    options.scroll.steps > 0 &&
    typeof window.scrollBy === 'function'
  ) {
    await runProgressiveScroll(
      options.scroll.steps,
      options.scroll.intervalMs ?? 120,
      options.signal,
    );
  }
  return waitResult;
}

async function runProgressiveScroll(
  steps: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const count = Math.max(1, Math.min(steps, 10));
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) {
      return;
    }
    try {
      window.scrollBy({ top: 450, behavior: 'smooth' });
    } catch {
      // ignore in JSDOM
    }
    if (intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
