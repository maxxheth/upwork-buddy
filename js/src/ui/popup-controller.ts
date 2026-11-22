import { browser } from 'wxt/browser';
import { ApiClient, createExtensionProxyTransport } from '../api';
import type { RuntimeStatusSnapshot } from '../shared/protocol';

export interface PopupControllerElements {
  daemonStatusEl: HTMLElement;
  policyModeEl: HTMLElement;
  pendingCountEl: HTMLElement;
  challengeBannerEl: HTMLElement;
  openSidePanelBtn: HTMLButtonElement;
  openJobsTableBtn?: HTMLButtonElement | null;
  killSwitchBtn: HTMLButtonElement;
  startServerBtn: HTMLButtonElement;
  openOptionsBtn: HTMLButtonElement;
  feedbackEl: HTMLElement;
}

export class PopupController {
  private readonly apiClient: ApiClient;

  constructor(
    private readonly els: PopupControllerElements,
    apiClient?: ApiClient,
  ) {
    this.apiClient = apiClient ?? new ApiClient(createExtensionProxyTransport());
  }

  async init(): Promise<void> {
    this.els.openSidePanelBtn.addEventListener('click', () => {
      void this.handleOpenSidePanel();
    });
    this.els.openJobsTableBtn?.addEventListener('click', () => {
      void this.handleOpenJobsTable();
    });
    this.els.killSwitchBtn.addEventListener('click', () => {
      void this.handleKillSwitch();
    });
    this.els.startServerBtn.addEventListener('click', () => {
      void this.handleStartServer();
    });
    this.els.openOptionsBtn.addEventListener('click', () => {
      void this.handleOpenOptions();
    });

    await this.refresh();
  }

  async refresh(): Promise<void> {
    let runtime: Partial<RuntimeStatusSnapshot> = {};
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'GET_RUNTIME_STATUS',
      })) as Partial<RuntimeStatusSnapshot> | undefined;
      if (res && typeof res === 'object') {
        runtime = res;
      }
    } catch {
      // ignore
    }

    let pendingCount = runtime.pendingApprovalsCount ?? 0;
    let policyMode = runtime.policyMode ?? 'confirm_in_ui';
    let connected = Boolean(runtime.wsConnected);

    // Query daemon endpoints through background proxy for fresh counts when paired
    try {
      const transport = createExtensionProxyTransport();
      const [sessRes, propRes, draftRes] = await Promise.all([
        transport('/api/session/status', { method: 'GET' }).catch(() => null),
        transport('/api/proposals?status=pending_approval', { method: 'GET' }).catch(() => null),
        transport('/api/messages/drafts?status=pending_approval', { method: 'GET' }).catch(
          () => null,
        ),
      ]);

      let sessPending: number | null = null;
      if (sessRes?.ok) {
        const sess = (await sessRes.json()) as {
          extension_connected?: boolean;
          policy_mode?: string;
          pending_approvals?: number;
        };
        if (typeof sess.extension_connected === 'boolean') {
          connected = sess.extension_connected;
        }
        if (sess.policy_mode) {
          policyMode = sess.policy_mode as RuntimeStatusSnapshot['policyMode'];
        }
        if (typeof sess.pending_approvals === 'number') {
          sessPending = sess.pending_approvals;
        }
      }

      let propPending: number | null = null;
      if (propRes?.ok) {
        const propData = (await propRes.json()) as { proposals?: unknown[] };
        if (Array.isArray(propData.proposals)) {
          propPending = propData.proposals.length;
        }
      }

      let draftPending = 0;
      if (draftRes?.ok) {
        const draftData = (await draftRes.json()) as { drafts?: unknown[] };
        if (Array.isArray(draftData.drafts)) {
          draftPending = draftData.drafts.length;
        }
      }

      if (propPending !== null) {
        pendingCount = propPending + draftPending;
      } else if (sessPending !== null) {
        pendingCount = sessPending;
      }
    } catch {
      // M5 endpoints or daemon may be offline
    }

    this.els.daemonStatusEl.textContent = connected ? 'Connected' : 'Disconnected';
    this.els.daemonStatusEl.dataset.state = connected ? 'connected' : 'disconnected';
    this.els.policyModeEl.textContent = policyMode;
    this.els.pendingCountEl.textContent = String(pendingCount);

    if (runtime.humanActionRequired) {
      this.els.challengeBannerEl.hidden = false;
      this.els.challengeBannerEl.textContent = `HUMAN_ACTION_REQUIRED — ${runtime.activeChallenge ?? 'Login / 2FA / Verification challenge detected'}`;
    } else {
      this.els.challengeBannerEl.hidden = true;
    }

    // Keep unused apiClient reference meaningful if needed later
    void this.apiClient;
  }

  async handleOpenSidePanel(): Promise<void> {
    try {
      const sidePanelApi = (
        globalThis as unknown as {
          chrome?: {
            sidePanel?: {
              open?: (opts: { windowId?: number }) => Promise<void>;
            };
          };
        }
      ).chrome?.sidePanel;

      if (sidePanelApi?.open) {
        const win = await browser.windows.getCurrent();
        if (win.id !== undefined) {
          await sidePanelApi.open({ windowId: win.id });
          return;
        }
      }

      const sidebarApi = (browser as unknown as { sidebarAction?: { open?: () => Promise<void> } })
        .sidebarAction;
      if (sidebarApi?.open) {
        await sidebarApi.open();
        return;
      }

      await browser.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    } catch {
      await browser.tabs.create({ url: browser.runtime.getURL('/sidepanel.html') });
    }
  }

  async handleKillSwitch(): Promise<void> {
    this.els.feedbackEl.textContent = 'Activating Kill Switch...';
    try {
      await browser.runtime.sendMessage({
        type: 'TRIGGER_KILL_SWITCH',
        reason: 'Kill switch pressed in Popup',
      });
      this.els.policyModeEl.textContent = 'draft_only';
      this.els.feedbackEl.textContent =
        'Kill Switch active — automation aborted, mode set to draft_only';
    } catch (error) {
      this.els.feedbackEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async handleStartServer(): Promise<void> {
    this.els.startServerBtn.disabled = true;
    this.els.feedbackEl.textContent = 'Starting local daemon via Native Host...';
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'NATIVE_HOST_START_SERVER',
      })) as { ok?: boolean; daemon_running?: boolean; error?: string } | undefined;

      if (res?.ok && res.daemon_running) {
        this.els.feedbackEl.textContent = 'Local daemon running';
        await this.refresh();
      } else {
        this.els.feedbackEl.textContent =
          res?.error ?? 'Native Host unavailable (see docs/mcp-setup.md)';
      }
    } catch (error) {
      this.els.feedbackEl.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.els.startServerBtn.disabled = false;
    }
  }

  async handleOpenOptions(): Promise<void> {
    try {
      await browser.runtime.openOptionsPage();
    } catch {
      await browser.tabs.create({ url: browser.runtime.getURL('/options.html') });
    }
  }

  async handleOpenJobsTable(): Promise<void> {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'OPEN_JOBS_DASHBOARD',
      })) as { ok?: boolean } | undefined;
      if (res?.ok) return;
    } catch {
      // fall back to direct tab creation
    }
    await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
  }
}
