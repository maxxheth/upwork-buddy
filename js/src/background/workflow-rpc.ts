import { browser } from 'wxt/browser';
import type { ScrapedMessageEntry, ScrapedMessageRoom } from '../content/adapters/messages-adapter';
import type { SyncedProposalRow } from '../content/adapters/proposal-adapter';
import type { ActivityLogEntry, BridgeErrorCode, ChallengeType } from '../shared/protocol';
import {
  MessagesDraftParamsSchema,
  MessagesGetParamsSchema,
  MessagesListParamsSchema,
  MessagesSendParamsSchema,
  ProposalFillParamsSchema,
  ProposalSubmitParamsSchema,
  type ProposalVerificationSnapshot,
} from '../shared/schemas';
import type { SelectorConfig } from '../shared/selectors';
import { unreadPollEnabledItem, unreadPollMinutesItem } from '../shared/storage-items';
import type { ProgressCallback } from './discovery-rpc';
import {
  type AutomationTabController,
  isChallengeOrLoginUrl,
  sleepAbortable,
} from './tab-controller';
import { BridgeRpcError, HumanActionRequiredError } from './ws-client';

export const UNREAD_POLL_ALARM_NAME = 'upwork-buddy-messages-poll';

export interface WorkflowRpcDeps {
  tabController: AutomationTabController;
  proxyFetch: (path: string, init?: RequestInit) => Promise<Response>;
  getSelectors: (forceRefresh?: boolean) => Promise<SelectorConfig>;
  sendTabMessage?: (tabId: number, message: unknown) => Promise<unknown>;
  getTab?: (tabId: number) => Promise<{ id?: number; url?: string } | null>;
  recordActivity?: (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => void;
  onUnreadUpdated?: (totalUnread: number) => void;
  confirmPollMaxAttempts?: number;
  confirmPollIntervalMs?: number;
}

interface ContentProposalReply {
  ok: boolean;
  clicked?: boolean;
  snapshot?: ProposalVerificationSnapshot;
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentProposalsSyncReply {
  ok: boolean;
  proposals?: SyncedProposalRow[];
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentMessagesListReply {
  ok: boolean;
  rooms?: ScrapedMessageRoom[];
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentMessagesGetReply {
  ok: boolean;
  room_id?: string;
  upwork_room_id?: string;
  client_name?: string;
  client_company?: string;
  job_title?: string;
  upwork_job_id?: string;
  unread_count?: number;
  messages?: ScrapedMessageEntry[];
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentComposerReply {
  ok: boolean;
  prefilled?: boolean;
  clicked?: boolean;
  body?: string;
  prior_message_count?: number;
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

function defaultSendTabMessage(tabId: number, message: unknown): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, message);
}

async function defaultGetTab(tabId: number): Promise<{ id?: number; url?: string } | null> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    return null;
  }
}

function normalizeUpworkIdToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('~') ? trimmed : `~${trimmed}`;
}

function resolveApplyTargetUrl(upworkJobId: string, applyUrl?: string): string {
  if (applyUrl && applyUrl.trim()) {
    return applyUrl.trim();
  }
  const id = normalizeUpworkIdToken(upworkJobId);
  return `https://www.upwork.com/nx/proposals/job/${encodeURIComponent(id)}/apply/`;
}

function resolveRoomTargetUrl(roomId: string): string {
  return `https://www.upwork.com/ab/messages/rooms/${encodeURIComponent(roomId.trim())}`;
}

function urlsMatchPath(currentUrl: string | undefined, expectedUrl: string): boolean {
  if (!currentUrl) return false;
  try {
    const a = new URL(currentUrl);
    const b = new URL(expectedUrl);
    return (
      a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

function throwContentError(
  reply:
    | {
        errorCode?: BridgeErrorCode;
        challengeType?: ChallengeType;
        reason?: string;
        url?: string;
      }
    | undefined,
  fallbackMessage: string,
  fallbackUrl?: string,
): never {
  if (!reply) {
    throw new BridgeRpcError('INTERNAL_ERROR', fallbackMessage);
  }
  if (reply.errorCode === 'HUMAN_ACTION_REQUIRED') {
    throw new HumanActionRequiredError(
      reply.reason ?? 'Human verification required',
      reply.challengeType ?? 'unknown',
      reply.url ?? fallbackUrl,
    );
  }
  const code = reply.errorCode ?? 'INTERNAL_ERROR';
  const msg = reply.reason ?? fallbackMessage;
  throw new BridgeRpcError(code, msg.includes(code) ? msg : `${code}: ${msg}`);
}

export async function executeProposalFill(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `proposal-fill-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = ProposalFillParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid proposal.fill params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const params = parsed.data;
  const targetUrl = resolveApplyTargetUrl(params.upwork_job_id, params.apply_url);
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 3, `Opening apply page for ${params.upwork_job_id}`);
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectors.auth_and_challenge_guards,
        waitForSelectors: [
          "textarea[data-test='cover-letter-textarea']",
          "textarea[aria-labelledby*='cover_letter']",
          "[data-test='already-applied-banner']",
          'h1',
        ],
        timeoutMs: 15_000,
      },
      signal,
    );

    sendProgress?.('fill', 2, 3, 'Filling proposal form fields');
    const reply = (await sendTab(nav.tabId, {
      type: 'CONTENT_PROPOSAL_FILL',
      params,
      selectorConfig: selectors,
    })) as ContentProposalReply | undefined;

    if (!reply || !reply.ok || !reply.snapshot) {
      throwContentError(reply, 'Proposal fill failed', targetUrl);
    }

    sendProgress?.('verify', 3, 3, 'Captured pre-submit verification snapshot');
    deps.recordActivity?.({
      source: 'tab',
      action: 'proposal.fill',
      detail: `Filled proposal for ${params.upwork_job_id} (${reply.snapshot.total_connects ?? reply.snapshot.connects_cost ?? 0} connects)`,
      status: 'ok',
    });

    return {
      ...reply.snapshot,
      ok: true,
    };
  });
}

export async function executeProposalSubmit(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `proposal-submit-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = ProposalSubmitParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid proposal.submit params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const params = parsed.data;
  const targetUrl = resolveApplyTargetUrl(params.upwork_job_id, params.apply_url);
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const getTab = deps.getTab ?? defaultGetTab;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    const currentTabId = deps.tabController.getState().automationTabId;
    let tabId: number | null = null;
    if (currentTabId !== null) {
      const existing = await getTab(currentTabId);
      if (existing?.id !== undefined && urlsMatchPath(existing.url, targetUrl)) {
        tabId = existing.id;
      }
    }

    if (tabId === null) {
      sendProgress?.('navigate', 1, 3, `Navigating to apply page for ${params.upwork_job_id}`);
      const nav = await deps.tabController.navigateAndWaitForHydration(
        targetUrl,
        {
          guards: selectors.auth_and_challenge_guards,
          waitForSelectors: [
            "textarea[data-test='cover-letter-textarea']",
            "textarea[aria-labelledby*='cover_letter']",
            "[data-test='already-applied-banner']",
            'h1',
          ],
          timeoutMs: 15_000,
        },
        signal,
      );
      tabId = nav.tabId;
    }

    sendProgress?.('submit', 2, 3, 'Submitting proposal form');
    const reply = (await sendTab(tabId, {
      type: 'CONTENT_PROPOSAL_SUBMIT',
      params,
      selectorConfig: selectors,
    })) as ContentProposalReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, 'Proposal submit failed', targetUrl);
    }

    // Poll up to ~6s (40 * 150ms) for positive confirmation (redirect URL or banner) or validation error
    const maxAttempts = deps.confirmPollMaxAttempts ?? 40;
    const intervalMs = deps.confirmPollIntervalMs ?? 150;
    let confirmationUrl = '';
    let confirmed = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      }
      const tabInfo = await getTab(tabId);
      const tabUrl = tabInfo?.url ?? '';
      if (tabUrl) {
        const urlCheck = isChallengeOrLoginUrl(tabUrl, selectors.auth_and_challenge_guards);
        if (urlCheck.matched) {
          throw new HumanActionRequiredError(urlCheck.reason, urlCheck.challengeType, tabUrl);
        }
      }
      if (
        tabUrl.includes('/nx/proposals/confirmation') ||
        tabUrl.includes('/nx/proposals/submitted')
      ) {
        confirmationUrl = tabUrl;
        confirmed = true;
        break;
      }

      const check = (await sendTab(tabId, {
        type: 'CONTENT_CHECK_PROPOSAL_CONFIRMATION',
      }).catch(() => null)) as {
        challengeDetected?: boolean;
        challengeType?: ChallengeType;
        challengeReason?: string;
        confirmed?: boolean;
        confirmation_banner?: boolean;
        validationError?: string;
        validation_error?: string;
        url?: string;
      } | null;

      if (check?.challengeDetected) {
        throw new HumanActionRequiredError(
          check.challengeReason ?? 'Challenge detected after submit',
          check.challengeType ?? 'unknown',
          check.url ?? tabUrl,
        );
      }

      const validationErr = (check?.validationError ?? check?.validation_error ?? '').trim();
      if (validationErr) {
        throw new BridgeRpcError(
          'FORM_VALIDATION_ERROR',
          `FORM_VALIDATION_ERROR: ${validationErr}`,
        );
      }

      if (check?.confirmed || check?.confirmation_banner) {
        confirmationUrl = check.url || tabUrl || targetUrl;
        confirmed = true;
        break;
      }

      if (!check || (!('confirmed' in check) && !('challengeDetected' in check))) {
        const probe = (await sendTab(tabId, { type: 'CONTENT_PROBE_SESSION' }).catch(
          () => null,
        )) as {
          challengeDetected?: boolean;
          challengeType?: ChallengeType;
          challengeReason?: string;
          confirmed?: boolean;
          validationError?: string;
          url?: string;
        } | null;
        if (probe?.challengeDetected) {
          throw new HumanActionRequiredError(
            probe.challengeReason ?? 'Challenge detected after submit',
            probe.challengeType ?? 'unknown',
            probe.url ?? tabUrl,
          );
        }
        if (probe?.validationError?.trim()) {
          throw new BridgeRpcError(
            'FORM_VALIDATION_ERROR',
            `FORM_VALIDATION_ERROR: ${probe.validationError.trim()}`,
          );
        }
        if (probe?.confirmed) {
          confirmationUrl = probe.url || tabUrl || targetUrl;
          confirmed = true;
          break;
        }
      }

      if (attempt < maxAttempts - 1 && intervalMs > 0) {
        await sleepAbortable(intervalMs, signal);
      }
    }

