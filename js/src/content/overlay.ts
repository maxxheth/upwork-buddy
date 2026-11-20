import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from 'wxt/utils/content-script-ui/shadow-root';
import { UpworkBuddy } from '../main';
import {
  type ContentAuditSelectorsRequest,
  type ContentGuardCheckRequest,
  type ContentMessagesDraftRequest,
  type ContentMessagesGetRequest,
  type ContentMessagesListRequest,
  type ContentMessagesSendRequest,
  type ContentProposalFillRequest,
  type ContentProposalSubmitRequest,
  type ContentProposalsSyncRequest,
  type ContentScrapeDetailRequest,
  type ContentScrapeSearchRequest,
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveTapPayload,
  type RuntimeStatusSnapshot,
  type UpWorkPageBlueprint,
} from '../shared/protocol';
import { ProposalFillParamsSchema, ProposalSubmitParamsSchema } from '../shared/schemas';
import { BUNDLED_SELECTORS, loadActiveSelectors, type SelectorConfig } from '../shared/selectors';
import { extractJobDetail } from './adapters/detail-adapter';
import {
  buildPageBlueprint,
  computeOverallAuditStatus,
  DriftAuditor,
} from './adapters/drift-auditor';
import {
  extractMessageRooms,
  extractMessageThread,
  fillMessageComposer,
  sendMessageFromComposer,
} from './adapters/messages-adapter';
import {
  extractProposalsList,
  fillProposalForm,
  submitProposalForm,
} from './adapters/proposal-adapter';
import { extractSearchListings } from './adapters/search-adapter';
import { detectChallengeOrAuth, waitForHydration } from './guards';

export { detectChallengeOrAuth, waitForHydration };

function isVisibleDomElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const style = (el as HTMLElement).style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

async function resolveContentSelectors(explicit?: SelectorConfig): Promise<SelectorConfig> {
  if (explicit) {
    return explicit;
  }
  try {
    return await loadActiveSelectors();
  } catch {
    return BUNDLED_SELECTORS;
  }
}

