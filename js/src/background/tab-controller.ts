import { browser } from 'wxt/browser';
import { matchChallengeOrLoginUrl } from '../shared/challenge-url';
import type {
  BridgeErrorCode,
  ChallengeType,
  ContentGuardCheckRequest,
  ContentGuardCheckResponse,
} from '../shared/protocol';
import { DEFAULT_JITTER_RATIO, DEFAULT_PACING_SECONDS } from '../shared/schemas';
import { type AuthAndChallengeGuardsConfig, BUNDLED_SELECTORS } from '../shared/selectors';
import { jitterRatioItem, pacingSecondsItem } from '../shared/storage-items';
import { BridgeRpcError, HumanActionRequiredError, TaskAbortedError } from './ws-client';

export type TabMessenger = (
  tabId: number,
  message: ContentGuardCheckRequest | Record<string, unknown>,
) => Promise<unknown>;

export interface TabControllerOptions {
  tabMessenger?: TabMessenger;
  randomFn?: () => number;
  getPacingConfig?: () => Promise<{ pacingSeconds?: number; jitterRatio?: number }>;
  onChallengeDetected?: (detail: {
    challengeType: ChallengeType;
    reason: string;
    url?: string;
  }) => void;
  tabLoadTimeoutMs?: number;
}

interface QueuedTask {
  requestId: string;
  controller: AbortController;
  reject: (err: Error) => void;
  start: () => void;
}

const ALLOWED_UPWORK_ORIGIN = 'https://www.upwork.com';

function normalizeUrlForComparison(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl).toString();
  } catch {
    return rawUrl;
  }
}

export function isChallengeOrLoginUrl(
  rawUrl: string,
  guards?: AuthAndChallengeGuardsConfig,
): { matched: boolean; challengeType: ChallengeType; reason: string } {
  const result = matchChallengeOrLoginUrl(rawUrl, guards);
  if (!result.matched) {
    return { matched: false, challengeType: 'unknown', reason: '' };
  }
  if (result.category === 'login') {
    return {
      matched: true,
      challengeType: result.challengeType,
      reason: `Upwork redirected to login URL (${result.matchedPattern ?? ''})`,
    };
  }
  if (result.category === 'challenge') {
    return {
      matched: true,
      challengeType: result.challengeType,
      reason: `Verification challenge URL detected (${result.matchedPattern ?? ''})`,
    };
  }
  return {
    matched: true,
    challengeType: 'two_factor',
    reason: 'Two-factor authentication challenge URL detected',
  };
}

export function computeJitteredDelayMs(
  baseSeconds?: number,
  randomFn: () => number = Math.random,
  jitterRatio = DEFAULT_JITTER_RATIO,
): number {
  const effectiveBaseSeconds =
    typeof baseSeconds === 'number' && Number.isFinite(baseSeconds) && baseSeconds >= 0
      ? baseSeconds
      : DEFAULT_PACING_SECONDS;
  const clampedJitter = Math.min(0.9, Math.max(0, jitterRatio));
  const minMult = 1 - clampedJitter;
  const maxMult = 1 + clampedJitter;
  const mult = minMult + randomFn() * (maxMult - minMult);
  return Math.round(effectiveBaseSeconds * 1000 * mult);
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new TaskAbortedError('Task aborted'),
    );
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : new TaskAbortedError('Task aborted'),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultTabMessenger(tabId: number, message: unknown): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, message);
}

export class AutomationTabController {
  private readonly tabMessenger: TabMessenger;
  private readonly randomFn: () => number;
  private readonly getPacingConfig: NonNullable<TabControllerOptions['getPacingConfig']>;
  private readonly onChallengeDetected?: TabControllerOptions['onChallengeDetected'];
  private readonly tabLoadTimeoutMs: number;

  private automationTabId: number | null = null;
  private activeRequestId: string | null = null;
  private activeController: AbortController | null = null;
  private busy = false;
  private readonly pendingQueue: QueuedTask[] = [];
  private listenerAttached = false;

