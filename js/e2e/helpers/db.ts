import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkerDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  url: string;
}

export interface WorkerDbHandle {
  readonly config: WorkerDbConfig;
  truncateAll(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

export const DEFAULT_E2E_PG_PORT = 5444;
export const E2E_DOMAIN_TABLES: readonly string[] = [
  'uidiagnostic_captures',
  'action_audit_logs',
  'selector_audits',
  'generated_agents',
  'messages',
  'message_threads',
  'proposals',
  'search_profiles',
  'jobs',
  'portfolio_items',
  'profiles',
  'users',
] as const;

const CONTAINER_NAME = 'upwork_buddy_e2e_pg';
const DEFAULT_USER = 'e2e_user';
const DEFAULT_PASS = 'e2e_pass';
const DEFAULT_ADMIN_DB = 'postgres';

function resolveRepoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function assertSafePostgresTarget(urlStr: string): WorkerDbConfig {
  const parsed = new URL(urlStr);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  const database = parsed.pathname.replace(/^\/+|\/+$/g, '') || DEFAULT_ADMIN_DB;
  if (port === 5432) {
    throw new Error('Refusing to connect E2E tests to host Postgres port 5432');
  }
  if (database.toLowerCase() === 'upwork_buddy') {
    throw new Error('Refusing to connect E2E tests to dev database "upwork_buddy"');
  }
  return {
    host: parsed.hostname || '127.0.0.1',
    port,
    user: decodeURIComponent(parsed.username || DEFAULT_USER),
    password: decodeURIComponent(parsed.password || DEFAULT_PASS),
    database,
    url: urlStr,
  };
}

function buildDsn(cfg: Omit<WorkerDbConfig, 'url'>, database: string): string {
  const encodedUser = encodeURIComponent(cfg.user);
  const encodedPass = encodeURIComponent(cfg.password);
  return `postgres://${encodedUser}:${encodedPass}@${cfg.host}:${cfg.port}/${database}?sslmode=disable`;
}

async function runPsql(dsn: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'psql',
    [dsn, '-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

async function waitForPostgres(dsn: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await runPsql(dsn, 'SELECT 1;');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Timed out waiting for isolated E2E Postgres: ${msg}`);
}

function formatSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(`Invalid numeric SQL parameter: ${val}`);
    }
    return String(val);
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return `'${str.replaceAll("'", "''")}'`;
}

function interpolateParams(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (full, idxStr: string) => {
    const idx = Number.parseInt(idxStr, 10) - 1;
    if (idx < 0 || idx >= params.length) {
      return full;
    }
    return formatSqlLiteral(params[idx]);
  });
}

export async function ensureTestPostgresReady(): Promise<WorkerDbConfig> {
  const envUrl = process.env.E2E_PG_ADMIN_URL;
  if (envUrl) {
    const cfg = assertSafePostgresTarget(envUrl);
    await waitForPostgres(cfg.url, 15_000);
    return cfg;
  }

  const pgPort = process.env.E2E_PG_PORT
    ? Number.parseInt(process.env.E2E_PG_PORT, 10)
    : DEFAULT_E2E_PG_PORT;
  if (pgPort === 5432) {
    throw new Error('E2E_PG_PORT must never be 5432');
  }

  const adminConfig: WorkerDbConfig = {
    host: '127.0.0.1',
    port: pgPort,
    user: DEFAULT_USER,
    password: DEFAULT_PASS,
    database: DEFAULT_ADMIN_DB,
    url: `postgres://${DEFAULT_USER}:${DEFAULT_PASS}@127.0.0.1:${pgPort}/${DEFAULT_ADMIN_DB}?sslmode=disable`,
  };

  let containerRunning = false;
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{.State.Running}}',
      CONTAINER_NAME,
    ]);
    containerRunning = stdout.trim() === 'true';
  } catch {
    containerRunning = false;
  }

  if (!containerRunning) {
    try {
      await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]);
    } catch {
      // ignore if absent
    }
    await execFileAsync('docker', [
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-p',
      `127.0.0.1:${pgPort}:5432`,
      '-e',
      `POSTGRES_USER=${DEFAULT_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${DEFAULT_PASS}`,
      '-e',
      `POSTGRES_DB=${DEFAULT_ADMIN_DB}`,
      'postgres:17-alpine',
    ]);
    process.env.E2E_MANAGED_PG_CONTAINER = '1';
  }

  await waitForPostgres(adminConfig.url, 30_000);
  return adminConfig;
}

export async function teardownManagedTestPostgres(): Promise<void> {
  if (process.env.E2E_MANAGED_PG_CONTAINER !== '1') {
    return;
  }
  try {
    await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]);
  } catch {
    // ignore cleanup error
  }
  delete process.env.E2E_MANAGED_PG_CONTAINER;
}

export async function createWorkerDb(workerIndex: number, runId: string): Promise<WorkerDbHandle> {
  const adminConfig = await ensureTestPostgresReady();
  const safeRunId = runId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const rawDbName = `upwork_buddy_e2e_w${workerIndex}_${safeRunId}`;
  const dbName =
    rawDbName.length <= 63
      ? rawDbName
      : `${rawDbName.slice(0, 54)}_${crypto.createHash('sha256').update(rawDbName).digest('hex').slice(0, 8)}`;

  await runPsql(adminConfig.url, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`);
  await runPsql(adminConfig.url, `CREATE DATABASE "${dbName}";`);

  const workerUrl = buildDsn(adminConfig, dbName);
  const workerConfig: WorkerDbConfig = {
    host: adminConfig.host,
    port: adminConfig.port,
    user: adminConfig.user,
    password: adminConfig.password,
    database: dbName,
    url: workerUrl,
  };

  const repoRoot = resolveRepoRoot();
  const migrationsDir = path.join(repoRoot, 'internal', 'database', 'migrations', 'app');

  await execFileAsync('atlas', [
    'migrate',
    'apply',
    '--dir',
    `file://${migrationsDir}`,
    '--url',
    workerUrl,
  ]);

  return {
    config: workerConfig,
    async truncateAll(): Promise<void> {
      const truncateSql = `
        DO $$
        DECLARE
          tbl text;
        BEGIN
          FOR tbl IN
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename <> 'atlas_schema_revisions'
          LOOP
            EXECUTE 'TRUNCATE TABLE ' || quote_ident(tbl) || ' RESTART IDENTITY CASCADE';
          END LOOP;
        END
        $$;
      `;
      await runPsql(workerUrl, truncateSql);
    },
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const cleanedSql = sql.trim().replace(/;+\s*$/, '');
      const interpolated = params.length > 0 ? interpolateParams(cleanedSql, params) : cleanedSql;
      const isRowQuery = /^(select|with|table|values)\b/i.test(interpolated);
      const hasReturning = /\breturning\b/i.test(interpolated);

      if (!isRowQuery && !hasReturning) {
        await runPsql(workerUrl, `${interpolated};`);
        return [];
      }

      const wrappedSql = isRowQuery
        ? `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${interpolated}) q;`
        : `WITH q AS (${interpolated}) SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM q;`;
      const out = await runPsql(workerUrl, wrappedSql);
      const trimmed = out.trim();
      if (!trimmed) {
        return [];
      }
      return JSON.parse(trimmed) as T[];
    },
    async close(): Promise<void> {
      try {
        await runPsql(
          adminConfig.url,
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
        );
      } catch {
        // ignore termination failure
      }
      await runPsql(adminConfig.url, `DROP DATABASE IF EXISTS "${dbName}";`);
    },
  };
}