    if (!confirmed) {
      throw new BridgeRpcError(
        'PROPOSAL_SUBMIT_UNCONFIRMED',
        `PROPOSAL_SUBMIT_UNCONFIRMED: Proposal submission was not confirmed within polling window (tab stayed at ${targetUrl})`,
      );
    }

    sendProgress?.('confirmed', 3, 3, 'Proposal submitted');
    deps.recordActivity?.({
      source: 'tab',
      action: 'proposal.submit',
      detail: `Submitted proposal for ${params.upwork_job_id}`,
      status: 'ok',
    });

    return {
      ok: true,
      submitted: true,
      upwork_proposal_url: confirmationUrl,
      confirmation_url: confirmationUrl,
      snapshot: reply.snapshot,
    };
  });
}

export async function executeProposalsSync(
  deps: WorkflowRpcDeps,
  _rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `proposals-sync-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const targetUrl = 'https://www.upwork.com/nx/proposals/';

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 2, 'Opening Upwork proposals list');
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectors.auth_and_challenge_guards,
        waitForSelectors: selectors.views.proposals_list?.container_selectors ?? [
          "[data-test='proposal-row']",
          'main',
        ],
        timeoutMs: 15_000,
      },
      signal,
    );

    const reply = (await sendTab(nav.tabId, {
      type: 'CONTENT_PROPOSALS_SYNC',
      selectorConfig: selectors,
    })) as ContentProposalsSyncReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, 'Failed to scrape proposals list', targetUrl);
    }

    const proposals = reply.proposals ?? [];
    sendProgress?.('sync', 2, 2, `Synced ${proposals.length} proposal(s)`);
    deps.recordActivity?.({
      source: 'tab',
      action: 'proposals.sync',
      detail: `Synced ${proposals.length} proposal(s)`,
      status: 'ok',
    });

    return {
      ok: true,
      proposals,
    };
  });
}

export async function executeMessagesList(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `messages-list-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = MessagesListParamsSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    throw new BridgeRpcError('INVALID_PARAMS', 'Invalid messages.list params', -32602);
  }
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const targetUrl = 'https://www.upwork.com/ab/messages/rooms';

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 2, 'Opening Upwork messages rooms');
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectors.auth_and_challenge_guards,
        waitForSelectors: selectors.views.messages_rooms?.container_selectors ?? [
          "[data-test='room-item']",
          'main',
        ],
        timeoutMs: 15_000,
      },
      signal,
    );

    const reply = (await sendTab(nav.tabId, {
      type: 'CONTENT_MESSAGES_LIST',
      selectorConfig: selectors,
    })) as ContentMessagesListReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, 'Failed to list message rooms', targetUrl);
    }

    const rooms = reply.rooms ?? [];
    const totalUnread = rooms.reduce((sum, r) => sum + (r.unread_count || 0), 0);
    deps.onUnreadUpdated?.(totalUnread);

    sendProgress?.('list', 2, 2, `Listed ${rooms.length} room(s) (${totalUnread} unread)`);
    deps.recordActivity?.({
      source: 'tab',
      action: 'messages.list',
      detail: `Listed ${rooms.length} room(s), ${totalUnread} unread`,
      status: 'ok',
    });

    return {
      ok: true,
      rooms,
      total_unread: totalUnread,
    };
  });
}