  constructor(options: TabControllerOptions = {}) {
    this.tabMessenger = options.tabMessenger ?? defaultTabMessenger;
    this.randomFn = options.randomFn ?? Math.random;
    this.getPacingConfig =
      options.getPacingConfig ??
      (async () => {
        const [pacingSeconds, jitterRatio] = await Promise.all([
          pacingSecondsItem.getValue().catch(() => DEFAULT_PACING_SECONDS),
          jitterRatioItem.getValue().catch(() => DEFAULT_JITTER_RATIO),
        ]);
        return { pacingSeconds, jitterRatio };
      });
    this.onChallengeDetected = options.onChallengeDetected;
    this.tabLoadTimeoutMs = options.tabLoadTimeoutMs ?? 30_000;
    this.attachTabRemovedListener();
  }

  private attachTabRemovedListener(): void {
    if (this.listenerAttached) {
      return;
    }
    try {
      browser.tabs.onRemoved.addListener((tabId) => {
        if (tabId === this.automationTabId) {
          this.automationTabId = null;
          if (this.activeController) {
            this.activeController.abort(new TaskAbortedError('Automation tab was closed'));
          }
        }
      });
      this.listenerAttached = true;
    } catch {
      // tabs.onRemoved may be unavailable outside extension/fakeBrowser context
    }
  }

  getState(): {
    automationTabId: number | null;
    busy: boolean;
    activeRequestId: string | null;
    queuedCount: number;
  } {
    return {
      automationTabId: this.automationTabId,
      busy: this.busy,
      activeRequestId: this.activeRequestId,
      queuedCount: this.pendingQueue.length,
    };
  }

