import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Worker } from '@playwright/test';
import { installUpworkMockProxy, seedUpworkAuthCookies } from './upwork-route.ts';

export interface ExtensionManifestPaths {
  manifestVersion: number;
  name: string;
  version: string;
  serviceWorkerPath: string;
  sidePanelPath: string | null;
  popupPath: string | null;
  optionsPath: string | null;
}

export interface ExtensionErrorEntry {
  source: 'pageerror' | 'console' | 'weberror' | 'serviceworker';
  message: string;
  url?: string;
}

export interface ExtensionContextHandle {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly serviceWorker: Worker;
  readonly manifest: ExtensionManifestPaths;
  readonly userDataDir: string;
  readonly errors: ExtensionErrorEntry[];
  clearErrors(): void;
  getExtensionUrl(relativePath: string): string;
  close(): Promise<void>;
}

interface RawManifestShape {
  manifest_version?: number;
  name?: string;
  version?: string;
  background?: {
    service_worker?: string;
  };
  side_panel?: {
    default_path?: string;
  };
  action?: {
    default_popup?: string;
  };
  options_ui?: {
    page?: string;
  };
}

export function readExtensionManifest(extensionPath: string): ExtensionManifestPaths {
  const manifestFile = path.join(extensionPath, 'manifest.json');
  const raw = JSON.parse(fsSync.readFileSync(manifestFile, 'utf8')) as RawManifestShape;
  return {
    manifestVersion: raw.manifest_version ?? 3,
    name: raw.name ?? 'Upwork Buddy',
    version: raw.version ?? '0.0.0',
    serviceWorkerPath: raw.background?.service_worker ?? 'background.js',
    sidePanelPath: raw.side_panel?.default_path ?? null,
    popupPath: raw.action?.default_popup ?? null,
    optionsPath: raw.options_ui?.page ?? null,
  };
}

export async function launchExtensionContext(opts: {
  extensionPath: string;
  mockBaseUrl: string;
  headless?: boolean;
}): Promise<ExtensionContextHandle> {
  const absExtPath = path.resolve(opts.extensionPath);
  const manifest = readExtensionManifest(absExtPath);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upwork-buddy-pw-'));
  const errors: ExtensionErrorEntry[] = [];

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: opts.headless ?? process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${absExtPath}`,
      `--load-extension=${absExtPath}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    viewport: { width: 1440, height: 900 },
  });

  context.on('weberror', (webError) => {
    errors.push({
      source: 'weberror',
      message: webError.error().message,
      url: webError.page()?.url(),
    });
  });

  context.on('page', (page) => {
    page.on('pageerror', (err) => {
      errors.push({
        source: 'pageerror',
        message: err.message,
        url: page.url(),
      });
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push({
          source: 'console',
          message: msg.text(),
          url: page.url(),
        });
      }
    });
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  }

  serviceWorker.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push({
        source: 'serviceworker',
        message: msg.text(),
        url: serviceWorker.url(),
      });
    }
  });

  const extensionId = new URL(serviceWorker.url()).host;

  await installUpworkMockProxy(context, opts.mockBaseUrl);
  await seedUpworkAuthCookies(context);

  return {
    context,
    extensionId,
    serviceWorker,
    manifest,
    userDataDir,
    errors,
    clearErrors(): void {
      errors.length = 0;
    },
    getExtensionUrl(relativePath: string): string {
      const normalized = relativePath.replace(/^\//, '');
      return `chrome-extension://${extensionId}/${normalized}`;
    },
    async close(): Promise<void> {
      try {
        await context.close();
      } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
      }
    },
  };
}
