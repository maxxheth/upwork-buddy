import { type ChildProcess, execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerDbConfig } from './db.ts';

const execFileAsync = promisify(execFile);

export interface DaemonSpawnOptions {
  binaryPath: string;
  dbConfig: WorkerDbConfig;
  repoRoot: string;
  policyMode?: 'confirm_in_ui' | 'draft_only' | 'auto_with_guardrails';
  extraEnv?: Record<string, string>;
}

export interface DaemonHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly mcpUrl: string;
  readonly apiToken: string;
  readonly binaryPath: string;
  readonly homeDir: string;
  readonly selectorsYamlPath: string;
  readonly env: NodeJS.ProcessEnv;
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  waitForHealthy(timeoutMs?: number): Promise<{ status: string; db?: string }>;
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  updateSelectorsYaml(mutator: (yamlText: string) => string): Promise<void>;
  restoreSelectorsYaml(): Promise<void>;
  getRedactedLogs(): string;
  cleanup(): Promise<void>;
}

export async function allocateEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate ephemeral port')));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function buildDaemonBinary(repoRoot: string, outPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await execFileAsync('go', ['build', '-o', outPath, './cmd/api'], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  await fs.chmod(outPath, 0o755);
  return outPath;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function startWorkerDaemon(opts: DaemonSpawnOptions): Promise<DaemonHandle> {
  const port = await allocateEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/extension`;
  const mcpUrl = `${baseUrl}/mcp`;
  const apiToken = crypto.randomBytes(32).toString('hex');

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upwork-buddy-e2e-daemon-'));
  const homeDir = path.join(workDir, 'home');
  const xdgConfigHome = path.join(workDir, 'xdg');
  const selectorsDir = path.join(workDir, 'selectors');
  const diagnosticsDir = path.join(workDir, 'diagnostics');
  const selectorsYamlPath = path.join(selectorsDir, 'upwork.yaml');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(xdgConfigHome, { recursive: true });
  await fs.mkdir(selectorsDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });

  const repoSelectorsPath = path.join(opts.repoRoot, 'configs', 'selectors', 'upwork.yaml');
  const hasRepoSelectors = await fileExists(repoSelectorsPath);
  let originalSelectorsYaml = '';
  if (hasRepoSelectors) {
    originalSelectorsYaml = await fs.readFile(repoSelectorsPath, 'utf8');
    await fs.writeFile(selectorsYamlPath, originalSelectorsYaml, 'utf8');
  }

  const templatesPath = path.join(opts.repoRoot, 'templates.yaml');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgConfigHome,
    APP_HOST: '127.0.0.1',
    APP_PORT: String(port),
    PORT: String(port),
    APP_ENV: 'test',
    DATABASE_URL: opts.dbConfig.url,
    APP_DB_HOST: opts.dbConfig.host,
    APP_DB_PORT: String(opts.dbConfig.port),
    APP_DB_USERNAME: opts.dbConfig.user,
    APP_DB_PASSWORD: opts.dbConfig.password,
    APP_DB_DATABASE: opts.dbConfig.database,
    BUDDY_API_TOKEN: apiToken,
    BUDDY_TOKEN_PATH: path.join(workDir, 'token'),
    POLICY_MODE: opts.policyMode ?? 'confirm_in_ui',
    MCP_ENABLED: 'true',
    CORS_ALLOWED_ORIGINS: 'chrome-extension://*,moz-extension://*',
    TEMPLATES_PATH: templatesPath,
    DIAGNOSTICS_DIR: diagnosticsDir,
    ...(hasRepoSelectors ? { SELECTORS_PATH: selectorsYamlPath } : {}),
    ...(opts.extraEnv ?? {}),
  };

  let child: ChildProcess | null = null;
  let running = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const spawnProcess = (): void => {
    if (child && running) {
      return;
    }
    const spawned = spawn(opts.binaryPath, ['serve'], {
      cwd: workDir, // Empty temp dir blocks godotenv/autoload from reading repo .env
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    running = true;

    spawned.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString('utf8'));
    });
    spawned.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });
    spawned.once('exit', () => {
      running = false;
      if (child === spawned) {
        child = null;
      }
    });
  };

  const stopProcess = async (): Promise<void> => {
    const active = child;
    if (!active || !running) {
      running = false;
      child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          running = false;
          child = null;
          resolve();
        }
      };

      active.once('exit', finish);
      active.kill('SIGTERM');

      const forceTimer = setTimeout(() => {
        if (!settled) {
          active.kill('SIGKILL');
        }
      }, 5_000);
      forceTimer.unref();
    });
  };

  const waitForHealthy = async (timeoutMs = 15_000): Promise<{ status: string; db?: string }> => {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'Daemon did not respond';
    while (Date.now() < deadline) {
      if (!running && child === null) {
        throw new Error(`Daemon exited before becoming healthy.\nLogs:\n${getRedactedLogs()}`);
      }
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.status === 200) {
          const body = (await res.json()) as { status?: string; db?: string };
          if (body.status === 'ok' || body.status === 'up') {
            return { status: body.status, db: body.db };
          }
          lastError = `Unexpected health payload: ${JSON.stringify(body)}`;
        } else {
          lastError = `HTTP ${res.status}`;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      `Timed out waiting for daemon /health (${lastError}).\nLogs:\n${getRedactedLogs()}`,
    );
  };

  const getRedactedLogs = (): string => {
    const redact = (text: string): string =>
      text ? text.split(apiToken).join('***REDACTED***') : '';
    const stdout = redact(stdoutChunks.join(''));
    const stderr = redact(stderrChunks.join(''));
    if (stdout && stderr) {
      return stdout.endsWith('\n') ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
    }
    return stdout || stderr;
  };

  const handle: DaemonHandle = {
    port,
    baseUrl,
    wsUrl,
    mcpUrl,
    apiToken,
    binaryPath: opts.binaryPath,
    homeDir,
    selectorsYamlPath,
    env,
    isRunning(): boolean {
      return running;
    },
    async start(): Promise<void> {
      spawnProcess();
      await waitForHealthy();
    },
    async stop(): Promise<void> {
      await stopProcess();
    },
    async restart(): Promise<void> {
      await stopProcess();
      spawnProcess();
      await waitForHealthy();
    },
    waitForHealthy,
    async apiFetch(reqPath: string, init?: RequestInit): Promise<Response> {
      const target =
        reqPath.startsWith('http://') || reqPath.startsWith('https://')
          ? reqPath
          : `${baseUrl}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`;
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) {
        headers.set('authorization', `Bearer ${apiToken}`);
      }
      return fetch(target, {
        ...init,
        headers,
      });
    },
    async updateSelectorsYaml(mutator: (yamlText: string) => string): Promise<void> {
      const current = (await fileExists(selectorsYamlPath))
        ? await fs.readFile(selectorsYamlPath, 'utf8')
        : originalSelectorsYaml;
      const updated = mutator(current);
      await fs.writeFile(selectorsYamlPath, updated, 'utf8');
    },
    async restoreSelectorsYaml(): Promise<void> {
      if (originalSelectorsYaml) {
        await fs.writeFile(selectorsYamlPath, originalSelectorsYaml, 'utf8');
      }
    },
    getRedactedLogs,
    async cleanup(): Promise<void> {
      await stopProcess();
      await fs.rm(workDir, { recursive: true, force: true });
    },
  };

  await handle.start();
  return handle;
}
