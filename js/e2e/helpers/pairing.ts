import type { DaemonHandle } from './daemon.ts';
import type { ExtensionContextHandle } from './extension.ts';

export interface PairOptions {
  pacingSeconds?: number;
  timeoutMs?: number;
}

export interface SessionStatusResponse {
  extension_connected: boolean;
  session_id?: string;
  browser?: string;
  upwork_logged_in?: boolean;
  policy_mode?: string;
  last_heartbeat_at?: string;
}

export async function getSessionStatus(daemon: DaemonHandle): Promise<SessionStatusResponse> {
  const res = await daemon.apiFetch('/api/session/status');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/session/status failed (${res.status}): ${text}`);
  }
  return (await res.json()) as SessionStatusResponse;
}

export async function waitForExtensionConnected(
  daemon: DaemonHandle,
  connected = true,
  timeoutMs = 15_000,
): Promise<SessionStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: SessionStatusResponse | null = null;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const status = await getSessionStatus(daemon);
      lastStatus = status;
      if (status.extension_connected === connected) {
        return status;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `Timed out waiting for extension_connected=${String(connected)} (lastStatus=${JSON.stringify(lastStatus)}, lastError=${lastError ?? 'none'})`,
  );
}

export async function pairExtensionWithDaemon(
  ext: ExtensionContextHandle,
  daemon: DaemonHandle,
  opts?: PairOptions,
): Promise<SessionStatusResponse> {
  if (ext.manifest.optionsPath === null) {
    throw new Error(
      'Cannot pair extension: options_ui.page is not present in .output/chrome-mv3/manifest.json',
    );
  }

  const optionsUrl = ext.getExtensionUrl(ext.manifest.optionsPath);
  const page = await ext.context.newPage();

  try {
    await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });

    const urlInput = page
      .locator(
        '[data-testid="daemon-url-input"], input[name="daemonUrl"], input[name="apiBaseUrl"], input[type="url"]',
      )
      .or(page.getByLabel(/daemon.*url|api.*url|server.*url/i))
      .first();
    await urlInput.fill(daemon.baseUrl);

    const tokenInput = page
      .locator(
        '[data-testid="api-token-input"], input[name="apiToken"], input[name="token"], input[type="password"]',
      )
      .or(page.getByLabel(/token|bearer/i))
      .first();
    await tokenInput.fill(daemon.apiToken);

    const effectivePacingSeconds = opts?.pacingSeconds ?? 4.5;
    const pacingInput = page
      .locator(
        '[data-testid="pacing-seconds-input"], input[name="pacingSeconds"], input[name="delayBetweenPagesSeconds"]',
      )
      .or(page.getByLabel(/pacing|delay/i))
      .first();
    if ((await pacingInput.count()) > 0) {
      await pacingInput.fill(String(effectivePacingSeconds));
    }

    const explicitSaveBtn = page.locator('[data-testid="save-options-btn"]');
    const saveBtn =
      (await explicitSaveBtn.count()) > 0
        ? explicitSaveBtn.first()
        : page.getByRole('button', { name: /save|pair/i }).first();
    await saveBtn.click();

    return await waitForExtensionConnected(daemon, true, opts?.timeoutMs ?? 15_000);
  } finally {
    await page.close();
  }
}