export async function executeMessagesGet(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `messages-get-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = MessagesGetParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid messages.get params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const { room_id } = parsed.data;
  const targetUrl = resolveRoomTargetUrl(room_id);
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 2, `Opening conversation ${room_id}`);
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectors.auth_and_challenge_guards,
        waitForSelectors: [
          "[data-test='message-thread-page']",
          "[data-test='room-not-found']",
          ...(selectors.views.messages_thread?.container_selectors ?? []),
          'main',
        ],
        timeoutMs: 15_000,
      },
      signal,
    );

    const reply = (await sendTab(nav.tabId, {
      type: 'CONTENT_MESSAGES_GET',
      room_id,
      selectorConfig: selectors,
    })) as ContentMessagesGetReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, `Failed to read room ${room_id}`, targetUrl);
    }

    sendProgress?.('read', 2, 2, `Read ${reply.messages?.length ?? 0} message(s)`);
    deps.recordActivity?.({
      source: 'tab',
      action: 'messages.get',
      detail: `Read ${reply.messages?.length ?? 0} message(s) in ${room_id}`,
      status: 'ok',
    });

    return {
      ok: true,
      room_id: reply.room_id ?? room_id,
      upwork_room_id: reply.upwork_room_id ?? room_id,
      client_name: reply.client_name ?? '',
      client_company: reply.client_company ?? '',
      job_title: reply.job_title ?? '',
      upwork_job_id: reply.upwork_job_id ?? '',
      ...(typeof reply.unread_count === 'number' ? { unread_count: reply.unread_count } : {}),
      messages: reply.messages ?? [],
    };
  });
}

export async function executeMessagesDraft(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `messages-draft-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = MessagesDraftParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid messages.draft params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const { room_id, body, prefill_composer } = parsed.data;
  if (prefill_composer === false) {
    return {
      ok: true,
      prefilled: false,
      room_id,
      body,
    };
  }

  const targetUrl = resolveRoomTargetUrl(room_id);
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 2, `Opening room ${room_id} composer`);
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectors.auth_and_challenge_guards,
        waitForSelectors: [
          "textarea[data-test='composer-textarea']",
          "[data-test='room-not-found']",
          ...(selectors.views.messages_thread?.fields.composer_input?.selectors ?? []),
          'main',
        ],
        timeoutMs: 15_000,
      },
      signal,
    );

    const reply = (await sendTab(nav.tabId, {
      type: 'CONTENT_MESSAGES_DRAFT',
      room_id,
      body,
      selectorConfig: selectors,
    })) as ContentComposerReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, `Failed to pre-fill composer in ${room_id}`, targetUrl);
    }

    sendProgress?.('draft', 2, 2, 'Pre-filled message composer');
    deps.recordActivity?.({
      source: 'tab',
      action: 'messages.draft',
      detail: `Pre-filled composer in ${room_id}`,
      status: 'ok',
    });

    return {
      ok: true,
      prefilled: true,
      room_id,
      body,
    };
  });
}

