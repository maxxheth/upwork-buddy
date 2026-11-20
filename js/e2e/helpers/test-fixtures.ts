import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { type MockServerHandle, startMockUpworkServer } from '../server/mock-upwork-server.ts';
import { buildDaemonBinary, type DaemonHandle, startWorkerDaemon } from './daemon.ts';
import { createWorkerDb, type WorkerDbHandle } from './db.ts';
import { type ExtensionContextHandle, launchExtensionContext } from './extension.ts';
import { createExtensionPages, type ExtensionPages } from './extension-pages.ts';
import { type McpClient, McpHttpClient, McpStdioClient } from './mcp-client.ts';
import { MockControlClient } from './mock-client.ts';
import { getSessionStatus, pairExtensionWithDaemon } from './pairing.ts';
import { seedUpworkAuthCookies } from './upwork-route.ts';

export interface WorkerFixtures {
  workerDb: WorkerDbHandle;
  mockServer: MockServerHandle;
  mockClient: MockControlClient;
  daemon: DaemonHandle;
  extensionCtx: ExtensionContextHandle;
}

export interface TestFixtures {
  resetState: undefined;
  pairedExtension: ExtensionContextHandle;
  extPages: ExtensionPages;
  mcpHttp: McpClient;
  createMcpHttpClient: () => Promise<McpClient>;
  createMcpStdioClient: () => Promise<McpClient>;
  upworkPage: Page;
}

function resolveRepoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerDb: [
    async ({ playwright: _playwright }, use, workerInfo) => {
      const runId = process.env.E2E_RUN_ID ?? String(Date.now());
      const db = await createWorkerDb(workerInfo.workerIndex, runId);
      try {
        await use(db);
      } finally {
        await db.close();
      }
    },
    { scope: 'worker' },
  ],

  mockServer: [
    async ({ workerDb: _workerDb }, use) => {
      const server = await startMockUpworkServer(0);
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],

  mockClient: [
    async ({ mockServer }, use) => {
      const client = new MockControlClient(mockServer.baseUrl);
      await use(client);
    },
    { scope: 'worker' },
  ],

  daemon: [
    async ({ workerDb }, use, workerInfo) => {
      const repoRoot = resolveRepoRoot();
      let binaryPath = process.env.E2E_DAEMON_BINARY;
      if (!binaryPath) {
        binaryPath = await buildDaemonBinary(
          repoRoot,
          path.join(repoRoot, 'dist', `upwork-buddy-e2e-w${workerInfo.workerIndex}`),
        );
      }
      const handle = await startWorkerDaemon({
        binaryPath,
        dbConfig: workerDb.config,
        repoRoot,
        policyMode: 'confirm_in_ui',
      });
      try {
        await use(handle);
      } finally {
        await handle.cleanup();
      }
    },
    { scope: 'worker' },
  ],

  extensionCtx: [
    async ({ mockServer }, use) => {
      const repoRoot = resolveRepoRoot();
      const extensionPath = path.join(repoRoot, 'js', '.output', 'chrome-mv3');
      const ext = await launchExtensionContext({
        extensionPath,
        mockBaseUrl: mockServer.baseUrl,
      });
      try {
        await use(ext);
      } finally {
        await ext.close();
      }
    },
    { scope: 'worker' },
  ],

  resetState: [
    async ({ workerDb, mockClient, extensionCtx }, use) => {
      await workerDb.truncateAll();
      await mockClient.reset();
      await seedUpworkAuthCookies(extensionCtx.context);
      extensionCtx.clearErrors();
      await use(undefined);
    },
    { auto: true },
  ],

  pairedExtension: async ({ extensionCtx, daemon }, use) => {
    let connected = false;
    try {
      const status = await getSessionStatus(daemon);
      connected = status.extension_connected;
    } catch {
      connected = false;
    }
    if (!connected) {
      await pairExtensionWithDaemon(extensionCtx, daemon, { pacingSeconds: 0.1 });
    }
    await use(extensionCtx);
  },

  extPages: async ({ extensionCtx }, use) => {
    await use(createExtensionPages(extensionCtx));
  },

  mcpHttp: async ({ daemon }, use) => {
    const client = new McpHttpClient(daemon.mcpUrl, daemon.apiToken);
    await client.initialize();
    try {
      await use(client);
    } finally {
      await client.close();
    }
  },

  createMcpHttpClient: async ({ daemon }, use) => {
    const created: McpClient[] = [];
    await use(async () => {
      const client = new McpHttpClient(daemon.mcpUrl, daemon.apiToken);
      await client.initialize();
      created.push(client);
      return client;
    });
    for (const client of created) {
      await client.close();
    }
  },

  createMcpStdioClient: async ({ daemon }, use) => {
    const created: McpClient[] = [];
    await use(async () => {
      const client = new McpStdioClient(daemon.binaryPath, daemon.env);
      await client.initialize();
      created.push(client);
      return client;
    });
    for (const client of created) {
      await client.close();
    }
  },

  upworkPage: async ({ extensionCtx }, use) => {
    const page = await extensionCtx.context.newPage();
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});

export { expect };
