import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildDaemonBinary } from './helpers/daemon.ts';
import { ensureTestPostgresReady, teardownManagedTestPostgres } from './helpers/db.ts';

const execFileAsync = promisify(execFile);

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const jsRoot = path.join(repoRoot, 'js');
  const manifestPath = path.join(jsRoot, '.output', 'chrome-mv3', 'manifest.json');

  if (process.env.E2E_REBUILD_EXT === '1' || !(await fileExists(manifestPath))) {
    await execFileAsync('npx', ['wxt', 'build'], {
      cwd: jsRoot,
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  let builtTempDir: string | null = null;
  try {
    if (process.env.E2E_BINARY_PATH) {
      process.env.E2E_DAEMON_BINARY = process.env.E2E_BINARY_PATH;
    } else {
      builtTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upwork-buddy-e2e-bin-'));
      const binaryOutPath = path.join(builtTempDir, 'upwork-buddy');
      await buildDaemonBinary(repoRoot, binaryOutPath);
      process.env.E2E_DAEMON_BINARY = binaryOutPath;
    }

    process.env.E2E_RUN_ID = `${Date.now()}`;
    await ensureTestPostgresReady();
  } catch (err) {
    await teardownManagedTestPostgres();
    if (builtTempDir) {
      await fs.rm(builtTempDir, { recursive: true, force: true });
    }
    throw err;
  }

  return async () => {
    await teardownManagedTestPostgres();
    if (builtTempDir) {
      await fs.rm(builtTempDir, { recursive: true, force: true });
    }
  };
}
