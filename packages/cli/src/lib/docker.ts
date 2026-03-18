import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureXdgDirs } from '@openpalm/lib';

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Creates the full XDG directory tree required by the stack.
 * Delegates to @openpalm/lib for core dirs, then adds CLI-specific extras.
 */
export async function ensureDirectoryTree(
  _configHome: string,
  _dataHome: string,
  stateHome: string,
  workDir: string,
): Promise<void> {
  // Core XDG dirs (CONFIG_HOME, DATA_HOME, STATE_HOME subtrees)
  ensureXdgDirs();

  // CLI-specific extras not in lib
  for (const dir of [
    join(stateHome, 'bin'),
    workDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Fetches a URL with retries and exponential backoff. Only retries on 5xx or network errors.
 */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.ok || res.status < 500) return res;
      if (i < retries - 1) await Bun.sleep(200 * 2 ** i);
    } catch (err) {
      if (i === retries - 1) throw err;
      await Bun.sleep(200 * 2 ** i);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

/**
 * Downloads an asset from a GitHub release, falling back to raw.githubusercontent.com.
 */
export async function fetchAsset(repoRef: string, filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/assets/${filename}`;

  try {
    const releaseResponse = await fetchWithRetry(releaseUrl);
    if (releaseResponse.ok) return await releaseResponse.text();
  } catch {
    // Fall through to raw URL
  }

  const rawResponse = await fetchWithRetry(rawUrl);
  if (rawResponse.ok) return await rawResponse.text();

  throw new Error(`Failed to download ${filename} from ${repoRef}`);
}

/**
 * Runs a `docker compose` command with inherited stdio. Throws on non-zero exit.
 */
export async function runDockerCompose(args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${code}`);
  }
}

/**
 * Runs a `docker compose` command and captures stdout as a string.
 * Throws on non-zero exit.
 */
export async function runDockerComposeCapture(args: string[]): Promise<string> {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${code}`);
  }
  return output;
}

// composeProjectArgs() removed — use fullComposeArgs(state) from staging.ts instead.
// That function builds the correct file list including channel overlays and staged env files.

// ensureOpenCodeConfig and ensureOpenCodeSystemConfig are imported from @openpalm/lib.
// See packages/lib/src/control-plane/secrets.ts and core-assets.ts.

/**
 * Opens a URL in the user's default browser. Best-effort, never throws.
 */
export async function openBrowser(url: string): Promise<void> {
  console.log(`Opening ${url} in your browser...`);
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    if (platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Best effort
  }
}
