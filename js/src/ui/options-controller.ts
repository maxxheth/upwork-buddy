import { browser } from 'wxt/browser';
import type { RuntimeStatusSnapshot } from '../shared/protocol';
import { DEFAULT_API_URL, DEFAULT_JITTER_RATIO, DEFAULT_PACING_SECONDS } from '../shared/schemas';
import {
  apiUrlItem,
  authTokenItem,
  jitterRatioItem,
  pacingSecondsItem,
} from '../shared/storage-items';
import { StorageAdapter } from '../storage';

export interface OptionsControllerElements {
  form: HTMLFormElement;
  urlInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  pacingInput: HTMLInputElement;
  jitterInput: HTMLInputElement;
  testBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  nativeBtn: HTMLButtonElement;
  statusBanner: HTMLElement;
  nativeStatusEl: HTMLElement;
}

export class OptionsController {
  private readonly storageAdapter = new StorageAdapter();
  private listenersAttached = false;
  private actionBeforeInitDone = false;
  private readonly dirtyFields = new Set<'url' | 'token' | 'pacing' | 'jitter'>();

  constructor(private readonly els: OptionsControllerElements) {}

  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;

    const markDirty = (field: 'url' | 'token' | 'pacing' | 'jitter') => {
      this.dirtyFields.add(field);
    };

    for (const evt of ['input', 'change'] as const) {
      this.els.urlInput.addEventListener(evt, () => markDirty('url'));
      this.els.tokenInput.addEventListener(evt, () => markDirty('token'));
      this.els.pacingInput.addEventListener(evt, () => markDirty('pacing'));
      this.els.jitterInput.addEventListener(evt, () => markDirty('jitter'));
    }