export async function executeMessagesSend(
  deps: WorkflowRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `messages-send-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = MessagesSendParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid messages.send params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const { room_id, body } = parsed.data;
  const targetUrl = resolveRoomTargetUrl(room_id);
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const getTab = deps.getTab ?? defaultGetTab;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    const currentTabId = deps.tabController.getState().automationTabId;
    let tabId: number | null = null;
    if (currentTabId !== null) {
      const existing = await getTab(currentTabId);
      if (existing?.id !== undefined && urlsMatchPath(existing.url, targetUrl)) {
        tabId = existing.id;
      }
    }

    if (tabId === null) {
      sendProgress?.('navigate', 1, 2, `Opening room ${room_id} to send reply`);
      const nav = await deps.tabController.navigateAndWaitForHydration(
        targetUrl,
        {
          guards: selectors.auth_and_challenge_guards,
          waitForSelectors: [
            "textarea[data-test='composer-textarea']",
            "[data-test='room-not-found']",
            ...(selectors.views.messages_thread?.fields.composer_input?.selectors ?? []),
            'main',
          ],
          timeoutMs: 15_000,
        },
        signal,
      );
      tabId = nav.tabId;
    }

    const reply = (await sendTab(tabId, {
      type: 'CONTENT_MESSAGES_SEND',
      room_id,
      body,
      selectorConfig: selectors,
    })) as ContentComposerReply | undefined;

    if (!reply || !reply.ok) {
      throwContentError(reply, `Failed to send message in ${room_id}`, targetUrl);
    }

    const sentBody = (reply.body ?? body ?? '').trim();
    const maxAttempts = deps.confirmPollMaxAttempts ?? 40;
    const intervalMs = deps.confirmPollIntervalMs ?? 150;
    let sendConfirmed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      }
      const tabInfo = await getTab(tabId);
      const tabUrl = tabInfo?.url ?? '';
      if (tabUrl) {
        const urlCheck = isChallengeOrLoginUrl(tabUrl, selectors.auth_and_challenge_guards);
        if (urlCheck.matched) {
          throw new HumanActionRequiredError(urlCheck.reason, urlCheck.challengeType, tabUrl);
        }
      }

      const check = (await sendTab(tabId, {
        type: 'CONTENT_MESSAGES_GET',
        room_id,
        selectorConfig: selectors,
      }).catch(() => null)) as
        | (ContentMessagesGetReply & {
            composer_value?: string;
            challengeDetected?: boolean;
            challengeReason?: string;
          })
        | null;

      if (check?.errorCode === 'HUMAN_ACTION_REQUIRED' || check?.challengeDetected) {
        throw new HumanActionRequiredError(
          check.reason ?? check.challengeReason ?? 'Human verification required after message send',
          check.challengeType ?? 'unknown',
          check.url ?? targetUrl,
        );
      }

      if (check?.errorCode === 'ROOM_NOT_FOUND') {
        throwContentError(check, `Room ${room_id} not found`, targetUrl);
      }

      if (check?.ok) {
        const composerCleared =
          typeof check.composer_value === 'string' && check.composer_value.trim() === '';
        const composerNotStillFull =
          typeof check.composer_value !== 'string' || check.composer_value.trim() === '';
        const msgs = Array.isArray(check.messages) ? check.messages : [];
        const lastMsgBody = msgs.length > 0 ? (msgs[msgs.length - 1]?.body ?? '').trim() : '';
        const newMessageAppended =
          sentBody.length > 0 &&
          (typeof reply.prior_message_count === 'number'
            ? msgs.length > reply.prior_message_count && lastMsgBody === sentBody
            : composerNotStillFull && lastMsgBody === sentBody);
        if (composerCleared || newMessageAppended) {
          sendConfirmed = true;
          break;
        }
      }

      if (attempt < maxAttempts - 1 && intervalMs > 0) {
        await sleepAbortable(intervalMs, signal);
      }
    }

    if (!sendConfirmed) {
      throw new BridgeRpcError(
        'MESSAGE_SEND_UNCONFIRMED',
        `MESSAGE_SEND_UNCONFIRMED: Message send in ${room_id} was not confirmed within polling window`,
      );
    }

    sendProgress?.('sent', 2, 2, `Sent message in ${room_id}`);
    deps.recordActivity?.({
      source: 'tab',
      action: 'messages.send',
      detail: `Sent reply in ${room_id}`,
      status: 'ok',
    });

    return {
      ok: true,
      sent: true,
      room_id,
      body: reply.body ?? body ?? '',
    };
  });
}

export async function pollMessagesAndSync(
  deps: WorkflowRpcDeps,
  requestId = `poll-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const result = await executeMessagesList(deps, {}, undefined, requestId);
  const rooms = Array.isArray(result.rooms) ? result.rooms : [];
  if (rooms.length > 0) {
    try {
      await deps.proxyFetch('/api/messages/threads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms }),
      });
    } catch {
      // best-effort DB sync; do not fail background poll if daemon sync fails
    }
  }
  return result;
}

