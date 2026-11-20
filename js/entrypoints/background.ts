import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { ApiProxyRequestMessage, ApiProxyResponseMessage } from '../src/api';
import {
  getStoredDaemonConfig,
  handleApiProxyMessage,
  isContentScriptProxyAllowed,
  isExtensionUiSender,
  isRuntimeSenderAuthorized,
  normalizeBaseApiUrl,
  proxyDaemonFetch,
} from '../src/background/api-proxy';
import {
  executeDetailEnrich,
  executeSearchSweep,
  executeSelectorAuditRpc,
  executeSelectorPatchTestRpc,
  executeUiDiagnosticCaptureRpc,
  handleBgCaptureUiDiagnosticCommand,
  handleBgSelectorAuditCommand,
} from '../src/background/discovery-rpc';
import { BadgeManager, NativeLauncher } from '../src/background/native-launcher';
import {
  extractPolicyPatchFromProxyResponse,
  parsePolicyStateFromJson,
} from '../src/background/policy-sync';
import { AutomationTabController, isChallengeOrLoginUrl } from '../src/background/tab-controller';
import {
  executeMessagesDraft,
  executeMessagesGet,
  executeMessagesList,
  executeMessagesSend,
  executeProposalFill,
  executeProposalSubmit,
  executeProposalsSync,
  handleUnreadPollAlarm,
  pollMessagesAndSync,
  syncUnreadPollAlarm,
  UNREAD_POLL_ALARM_NAME,
} from '../src/background/workflow-rpc';
import { ExtensionWsClient } from '../src/background/ws-client';
import {
  type ActivityLogEntry,
  type BackgroundCommandMessage,
  BackgroundCommandMessageSchema,
  type PassiveTapPayload,
  type PolicyMode,
  type RuntimeStatusSnapshot,
  type SessionProbeResult,
  type TabSummary,
} from '../src/shared/protocol';
import { fetchAndCacheSelectors } from '../src/shared/selectors';
import {
  apiUrlItem,
  authTokenItem,
  jitterRatioItem,
  pacingSecondsItem,
  unreadPollEnabledItem,
  unreadPollMinutesItem,
} from '../src/shared/storage-items';

const MAX_ACTIVITY_ENTRIES = 60;
const MAX_PASSIVE_TAP_CACHE = 40;