    this.els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.actionBeforeInitDone = true;
      void this.handleSaveAndConnect();
    });

    this.els.testBtn.addEventListener('click', () => {
      this.actionBeforeInitDone = true;
      void this.handleTestConnection();
    });

    this.els.nativeBtn.addEventListener('click', () => {
      this.actionBeforeInitDone = true;
      void this.handleNativeBootstrap();
    });
  }

  async init(): Promise<void> {
    this.actionBeforeInitDone = false;
    this.attachListeners();

    const [apiUrl, token, pacing, jitter] = await Promise.all([
      apiUrlItem.getValue().catch(() => DEFAULT_API_URL),
      authTokenItem.getValue().catch(() => ''),
      pacingSecondsItem.getValue().catch(() => DEFAULT_PACING_SECONDS),
      jitterRatioItem.getValue().catch(() => DEFAULT_JITTER_RATIO),
    ]);

    if (!this.dirtyFields.has('url') && this.els.urlInput.value === '') {
      this.els.urlInput.value = apiUrl || DEFAULT_API_URL;
    }
    if (!this.dirtyFields.has('token') && this.els.tokenInput.value === '') {
      this.els.tokenInput.value = token || '';
    }
    if (!this.dirtyFields.has('pacing') && this.els.pacingInput.value === '') {
      this.els.pacingInput.value = String(pacing ?? DEFAULT_PACING_SECONDS);
    }
    if (!this.dirtyFields.has('jitter') && this.els.jitterInput.value === '') {
      this.els.jitterInput.value = String(jitter ?? DEFAULT_JITTER_RATIO);
    }

    if (!this.actionBeforeInitDone) {
      await this.refreshStatus();
    }
  }

  async refreshStatus(): Promise<void> {
    try {
      const status = (await browser.runtime.sendMessage({
        type: 'GET_RUNTIME_STATUS',
      })) as Partial<RuntimeStatusSnapshot> | undefined;
      if (status?.wsConnected) {
        this.setStatus(`Connected (session ${status.sessionId ?? 'active'})`, 'ok');
      } else if (status?.lastError) {
        this.setStatus(`Disconnected — ${status.lastError}`, 'warn');
      } else {
        this.setStatus('Not paired yet', 'neutral');
      }
    } catch {
      this.setStatus('Background service worker unreachable', 'warn');
    }
  }

  async handleTestConnection(): Promise<void> {
    const apiBaseUrl = this.els.urlInput.value.trim() || DEFAULT_API_URL;
    const apiToken = this.els.tokenInput.value.trim();

    this.setStatus('Testing connection...', 'neutral');
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        apiBaseUrl,
        apiToken,
      })) as
        | { ok?: boolean; healthStatus?: number; authStatus?: number; error?: string }
        | undefined;

      if (res?.ok) {
        this.setStatus(`Connection OK (/health=${res.healthStatus}, auth=${res.authStatus})`, 'ok');
      } else {
        this.setStatus(res?.error ?? 'Connection test failed', 'error');
      }
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async handleSaveAndConnect(): Promise<void> {
    const rawUrl = this.els.urlInput.value.trim() || DEFAULT_API_URL;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('URL must start with http:// or https://');
      }
    } catch (error) {
      this.setStatus(
        `Invalid Daemon URL: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return;
    }

    const apiBaseUrl = parsedUrl.origin;
    const apiToken = this.els.tokenInput.value.trim();
    const parsedPacing = Number.parseFloat(this.els.pacingInput.value);
    const pacingSeconds =
      Number.isFinite(parsedPacing) && parsedPacing >= 0 ? parsedPacing : DEFAULT_PACING_SECONDS;
    const parsedJitter = Number.parseFloat(this.els.jitterInput.value);
    const jitterRatio =
      Number.isFinite(parsedJitter) && parsedJitter >= 0 && parsedJitter <= 0.9
        ? parsedJitter
        : DEFAULT_JITTER_RATIO;

    await Promise.all([
      apiUrlItem.setValue(apiBaseUrl),
      authTokenItem.setValue(apiToken),
      pacingSecondsItem.setValue(pacingSeconds),
      jitterRatioItem.setValue(jitterRatio),
      this.storageAdapter.saveCustomConfig({
        apiBaseUrl,
        profileApiEndpoint: `${apiBaseUrl}/api/profile`,
        jobsApiEndpoint: `${apiBaseUrl}/api/jobs`,
      }),
    ]);

    this.setStatus('Saved & pairing WebSocket...', 'neutral');
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'PAIR_AND_RECONNECT',
        apiBaseUrl,
        apiToken,
        pacingSeconds,
        jitterRatio,
      })) as Partial<RuntimeStatusSnapshot> | undefined;

      if (res?.wsConnected) {
        this.setStatus(`Connected (session ${res.sessionId ?? 'active'})`, 'ok');
      } else {
        this.setStatus('Saved & Paired (awaiting WebSocket handshake)', 'ok');
      }
    } catch (error) {
      this.setStatus(
        `Saved locally, pairing error: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  async handleNativeBootstrap(): Promise<void> {
    this.els.nativeStatusEl.textContent = 'Checking Native Host...';
    try {
      const ping = (await browser.runtime.sendMessage({
        type: 'NATIVE_HOST_PING',
      })) as { ok?: boolean; version?: string; error?: string } | undefined;

      if (!ping?.ok) {
        this.els.nativeStatusEl.textContent = `Native Host unavailable: ${ping?.error ?? 'not installed'}`;
        return;
      }

      const tokenRes = (await browser.runtime.sendMessage({
        type: 'BG_NATIVE_HOST_COMMAND',
        command: 'get_token',
      })) as { ok?: boolean; token?: string; daemon_url?: string; error?: string } | undefined;

      if (tokenRes?.ok && tokenRes.token) {
        this.els.tokenInput.value = tokenRes.token;
        if (tokenRes.daemon_url) {
          this.els.urlInput.value = tokenRes.daemon_url;
        }
        this.els.nativeStatusEl.textContent = `Native Host v${ping.version ?? '2.0.0'} connected — token loaded (click Save & Connect)`;
      } else {
        this.els.nativeStatusEl.textContent = `Native Host v${ping.version ?? '2.0.0'} connected (${tokenRes?.error ?? 'no token found'})`;
      }
    } catch (error) {
      this.els.nativeStatusEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private setStatus(text: string, level: 'ok' | 'warn' | 'error' | 'neutral'): void {
    this.els.statusBanner.textContent = text;
    this.els.statusBanner.dataset.level = level;
  }
}