export async function syncUnreadPollAlarm(): Promise<void> {
  try {
    const [enabled, minutes] = await Promise.all([
      unreadPollEnabledItem.getValue().catch(() => false),
      unreadPollMinutesItem.getValue().catch(() => 15),
    ]);
    await browser.alarms.clear(UNREAD_POLL_ALARM_NAME).catch(() => undefined);
    if (enabled) {
      const periodInMinutes = Math.max(1, Math.min(1440, Number(minutes) || 15));
      await browser.alarms.create(UNREAD_POLL_ALARM_NAME, { periodInMinutes });
    }
  } catch {
    // alarms API unavailable outside extension runtime
  }
}

export async function handleUnreadPollAlarm(
  deps: WorkflowRpcDeps,
  state: {
    wsConnected: boolean;
    killSwitchActive: boolean;
    humanActionRequired: boolean;
  },
  alarm: { name?: string },
): Promise<boolean> {
  if (alarm.name !== UNREAD_POLL_ALARM_NAME) {
    return false;
  }
  const enabled = await unreadPollEnabledItem.getValue().catch(() => false);
  if (!enabled) {
    return false;
  }
  const tabState = deps.tabController.getState();
  if (!state.wsConnected || tabState.busy || state.killSwitchActive || state.humanActionRequired) {
    return false;
  }
  try {
    await pollMessagesAndSync(deps, `poll-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}