  runSerialized<T>(requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();

    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        this.busy = true;
        this.activeRequestId = requestId;
        this.activeController = controller;

        Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) {
              throw controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new TaskAbortedError();
            }
            return fn(controller.signal);
          })
          .then(resolve, reject)
          .finally(() => {
            if (this.activeController === controller) {
              this.activeController = null;
              this.activeRequestId = null;
              this.busy = false;
            }
            const next = this.pendingQueue.shift();
            if (next) {
              next.start();
            }
          });
      };

      if (!this.busy) {
        execute();
        return;
      }

      this.pendingQueue.push({
        requestId,
        controller,
        reject,
        start: execute,
      });
    });
  }

  abortAll(reason = 'Aborted by kill switch'): {
    aborted: boolean;
    activeRequestId: string | null;
  } {
    const prevRequestId = this.activeRequestId;
    let aborted = false;

    if (this.activeController) {
      this.activeController.abort(new TaskAbortedError(reason));
      aborted = true;
    }

    while (this.pendingQueue.length > 0) {
      const queued = this.pendingQueue.shift();
      if (queued) {
        queued.controller.abort(new TaskAbortedError(reason));
        queued.reject(new TaskAbortedError(reason));
        aborted = true;
      }
    }

    return { aborted, activeRequestId: prevRequestId };
  }

  validateTargetUrl(rawUrl: string): string {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      throw new BridgeRpcError(
        'INVALID_PARAMS',
        'Automation tab URL must not contain credentials',
        -32602,
      );
    }
    if (parsed.origin !== ALLOWED_UPWORK_ORIGIN) {
      throw new BridgeRpcError(
        'INVALID_PARAMS',
        `Automation tab only allows ${ALLOWED_UPWORK_ORIGIN} URLs (got ${parsed.origin})`,
        -32602,
      );
    }
    return parsed.toString();
  }

  async ensureAutomationTab(
    initialUrl: string,
    signal?: AbortSignal,
    onBeforeInitialUpdate?: (tabId: number) => void,
  ): Promise<{ tabId: number; navigated: boolean; priorUrl?: string }> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TaskAbortedError();
    }

    const safeUrl = this.validateTargetUrl(initialUrl);

    if (this.automationTabId !== null) {
      try {
        const existing = await browser.tabs.get(this.automationTabId);
        if (existing?.id !== undefined) {
          return { tabId: existing.id, navigated: false, priorUrl: existing.url };
        }
      } catch {
        this.automationTabId = null;
      }
    }

    const created = await browser.tabs.create({ url: 'about:blank', active: false });
    if (created.id === undefined) {
      throw new BridgeRpcError(
        'TAB_NOT_FOUND' satisfies BridgeErrorCode,
        'Failed to create automation tab',
      );
    }
    this.automationTabId = created.id;
    // Allow browser / instrumentation hooks to attach to the new tab target before navigating.
    await sleepAbortable(250, signal);
    onBeforeInitialUpdate?.(created.id);
    await browser.tabs.update(created.id, { url: safeUrl });
    return { tabId: created.id, navigated: true, priorUrl: created.url ?? 'about:blank' };
  }

  async navigateAndWaitForHydration(
    url: string,
    options: {
      guards?: AuthAndChallengeGuardsConfig;
      waitForSelectors?: string[];
      timeoutMs?: number;
      scroll?: { steps?: number; intervalMs?: number };
      allowSelectorTimeout?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<{ tabId: number; url: string; loggedIn: boolean }> {
    const safeUrl = this.validateTargetUrl(url);
    const guards = options.guards ?? BUNDLED_SELECTORS.auth_and_challenge_guards;

    const preCheck = isChallengeOrLoginUrl(safeUrl, guards);
    if (preCheck.matched) {
      this.onChallengeDetected?.({
        challengeType: preCheck.challengeType,
        reason: preCheck.reason,
        url: safeUrl,
      });
      throw new HumanActionRequiredError(preCheck.reason, preCheck.challengeType, safeUrl);
    }

    let navObserver: ReturnType<AutomationTabController['beginTabCompleteWatch']> | null = null;
    let tabId: number;
    let finalUrl: string;
    try {
      const ensured = await this.ensureAutomationTab(safeUrl, signal, (newTabId) => {
        navObserver = this.beginTabCompleteWatch(newTabId, {
          targetUrl: safeUrl,
          priorUrl: 'about:blank',
          guards,
          signal,
        });
      });
      tabId = ensured.tabId;

      if (!ensured.navigated) {
        navObserver = this.beginTabCompleteWatch(tabId, {
          targetUrl: safeUrl,
          priorUrl: ensured.priorUrl,
          guards,
          signal,
        });
        await browser.tabs.update(tabId, { url: safeUrl });
      }

      if (!navObserver) {
        navObserver = this.beginTabCompleteWatch(tabId, {
          targetUrl: safeUrl,
          priorUrl: ensured.priorUrl,
          guards,
          signal,
        });
      }

      finalUrl = await navObserver.wait();
    } catch (err) {
      navObserver?.cancel();
      throw err;
    }

    const postUrlCheck = isChallengeOrLoginUrl(finalUrl, guards);
    if (postUrlCheck.matched) {
      this.onChallengeDetected?.({
        challengeType: postUrlCheck.challengeType,
        reason: postUrlCheck.reason,
        url: finalUrl,
      });
      throw new HumanActionRequiredError(postUrlCheck.reason, postUrlCheck.challengeType, finalUrl);
    }

    const guardResponse = await this.sendGuardCheckWithRetry(
      tabId,
      {
        type: 'CONTENT_CHECK_GUARDS',
        guards,
        waitForSelectors: options.waitForSelectors,
        timeoutMs: options.timeoutMs,
        scroll: options.scroll,
      },
      signal,
    );

    if (!guardResponse.ok) {
      if (guardResponse.errorCode === 'ABORTED') {
        throw new TaskAbortedError(guardResponse.reason || 'Task aborted');
      }
      if (guardResponse.errorCode === 'HUMAN_ACTION_REQUIRED') {
        const challengeType = guardResponse.challengeType ?? 'unknown';
        this.onChallengeDetected?.({
          challengeType,
          reason: guardResponse.reason,
          url: guardResponse.url,
        });
        throw new HumanActionRequiredError(guardResponse.reason, challengeType, guardResponse.url);
      }
      if (
        guardResponse.errorCode === 'TIMEOUT' &&
        options.allowSelectorTimeout &&
        !signal?.aborted
      ) {
        return {
          tabId,
          url: guardResponse.url || finalUrl,
          loggedIn: Boolean(guardResponse.loggedIn),
        };
      }
      throw new BridgeRpcError(guardResponse.errorCode, guardResponse.reason);
    }

    return {
      tabId,
      url: guardResponse.url,
      loggedIn: guardResponse.loggedIn,
    };
  }

  async pace(signal?: AbortSignal, overrideBaseSeconds?: number): Promise<number> {
    let baseSeconds = overrideBaseSeconds;
    let jitterRatio = DEFAULT_JITTER_RATIO;

    if (baseSeconds === undefined) {
      const cfg = await this.getPacingConfig();
      baseSeconds =
        typeof cfg.pacingSeconds === 'number' && Number.isFinite(cfg.pacingSeconds)
          ? cfg.pacingSeconds
          : DEFAULT_PACING_SECONDS;
      if (typeof cfg.jitterRatio === 'number' && Number.isFinite(cfg.jitterRatio)) {
        jitterRatio = cfg.jitterRatio;
      }
    } else {
      // Enforce >= 4.5s floor for programmatic callers without explicit user/test config override
      baseSeconds = Math.max(DEFAULT_PACING_SECONDS, baseSeconds);
    }

    const delayMs = computeJitteredDelayMs(baseSeconds, this.randomFn, jitterRatio);
    await sleepAbortable(delayMs, signal);
    return delayMs;
  }

  private beginTabCompleteWatch(
    tabId: number,
    options: {
      targetUrl: string;
      priorUrl?: string;
      guards?: AuthAndChallengeGuardsConfig;
      signal?: AbortSignal;
    },
  ): { wait: () => Promise<string>; cancel: () => void } {
    const { targetUrl, priorUrl, guards, signal } = options;
    const normTarget = normalizeUrlForComparison(targetUrl);
    const normPrior = normalizeUrlForComparison(priorUrl);

    let settled = false;
    let sawLoading = false;
    let sawComplete = false;
    let completedUrl = '';
    let earlyError: Error | null = null;
    let waitResolve: ((url: string) => void) | null = null;
    let waitReject: ((err: Error) => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      signal?.removeEventListener('abort', onAbort);
      try {
        browser.tabs.onUpdated.removeListener(onUpdated);
      } catch {
        // ignore
      }
    };

    const finishSuccess = (url: string) => {
      if (settled) return;
      settled = true;
      sawComplete = true;
      completedUrl = url;
      cleanup();
      waitResolve?.(url);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      earlyError = err;
      cleanup();
      waitReject?.(err);
    };

    const onAbort = () => {
      finishError(
        signal?.reason instanceof Error
          ? signal.reason
          : new TaskAbortedError('Navigation aborted'),
      );
    };

    const onUpdated = (
      updatedTabId: number,
      changeInfo: { status?: string; url?: string },
      tab: { url?: string },
    ) => {
      if (updatedTabId !== tabId || settled) return;
      const observedUrl = changeInfo.url ?? tab?.url ?? '';
      const normObserved = normalizeUrlForComparison(observedUrl);

      if (changeInfo.status === 'loading') {
        sawLoading = true;
      }

      const isStalePriorUrl = Boolean(
        normPrior &&
          normPrior !== normTarget &&
          normObserved === normPrior &&
          !changeInfo.url &&
          !(changeInfo.status === 'complete' && sawLoading),
      );

      if (observedUrl && !isStalePriorUrl) {
        const check = isChallengeOrLoginUrl(observedUrl, guards);
        if (check.matched) {
          this.onChallengeDetected?.({
            challengeType: check.challengeType,
            reason: check.reason,
            url: observedUrl,
          });
          finishError(new HumanActionRequiredError(check.reason, check.challengeType, observedUrl));
          return;
        }
      }

      if (changeInfo.status === 'complete') {
        if (normObserved === 'about:blank' && normTarget !== 'about:blank') {
          return;
        }
        if (normPrior && normPrior !== normTarget && normObserved === normPrior && !sawLoading) {
          return;
        }
        finishSuccess(observedUrl);
      }
    };

    if (signal?.aborted) {
      finishError(signal.reason instanceof Error ? signal.reason : new TaskAbortedError());
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        browser.tabs.onUpdated.addListener(onUpdated);
      } catch {
        // ignore
      }
    }

    return {
      cancel: () => {
        if (!settled) {
          settled = true;
          cleanup();
        }
      },
      wait: () =>
        this.waitForTabComplete(tabId, {
          targetUrl,
          priorUrl,
          guards,
          signal,
          getState: () => ({ settled, sawLoading, sawComplete, completedUrl, earlyError }),
          attachWaiters: (resolve, reject) => {
            waitResolve = resolve;
            waitReject = reject;
            timeoutId = setTimeout(() => {
              finishError(
                new BridgeRpcError(
                  'TIMEOUT',
                  `Tab ${tabId} load timed out after ${this.tabLoadTimeoutMs}ms`,
                ),
              );
            }, this.tabLoadTimeoutMs);
          },
          finishSuccess,
          finishError,
        }),
    };
  }

  private async waitForTabComplete(
    tabId: number,
    options: {
      targetUrl: string;
      priorUrl?: string;
      guards?: AuthAndChallengeGuardsConfig;
      signal?: AbortSignal;
      getState: () => {
        settled: boolean;
        sawLoading: boolean;
        sawComplete: boolean;
        completedUrl: string;
        earlyError: Error | null;
      };
      attachWaiters: (resolve: (url: string) => void, reject: (err: Error) => void) => void;
      finishSuccess: (url: string) => void;
      finishError: (err: Error) => void;
    },
  ): Promise<string> {
    const {
      targetUrl,
      priorUrl,
      guards,
      signal,
      getState,
      attachWaiters,
      finishSuccess,
      finishError,
    } = options;
    const normTarget = normalizeUrlForComparison(targetUrl);
    const normPrior = normalizeUrlForComparison(priorUrl);

    if (signal?.aborted) {
      const err = signal.reason instanceof Error ? signal.reason : new TaskAbortedError();
      finishError(err);
      throw err;
    }

    const preState = getState();
    if (preState.earlyError) {
      throw preState.earlyError;
    }
    if (preState.settled && preState.sawComplete) {
      return preState.completedUrl;
    }

    const current = await browser.tabs.get(tabId).catch(() => null);
    const postGetState = getState();
    if (postGetState.earlyError) {
      throw postGetState.earlyError;
    }
    if (postGetState.settled && postGetState.sawComplete) {
      return postGetState.completedUrl;
    }

    const normCurrent = normalizeUrlForComparison(current?.url);
    const isStaleBlank = normCurrent === 'about:blank' && normTarget !== 'about:blank';
    const isStalePrior = Boolean(
      normPrior &&
        normPrior !== normTarget &&
        normCurrent === normPrior &&
        !(postGetState.sawLoading && postGetState.sawComplete),
    );
    const isStillLoading = postGetState.sawLoading && !postGetState.sawComplete;

    if (current?.url && !isStalePrior) {
      const check = isChallengeOrLoginUrl(current.url, guards);
      if (check.matched) {
        this.onChallengeDetected?.({
          challengeType: check.challengeType,
          reason: check.reason,
          url: current.url,
        });
        const err = new HumanActionRequiredError(check.reason, check.challengeType, current.url);
        finishError(err);
        throw err;
      }
    }

    if (current?.status === 'complete' && current.url) {
      if (!isStaleBlank && !isStalePrior && !isStillLoading) {
        finishSuccess(current.url);
        return current.url;
      }
    }

    return new Promise<string>((resolve, reject) => {
      attachWaiters(resolve, reject);
    });
  }

  private async sendGuardCheckWithRetry(
    tabId: number,
    message: ContentGuardCheckRequest,
    signal?: AbortSignal,
  ): Promise<ContentGuardCheckResponse> {
    const maxAttempts = 5;
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new TaskAbortedError();
      }
      try {
        const reply = (await raceWithAbort(
          this.tabMessenger(tabId, message),
          signal,
        )) as ContentGuardCheckResponse;
        if (reply && typeof reply === 'object' && 'ok' in reply) {
          return reply;
        }
        lastError = new Error('Empty response from content guard check');
      } catch (err) {
        if (err instanceof TaskAbortedError || signal?.aborted) {
          throw err instanceof TaskAbortedError
            ? err
            : signal?.reason instanceof Error
              ? signal.reason
              : new TaskAbortedError();
        }
        lastError = err;
      }
      if (i < maxAttempts - 1) {
        await sleepAbortable(150, signal);
      }
    }
    throw new BridgeRpcError(
      'TAB_NOT_FOUND',
      lastError instanceof Error ? lastError.message : 'Content script did not respond',
    );
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new TaskAbortedError('Task aborted'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new TaskAbortedError('Task aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