export async function mountUpworkOverlay(
  ctx: ContentScriptContext,
): Promise<ShadowRootContentScriptUi<UpworkBuddy>> {
  let buddyInstance: UpworkBuddy | null = null;
  let activeAbortController: AbortController | null = null;
  const recentPassivePayloads: PassiveTapPayload[] = [];

  const onPassiveTap = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const rawDetail = customEvent.detail;
    if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
      return;
    }
    const raw = rawDetail as Record<string, unknown>;
    const kind = raw.kind === 'graphql' || raw.kind === 'xhr' ? raw.kind : null;
    const url = typeof raw.url === 'string' ? raw.url : null;
    const capturedAt = typeof raw.capturedAt === 'string' ? raw.capturedAt : null;
    if (!kind || !url || !capturedAt) {
      return;
    }
    const operationName = typeof raw.operationName === 'string' ? raw.operationName : undefined;

    let serializedData: string;
    let safeData: unknown;
    try {
      serializedData = JSON.stringify(raw.data ?? null);
      if (serializedData === undefined) {
        serializedData = 'null';
      }
      safeData = JSON.parse(serializedData);
    } catch {
      return;
    }

    const detail: PassiveTapPayload = {
      kind,
      url,
      ...(operationName !== undefined ? { operationName } : {}),
      data: safeData,
      capturedAt,
    };

    const isDuplicate = recentPassivePayloads.some((p) => {
      if (
        p.capturedAt !== detail.capturedAt ||
        p.kind !== detail.kind ||
        p.url !== detail.url ||
        (p.operationName ?? '') !== (detail.operationName ?? '')
      ) {
        return false;
      }
      try {
        return JSON.stringify(p.data) === serializedData;
      } catch {
        return false;
      }
    });
    if (isDuplicate) {
      return;
    }

    recentPassivePayloads.unshift(detail);
    if (recentPassivePayloads.length > 25) {
      recentPassivePayloads.length = 25;
    }

    void browser.runtime
      .sendMessage({
        kind: detail.kind,
        url: detail.url,
        ...(detail.operationName !== undefined ? { operationName: detail.operationName } : {}),
        data: detail.data,
        capturedAt: detail.capturedAt,
        type: 'PASSIVE_TAP_PAYLOAD',
      })
      .catch(() => undefined);
  };

  window.addEventListener(PASSIVE_TAP_EVENT, onPassiveTap);
  window.dispatchEvent(new CustomEvent(PASSIVE_TAP_READY_EVENT));

  const messageListener = (
    rawMessage: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (typeof rawMessage !== 'object' || rawMessage === null) {
      return undefined;
    }
    const msg = rawMessage as Record<string, unknown>;
    const type = msg.type;

    if (type === 'CONTENT_PROBE_SESSION') {
      sendResponse(detectChallengeOrAuth(document, window.location));
      return false;
    }

    if (type === 'CONTENT_CHECK_PROPOSAL_CONFIRMATION') {
      const probe = detectChallengeOrAuth(document, window.location);
      if (probe.challengeDetected || !probe.loggedIn) {
        sendResponse({
          ok: false,
          challengeDetected: true,
          challengeType: probe.challengeType ?? 'login',
          challengeReason: probe.challengeReason ?? 'Upwork authentication required',
          url: probe.url,
        });
        return false;
      }
      const errEl = document.querySelector("[data-test='form-validation-error']");
      const validationError = isVisibleDomElement(errEl) ? (errEl?.textContent ?? '').trim() : '';
      const bannerEl = document.querySelector(
        "[data-test='proposal-submitted-banner'], [data-test='proposal-confirmation-page']",
      );
      const confirmed = isVisibleDomElement(bannerEl);
      sendResponse({
        ok: true,
        confirmed,
        validationError: validationError || undefined,
        url: window.location.href,
      });
      return false;
    }

    if (type === 'CONTENT_KILL_ABORT') {
      activeAbortController?.abort();
      activeAbortController = null;
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'CONTENT_CHECK_GUARDS') {
      const req = msg as unknown as ContentGuardCheckRequest;
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      void waitForHydration({
        guards: req.guards,
        waitForSelectors: req.waitForSelectors,
        timeoutMs: req.timeoutMs,
        scroll: req.scroll,
        signal: activeAbortController.signal,
      }).then((res) => sendResponse(res));
      return true;
    }

    if (type === 'CONTENT_CHECK_HYDRATION') {
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      void waitForHydration({
        waitForSelectors: typeof msg.selector === 'string' ? [msg.selector] : undefined,
        timeoutMs: typeof msg.timeoutMs === 'number' ? msg.timeoutMs : undefined,
        signal: activeAbortController.signal,
      }).then((res) => sendResponse(res));
      return true;
    }

    if (type === 'CONTENT_SCRAPE_SEARCH') {
      const req = msg as unknown as ContentScrapeSearchRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const result = extractSearchListings(document, {
          source: req.source,
          query: req.query,
          selectors,
          passivePayloads: [...recentPassivePayloads],
          location: window.location,
        });
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'CONTENT_SCRAPE_DETAIL') {
      const req = msg as unknown as ContentScrapeDetailRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const result = extractJobDetail(document, {
          url: req.url ?? window.location.href,
          requireDrawer: req.requireDrawer,
          selectors,
          passivePayloads: [...recentPassivePayloads],
          location: window.location,
        });
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'CONTENT_AUDIT_SELECTORS') {
      const req = msg as unknown as ContentAuditSelectorsRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const probe = detectChallengeOrAuth(
          document,
          window.location,
          selectors.auth_and_challenge_guards,
        );
        if (probe.challengeDetected) {
          sendResponse({
            ok: false,
            errorCode: 'HUMAN_ACTION_REQUIRED',
            challengeType: probe.challengeType ?? 'unknown',
            reason: probe.challengeReason ?? 'Verification challenge detected',
            url: probe.url,
          });
          return;
        }
        const blueprint = buildPageBlueprint(document, {
          url: window.location.href,
          isAuthenticated: req.isAuthenticated ?? probe.loggedIn,
          capturedXhrEndpoints: req.capturedXhrEndpoints ?? recentPassivePayloads.map((p) => p.url),
        });
        const baseline = (req.baseline ?? null) as UpWorkPageBlueprint | null;
        const report = new DriftAuditor(blueprint, document, selectors, baseline).audit(req.view);
        sendResponse({
          ok: true,
          report,
          blueprint,
          overall_status: computeOverallAuditStatus(report),
        });
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSAL_FILL') {
      const req = msg as unknown as ContentProposalFillRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const parsed = ProposalFillParamsSchema.safeParse(req.params);
        if (!parsed.success) {
          sendResponse({
            ok: false,
            errorCode: 'INVALID_PARAMS',
            reason: `Invalid proposal fill params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          });
          return;
        }
        sendResponse(fillProposalForm(document, parsed.data, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSAL_SUBMIT') {
      const req = msg as unknown as ContentProposalSubmitRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const parsed = ProposalSubmitParamsSchema.safeParse(req.params);
        if (!parsed.success) {
          sendResponse({
            ok: false,
            errorCode: 'INVALID_PARAMS',
            reason: `Invalid proposal submit params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          });
          return;
        }
        sendResponse(submitProposalForm(document, parsed.data, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSALS_SYNC') {
      const req = msg as unknown as ContentProposalsSyncRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractProposalsList(document, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_LIST') {
      const req = msg as unknown as ContentMessagesListRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractMessageRooms(document, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_GET') {
      const req = msg as unknown as ContentMessagesGetRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractMessageThread(document, req.room_id, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_DRAFT') {
      const req = msg as unknown as ContentMessagesDraftRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(fillMessageComposer(document, req.body, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_SEND') {
      const req = msg as unknown as ContentMessagesSendRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(sendMessageFromComposer(document, req.body, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_EXTRACT_AND_ANALYZE') {
      const saveOnly = msg.action === 'save';
      void (async () => {
        if (buddyInstance) {
          await buddyInstance.triggerCapture(saveOnly);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Overlay not mounted' });
        }
      })();
      return true;
    }

    return undefined;
  };

  browser.runtime.onMessage.addListener(messageListener);

  ctx.onInvalidated(() => {
    window.removeEventListener(PASSIVE_TAP_EVENT, onPassiveTap);
    browser.runtime.onMessage.removeListener(messageListener);
    activeAbortController?.abort();
    activeAbortController = null;
  });

  return createShadowRootUi(ctx, {
    name: 'upwork-buddy-ui',
    position: 'overlay',
    alignment: 'bottom-right',
    zIndex: 2147483640,
    isolateEvents: ['keydown', 'keyup', 'keypress'],
    onMount(uiContainer, shadow) {
      const buddy = new UpworkBuddy({
        uiRoot: uiContainer,
        styleRoot: shadow,
        skipLegacyStyleTag: true,
        alwaysShowToolbar: true,
        ctx,
      });
      buddyInstance = buddy;

      void browser.runtime
        .sendMessage({ type: 'GET_RUNTIME_STATUS' })
        .then((res) => {
          const status = res as Partial<RuntimeStatusSnapshot> | undefined;
          if (status && typeof status === 'object') {
            buddy.setToolbarStatus(
              Boolean(status.wsConnected),
              status.policyMode ?? 'confirm_in_ui',
              Boolean(status.humanActionRequired),
            );
          }
        })
        .catch(() => undefined);

      return buddy;
    },
    onRemove(buddy) {
      buddy?.destroy();
      buddyInstance = null;
    },
  });
}
