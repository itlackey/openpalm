import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { resolveCacheHome } from '@openpalm/lib';

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Creates the full directory tree required by the stack.
 * Uses the caller-provided directory roots, then adds CLI-specific extras.
 */
export async function ensureDirectoryTree(
  homeDir: string,
  configDir: string,
  vaultDir: string,
  dataDir: string,
  workDir: string,
): Promise<void> {
  const cacheDir = resolveCacheHome();

  for (const dir of [
    homeDir,
    configDir,
    join(configDir, 'automations'),
    join(configDir, 'assistant'),
    join(configDir, 'assistant', 'tools'),
    join(configDir, 'assistant', 'plugins'),
    join(configDir, 'assistant', 'skills'),
    join(configDir, 'guardian'),
    vaultDir,
    join(vaultDir, 'user'),
    join(vaultDir, 'stack'),
    join(vaultDir, 'stack', 'addons'),
    dataDir,
    join(dataDir, 'assistant'),
    join(dataDir, 'admin'),
    join(dataDir, 'memory'),
    join(dataDir, 'guardian'),
    join(dataDir, 'stash'),
    join(homeDir, 'stack'),
    join(homeDir, 'stack', 'addons'),
    join(homeDir, 'registry'),
    join(homeDir, 'registry', 'addons'),
    join(homeDir, 'registry', 'automations'),
    join(homeDir, 'backups'),
    join(homeDir, 'logs'),
    join(homeDir, 'logs', 'opencode'),
    cacheDir,
    join(cacheDir, 'rollback'),
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
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/${filename}`;

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

// composeProjectArgs() removed — use fullComposeArgs(state) from cli-compose.ts instead.
// That function builds the correct file list including channel overlays and env files.

// ensureOpenCodeConfig and ensureOpenCodeSystemConfig are imported from @openpalm/lib.
// See packages/lib/src/control-plane/secrets.ts and core-assets.ts.

/**
 * Downloads the .openpalm/ directory from GitHub and seeds it into homeDir.
 *
 * Mapping:
 *   .openpalm/stack/core.compose.yml → homeDir/stack/core.compose.yml
 *   .openpalm/registry/              → homeDir/registry/
 *   .openpalm/vault/   → homeDir/vault/   (schemas only)
 *
 * Also seeds assistant config files from core/assistant/opencode/.
 */
/**
 * Download latest assets from GitHub. Optional — embedded assets in lib
 * provide the baseline. This upgrades to the latest release versions.
 */
export async function seedOpenPalmDir(
  repoRef: string,
  homeDir: string,
  configDir: string,
  vaultDir: string,
  dataDir: string,
): Promise<void> {
  const tarballUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${repoRef}.tar.gz`;
  const tmpDir = join(homeDir, '.seed-tmp');
  const tmpTar = join(tmpDir, 'repo.tar.gz');

  try {
    await mkdir(tmpDir, { recursive: true });

    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Failed to download tarball (HTTP ${res.status})`);
    await Bun.write(tmpTar, res);

    const extractProc = Bun.spawn(
      ['tar', 'xzf', tmpTar, '--strip-components=1', '--wildcards',
        '*/.openpalm/stack/core.compose.yml', '*/.openpalm/registry/*', '*/.openpalm/vault/*', '*/core/assistant/opencode/*'],
      { cwd: tmpDir, stdout: 'ignore', stderr: 'pipe' },
    );
    await extractProc.exited;

    const srcCoreCompose = join(tmpDir, '.openpalm', 'stack', 'core.compose.yml');
    if (!await Bun.file(srcCoreCompose).exists()) {
      throw new Error('core.compose.yml not found in downloaded assets');
    }
    await mkdir(join(homeDir, 'stack'), { recursive: true });
    await writeFile(join(homeDir, 'stack', 'core.compose.yml'), new Uint8Array(await Bun.file(srcCoreCompose).arrayBuffer()));

    const srcRegistry = join(tmpDir, '.openpalm', 'registry');
    if (await dirExists(srcRegistry)) {
      await copyTree(srcRegistry, join(homeDir, 'registry'));
    }

    const srcVault = join(tmpDir, '.openpalm', 'vault');
    if (await dirExists(srcVault)) {
      await copyTree(srcVault, vaultDir, { onlyPattern: /\.schema$/ });
    }

    const srcAssistant = join(tmpDir, 'core', 'assistant', 'opencode');
    if (await dirExists(srcAssistant)) {
      await copyTree(srcAssistant, join(dataDir, 'assistant'));
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(join(path, '.')).exists();
    // Bun.file().exists() doesn't work for dirs, use a different check
    const proc = Bun.spawn(['test', '-d', path], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch { return false; }
}

async function copyTree(
  src: string,
  dest: string,
  opts?: { skipExisting?: boolean; onlyPattern?: RegExp },
): Promise<void> {
  const proc = Bun.spawn(['find', src, '-type', 'f'], { stdout: 'pipe' });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  for (const srcFile of output.trim().split('\n').filter(Boolean)) {
    const rel = relative(src, srcFile);
    if (opts?.onlyPattern && !opts.onlyPattern.test(rel)) continue;
    const destFile = join(dest, rel);
    if (opts?.skipExisting && await Bun.file(destFile).exists()) continue;
    await mkdir(dirname(destFile), { recursive: true });
    const content = await Bun.file(srcFile).arrayBuffer();
    await writeFile(destFile, new Uint8Array(content));
  }
}

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