export default defineBackground(() => {
  const badgeManager = new BadgeManager();
  const nativeLauncher = new NativeLauncher();
  const recentActivity: ActivityLogEntry[] = [];
  const passiveTapCache: PassiveTapPayload[] = [];

  let policyMode: PolicyMode = 'confirm_in_ui';
  let killSwitchActive = false;
  let humanActionRequired = false;
  let activeChallenge: string | null = null;
  let pendingApprovalsCount = 0;
  let unreadMessagesCount = 0;
  let pendingSidePanelTab: string | null = null;

  const recordActivity = (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>): void => {
    recentActivity.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (recentActivity.length > MAX_ACTIVITY_ENTRIES) {
      recentActivity.length = MAX_ACTIVITY_ENTRIES;
    }
  };

  const tabController = new AutomationTabController({
    onChallengeDetected: ({ challengeType, reason }) => {
      humanActionRequired = true;
      activeChallenge = `${challengeType}: ${reason}`;
      recordActivity({
        source: 'tab',
        action: 'HUMAN_ACTION_REQUIRED',
        detail: activeChallenge,
        status: 'warn',
      });
      void badgeManager.setConnectionState('auth-required');
    },
  });

  const probeUpworkTabs = async (): Promise<{
    loggedIn: boolean;
    challengeDetected: boolean;
    challengeReason?: string;
  }> => {
    try {
      const tabs = await browser.tabs.query({ url: 'https://www.upwork.com/*' });
      if (tabs.length === 0) {
        return { loggedIn: false, challengeDetected: false };
      }
      // Prefer active or automation tab first
      const sorted = [...tabs].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return 0;
      });
      for (const tab of sorted) {
        if (tab.id === undefined) continue;
        try {
          const probe = (await browser.tabs.sendMessage(tab.id, {
            type: 'CONTENT_PROBE_SESSION',
          })) as SessionProbeResult | undefined;
          if (probe && typeof probe === 'object') {
            return {
              loggedIn: Boolean(probe.loggedIn),
              challengeDetected: Boolean(probe.challengeDetected),
              challengeReason: probe.challengeReason,
            };
          }
        } catch {
          // content script not ready on this tab yet
        }
      }
      // Fallback: an open upwork.com tab not on login/challenge URL counts as likely logged in
      const hasNonLoginTab = tabs.some(
        (t) => typeof t.url === 'string' && !isChallengeOrLoginUrl(t.url).matched,
      );
      return { loggedIn: hasNonLoginTab, challengeDetected: false };
    } catch {
      return { loggedIn: false, challengeDetected: false };
    }
  };

  const manifestVersion = browser.runtime.getManifest?.().version ?? '2.0.0';
  const browserName = import.meta.env.BROWSER ?? 'chrome';

  const wsClient = new ExtensionWsClient({
    getConfig: getStoredDaemonConfig,
    extensionVersion: manifestVersion,
    browserName,
    getHeartbeatParams: async () => {
      const probe = await probeUpworkTabs();
      if (probe.challengeDetected) {
        humanActionRequired = true;
        activeChallenge = probe.challengeReason ?? 'Challenge detected';
      } else if (probe.loggedIn) {
        humanActionRequired = false;
        activeChallenge = null;
      }
      return { upwork_logged_in: probe.loggedIn };
    },
    onStateChange: (state, detail) => {
      void badgeManager.setConnectionState(state);
      recordActivity({
        source: 'ws',
        action: `ws:${state}`,
        detail: detail.sessionId
          ? `session=${detail.sessionId}`
          : (detail.lastError ?? 'state updated'),
        status: state === 'connected' ? 'ok' : state === 'auth-required' ? 'warn' : 'error',
      });
    },
  });

  // Register M3 JSON-RPC 2.0 handlers
  wsClient.registerMethod('session.status', async () => {
    const wsState = wsClient.getState();
    const tabState = tabController.getState();
    const probe = await probeUpworkTabs();

    if (probe.challengeDetected) {
      humanActionRequired = true;
      activeChallenge = probe.challengeReason ?? 'Challenge detected';
    } else if (probe.loggedIn) {
      humanActionRequired = false;
      activeChallenge = null;
    }

    return {
      ok: true,
      extension_connected: wsState.connected,
      extension_version: manifestVersion,
      browser: browserName,
      upwork_logged_in: probe.loggedIn,
      automation_tab_id: tabState.automationTabId,
      busy: tabState.busy,
      active_request_id: tabState.activeRequestId,
      kill_switch_active: killSwitchActive,
      last_error: wsState.lastError,
    };
  });

  wsClient.registerMethod('tabs.list', async () => {
    const allTabs = await browser.tabs.query({});
    const tabs = allTabs.filter(
      (t) => typeof t.url === 'string' && t.url.startsWith('https://www.upwork.com/'),
    );
    const autoId = tabController.getState().automationTabId;
    const mapped: TabSummary[] = tabs
      .filter((t): t is typeof t & { id: number } => typeof t.id === 'number')
      .map((t) => {
        const isAuto = t.id === autoId;
        return {
          id: t.id,
          title: t.title ?? '',
          url: t.url ?? '',
          active: Boolean(t.active),
          automation: isAuto,
          is_automation: isAuto,
        };
      });
    return { tabs: mapped };
  });

  wsClient.registerMethod('kill_switch.abort', async (params) => {
    const reason =
      typeof params.reason === 'string' && params.reason.trim()
        ? params.reason.trim()
        : 'Aborted by kill switch';
    killSwitchActive = true;
    policyMode = 'draft_only';
    const result = tabController.abortAll(reason);
    recordActivity({
      source: 'policy',
      action: 'kill_switch.abort',
      detail: reason,
      status: 'warn',
    });
    // Best-effort cancel any content-side hydration wait
    const autoId = tabController.getState().automationTabId;
    if (autoId !== null) {
      void browser.tabs.sendMessage(autoId, { type: 'CONTENT_KILL_ABORT', reason }).catch(() => {});
    }
    return {
      aborted: result.aborted,
      active_request_id: result.activeRequestId,
      reason,
    };
  });

  const discoveryDeps = {
    tabController,
    proxyFetch: (path: string, init?: RequestInit) => proxyDaemonFetch(path, init),
    getSelectors: (forceRefresh = false) =>
      fetchAndCacheSelectors((path, init) => proxyDaemonFetch(path, init), forceRefresh),
    recordActivity,
    getPassivePayloads: () => [...passiveTapCache],
  };

  wsClient.registerMethod('jobs.search', (params, ctx) =>
    executeSearchSweep(discoveryDeps, params, ctx.sendProgress, ctx.requestId),
  );

  wsClient.registerMethod('jobs.detail', (params, ctx) =>
    executeDetailEnrich(discoveryDeps, params, ctx.sendProgress, ctx.requestId),
  );

  const reloadAndBroadcastSelectors = async (): Promise<{
    ok: boolean;
    version: string;
    tabs_notified: number;
  }> => {
    const selectors = await discoveryDeps.getSelectors(true);
    const tabs = await browser.tabs.query({ url: 'https://www.upwork.com/*' }).catch(() => []);
    let notified = 0;
    await Promise.all(
      tabs.map(async (tab) => {
        if (typeof tab.id !== 'number') return;
        try {
          await browser.tabs.sendMessage(tab.id, {
            type: 'CONTENT_SELECTORS_RELOADED',
            selectorConfig: selectors,
          });
          notified += 1;
        } catch {
          // tab content script not ready
        }
      }),
    );
    void browser.runtime
      .sendMessage({ type: 'SIDEPANEL_SELECTORS_UPDATED', version: selectors.version })
      .catch(() => undefined);
    recordActivity({
      source: 'ws',
      action: 'selectors.reload',
      detail: `Reloaded v${selectors.version} (${notified} tab(s))`,
      status: 'ok',
    });
    return {
      ok: true,
      version: selectors.version,
      tabs_notified: notified,
    };
  };

  wsClient.registerMethod('audit.selectors', (params, ctx) =>
    executeSelectorAuditRpc(discoveryDeps, params, ctx.sendProgress, ctx.requestId),
  );

  wsClient.registerMethod('diagnostics.capture', (params, ctx) =>
    executeUiDiagnosticCaptureRpc(discoveryDeps, params, ctx.sendProgress, ctx.requestId),
  );

  wsClient.registerMethod('diagnostics.test_patch', (params, ctx) =>
    executeSelectorPatchTestRpc(discoveryDeps, params, ctx.sendProgress),
  );

  wsClient.registerMethod('selectors.reload', async () => reloadAndBroadcastSelectors());

  const workflowDeps = {
    tabController,
    proxyFetch: (path: string, init?: RequestInit) => proxyDaemonFetch(path, init),
    getSelectors: (forceRefresh = false) =>
      fetchAndCacheSelectors((path, init) => proxyDaemonFetch(path, init), forceRefresh),
    recordActivity,
    onUnreadUpdated: (totalUnread: number) => {
      unreadMessagesCount = Math.max(0, totalUnread);
      void badgeManager.setUnreadMessages(unreadMessagesCount);
    },
  };

  wsClient.registerMethod('proposal.fill', (params, ctx) =>
    executeProposalFill(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('proposal.submit', (params, ctx) =>
    executeProposalSubmit(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('proposals.sync', (params, ctx) =>
    executeProposalsSync(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('messages.list', (params, ctx) =>
    executeMessagesList(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('messages.get', (params, ctx) =>
    executeMessagesGet(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('messages.draft', (params, ctx) =>
    executeMessagesDraft(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );
  wsClient.registerMethod('messages.send', (params, ctx) =>
    executeMessagesSend(workflowDeps, params, ctx.sendProgress, ctx.requestId),
  );

  const buildRuntimeSnapshot = (): RuntimeStatusSnapshot => {
    const wsState = wsClient.getState();
    const tabState = tabController.getState();
    return {
      connectionState: wsState.state,
      wsConnected: wsState.connected,
      sessionId: wsState.sessionId,
      lastHeartbeatAt: wsState.lastHeartbeatAt,
      policyMode,
      humanActionRequired,
      activeChallenge,
      pendingApprovalsCount,
      unreadMessagesCount,
      activeTaskCount: (tabState.busy ? 1 : 0) + tabState.queuedCount,
      killSwitchActive,
      automationTabId: tabState.automationTabId,
      lastError: wsState.lastError,
      recentActivity: [...recentActivity],
    };
  };

  const handleRuntimeCommand = async (
    msg: BackgroundCommandMessage,
    sender?: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
  ): Promise<Record<string, unknown> | ApiProxyResponseMessage> => {
    switch (msg.type) {
      case 'API_PROXY_REQUEST': {
        const proxyReq = msg as ApiProxyRequestMessage;
        const isUi = isExtensionUiSender(sender, browser.runtime?.id);
        const cfg = await getStoredDaemonConfig();
        if (!isUi) {
          if (!isContentScriptProxyAllowed(proxyReq.method, proxyReq.url, cfg.apiUrl)) {
            recordActivity({
              source: 'proxy',
              action: `${proxyReq.method.toUpperCase()} ${proxyReq.url}`,
              detail: '403 Forbidden (content-script scope)',
              status: 'warn',
            });
            return {
              ok: false,
              status: 403,
              statusText: 'Forbidden',
              error: `Content script is not authorized for ${proxyReq.method.toUpperCase()} ${proxyReq.url}`,
            };
          }
        }
        const proxyRes = await handleApiProxyMessage(proxyReq, { recordActivity });
        if (isUi) {
          const patch = extractPolicyPatchFromProxyResponse(proxyReq, proxyRes, cfg.apiUrl);
          if (patch?.policyMode !== undefined) {
            policyMode = patch.policyMode;
          }
          if (patch?.killSwitchActive !== undefined) {
            killSwitchActive = patch.killSwitchActive;
          }
        }
        return proxyRes;
      }

      case 'BG_GET_STATUS':
      case 'GET_RUNTIME_STATUS': {
        // Best-effort refresh policy/approvals from daemon if token exists
        const cfg = await getStoredDaemonConfig();
        if (cfg.token) {
          try {
            const sessRes = await proxyDaemonFetch('/api/session/status', { method: 'GET' });
            if (sessRes.ok) {
              const sessData = (await sessRes.json()) as unknown;
              const patch = parsePolicyStateFromJson(sessData);
              if (patch?.policyMode !== undefined) {
                policyMode = patch.policyMode;
              }
              if (patch?.killSwitchActive !== undefined) {
                killSwitchActive = patch.killSwitchActive;
              }
            }
          } catch {
            // offline
          }
        }
        return { ...buildRuntimeSnapshot() };
      }

      case 'BG_WS_RECONNECT':
        await wsClient.reconnectNow();
        return { ok: true, ...buildRuntimeSnapshot() };

      case 'PAIR_AND_RECONNECT': {
        const normalizedUrl = normalizeBaseApiUrl(msg.apiBaseUrl);
        await apiUrlItem.setValue(normalizedUrl);
        await authTokenItem.setValue(msg.apiToken.trim());
        if (typeof msg.pacingSeconds === 'number' && Number.isFinite(msg.pacingSeconds)) {
          await pacingSecondsItem.setValue(msg.pacingSeconds);
        }
        if (typeof msg.jitterRatio === 'number' && Number.isFinite(msg.jitterRatio)) {
          await jitterRatioItem.setValue(msg.jitterRatio);
        }
        await wsClient.reconnectNow();
        recordActivity({
          source: 'ws',
          action: 'PAIR_AND_RECONNECT',
          detail: `Paired to ${normalizedUrl}`,
          status: 'ok',
        });
        return { ok: true, ...buildRuntimeSnapshot() };
      }

      case 'TEST_CONNECTION': {
        const normalizedUrl = normalizeBaseApiUrl(msg.apiBaseUrl);
        const token = msg.apiToken.trim();
        try {
          const healthRes = await proxyDaemonFetch(
            '/health',
            { method: 'GET' },
            { apiUrl: normalizedUrl, token },
          );
          const sessionRes = await proxyDaemonFetch(
            '/api/session/status',
            { method: 'GET' },
            { apiUrl: normalizedUrl, token },
          );
          return {
            ok: healthRes.ok && sessionRes.ok,
            healthStatus: healthRes.status,
            authStatus: sessionRes.status,
            error: !healthRes.ok
              ? `Daemon /health returned ${healthRes.status}`
              : !sessionRes.ok
                ? `Auth check returned ${sessionRes.status}`
                : undefined,
          };
        } catch (error) {
          return {
            ok: false,
            healthStatus: 0,
            authStatus: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      case 'NATIVE_HOST_PING': {
        const res = await nativeLauncher.sendCommand('ping');
        recordActivity({
          source: 'native',
          action: 'native:ping',
          detail: res.ok ? 'pong' : (res.error ?? 'unavailable'),
          status: res.ok ? 'ok' : 'warn',
        });
        return { ...res };
      }

      case 'NATIVE_HOST_START_SERVER': {
        const res = await nativeLauncher.sendCommand('start_daemon');
        recordActivity({
          source: 'native',
          action: 'native:start_daemon',
          detail: res.ok ? 'daemon running' : (res.error ?? 'failed'),
          status: res.ok ? 'ok' : 'error',
        });
        if (res.ok) {
          await wsClient.reconnectNow();
        }
        return { ...res };
      }

      case 'BG_NATIVE_HOST_COMMAND': {
        const res = await nativeLauncher.sendCommand(msg.command);
        return { ...res };
      }

      case 'BG_KILL_SWITCH':
      case 'TRIGGER_KILL_SWITCH': {
        const reason = msg.reason?.trim() || 'Triggered by user in extension UI';
        killSwitchActive = true;
        policyMode = 'draft_only';
        const preState = tabController.getState();
        let abortResult: { aborted: boolean; activeRequestId: string | null } = {
          aborted: false,
          activeRequestId: null,
        };
        try {
          // Persist draft_only in daemon DB (which also triggers kill_switch.abort WS RPC)
          // before aborting local tab tasks so callers awaiting the aborted RPC see draft_only.
          await proxyDaemonFetch('/api/policy/kill-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
            signal: AbortSignal.timeout(2500),
          });
        } catch {
          // endpoint may be unavailable offline or before M5
        } finally {
          abortResult = tabController.abortAll(reason);
          if (preState.automationTabId !== null) {
            void browser.tabs
              .sendMessage(preState.automationTabId, { type: 'CONTENT_KILL_ABORT', reason })
              .catch(() => {});
          }
        }
        recordActivity({
          source: 'policy',
          action: 'KILL_SWITCH',
          detail: reason,
          status: 'warn',
        });
        return {
          ok: true,
          aborted: abortResult.aborted || preState.busy,
          active_request_id: abortResult.activeRequestId ?? preState.activeRequestId,
          policyMode,
        };
      }

      case 'BG_SET_PENDING_APPROVALS':
        pendingApprovalsCount = msg.count;
        await badgeManager.setPendingApprovals(msg.count);
        return { ok: true, pendingApprovalsCount };

      case 'BG_UPDATE_UNREAD_POLL_CONFIG': {
        await unreadPollEnabledItem.setValue(msg.enabled);
        if (typeof msg.intervalMinutes === 'number' && Number.isFinite(msg.intervalMinutes)) {
          await unreadPollMinutesItem.setValue(Math.max(1, Math.min(1440, msg.intervalMinutes)));
        }
        await syncUnreadPollAlarm();
        return { ok: true, enabled: msg.enabled };
      }

      case 'BG_POLL_MESSAGES':
        return pollMessagesAndSync(workflowDeps);

      case 'BG_SELECTORS_GET': {
        const selectors = await fetchAndCacheSelectors(
          (path, init) => proxyDaemonFetch(path, init),
          Boolean(msg.forceRefresh),
        );
        return { ok: true, selectors };
      }

      case 'BG_RUN_SEARCH':
        return executeSearchSweep(discoveryDeps, msg.params);

      case 'BG_RUN_DETAIL_ENRICH':
        return executeDetailEnrich(discoveryDeps, msg.params);

      case 'BG_RUN_SELECTOR_AUDIT':
        return handleBgSelectorAuditCommand(discoveryDeps, msg);

      case 'BG_CAPTURE_UI_DIAGNOSTIC':
        return handleBgCaptureUiDiagnosticCommand(discoveryDeps, msg);

      case 'BG_TEST_SELECTOR_PATCH': {
        return executeSelectorPatchTestRpc(discoveryDeps, {
          view: msg.view,
          field: msg.field,
          rule: msg.rule,
          capture_id: msg.captureId,
          use_active_tab: msg.useActiveTab ?? true,
        });
      }

      case 'BG_APPLY_SELECTOR_PATCH': {
        const res = await proxyDaemonFetch('/api/diagnostics/apply-patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            view: msg.view,
            field: msg.field,
            selectors: msg.rule.selectors,
            extract: msg.rule.extract,
            attribute: msg.rule.attribute,
            transforms: msg.rule.transforms,
            sibling_child_tag: msg.rule.sibling_child_tag,
            join_with: msg.rule.join_with,
            label_contains: msg.rule.label_contains,
            required: msg.rule.required,
            is_fragile: msg.rule.is_fragile,
            fragile_reason: msg.rule.fragile_reason,
            auth_only: msg.rule.auth_only,
            description: msg.rule.description,
            reason: msg.reason,
            export_fixture: msg.exportFixture,
            capture_id: msg.captureId,
            mode: msg.mode ?? 'prepend',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            error:
              typeof data.error === 'string'
                ? data.error
                : `Apply patch failed with HTTP ${res.status}`,
          };
        }
        await reloadAndBroadcastSelectors().catch(() => undefined);
        return { ok: true, ...data };
      }

      case 'BG_ROLLBACK_SELECTOR_PATCH': {
        const res = await proxyDaemonFetch('/api/diagnostics/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            backup_file: msg.backupFile ?? '',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            error:
              typeof data.error === 'string'
                ? data.error
                : `Rollback failed with HTTP ${res.status}`,
          };
        }
        await reloadAndBroadcastSelectors().catch(() => undefined);
        return { ok: true, ...data };
      }

      case 'BG_GET_PENDING_SIDEPANEL_TAB': {
        const tab = pendingSidePanelTab;
        pendingSidePanelTab = null;
        return { ok: true, tab };
      }

      case 'OPEN_SIDEPANEL': {
        if (msg.tab) {
          pendingSidePanelTab = msg.tab;
          void browser.runtime
            .sendMessage({ type: 'SIDEPANEL_SWITCH_TAB', tab: msg.tab })
            .catch(() => undefined);
        }
        try {
          const sidePanelApi = (
            globalThis as unknown as {
              chrome?: {
                sidePanel?: {
                  open?: (opts: { windowId?: number; tabId?: number }) => Promise<void>;
                };
              };
            }
          ).chrome?.sidePanel;

          if (sidePanelApi?.open) {
            let windowId = msg.windowId;
            if (windowId === undefined) {
              const win = await browser.windows.getCurrent();
              windowId = win.id;
            }
            if (windowId !== undefined) {
              await sidePanelApi.open({ windowId });
              return { ok: true, mode: 'sidePanel' };
            }
          }

          const sidebarApi = (
            browser as unknown as { sidebarAction?: { open?: () => Promise<void> } }
          ).sidebarAction;
          if (sidebarApi?.open) {
            await sidebarApi.open();
            return { ok: true, mode: 'sidebarAction' };
          }

          const tabUrl = msg.tab
            ? `${browser.runtime.getURL('/sidepanel.html')}?tab=${encodeURIComponent(msg.tab)}`
            : browser.runtime.getURL('/sidepanel.html');
          await browser.tabs.create({ url: tabUrl });
          return { ok: true, mode: 'tab' };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      case 'PASSIVE_TAP_PAYLOAD': {
        passiveTapCache.unshift({
          kind: msg.kind,
          url: msg.url,
          operationName: msg.operationName,
          data: msg.data,
          capturedAt: msg.capturedAt,
        });
        if (passiveTapCache.length > MAX_PASSIVE_TAP_CACHE) {
          passiveTapCache.length = MAX_PASSIVE_TAP_CACHE;
        }
        return { ok: true, cached: passiveTapCache.length };
      }
    }
  };

  browser.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    const parsed = BackgroundCommandMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      return undefined;
    }
    if (!isRuntimeSenderAuthorized(parsed.data.type, sender, browser.runtime?.id)) {
      sendResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        error: `Unauthorized sender for command ${parsed.data.type}`,
      });
      return false;
    }

    handleRuntimeCommand(parsed.data, sender)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          status: 0,
          statusText: 'Background Error',
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UNREAD_POLL_ALARM_NAME) {
      void handleUnreadPollAlarm(
        workflowDeps,
        {
          wsConnected: wsClient.getState().connected,
          killSwitchActive,
          humanActionRequired,
        },
        alarm,
      );
      return;
    }
    void wsClient.handleAlarm(alarm);
  });

  authTokenItem.watch(() => {
    void wsClient.reconnectNow();
  });

  apiUrlItem.watch(() => {
    void wsClient.reconnectNow();
  });

  void wsClient.ensureWatchdogAlarm();
  void syncUnreadPollAlarm();
  void wsClient.connect();
});
