import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfigHome, defaultStateHome } from './paths.ts';

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Creates the full XDG directory tree required by the stack.
 */
export async function ensureDirectoryTree(
  configHome: string,
  dataHome: string,
  stateHome: string,
  workDir: string,
): Promise<void> {
  const dirs = [
    configHome,
    join(configHome, 'channels'),
    join(configHome, 'assistant'),
    join(configHome, 'automations'),
    dataHome,
    join(dataHome, 'admin'),
    join(dataHome, 'memory'),
    join(dataHome, 'assistant'),
    join(dataHome, 'guardian'),
    join(dataHome, 'caddy'),
    join(dataHome, 'caddy', 'data'),
    join(dataHome, 'caddy', 'config'),
    join(dataHome, 'automations'),
    join(dataHome, 'opencode'),
    stateHome,
    join(stateHome, 'artifacts'),
    join(stateHome, 'audit'),
    join(stateHome, 'artifacts', 'channels'),
    join(stateHome, 'automations'),
    join(stateHome, 'opencode'),
    join(stateHome, 'bin'),
    workDir,
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Downloads an asset from a GitHub release, falling back to raw.githubusercontent.com.
 */
export async function fetchAsset(repoRef: string, filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/assets/${filename}`;

  const releaseResponse = await fetch(releaseUrl, { signal: AbortSignal.timeout(30000) });
  if (releaseResponse.ok) {
    return await releaseResponse.text();
  }

  const rawResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) });
  if (rawResponse.ok) {
    return await rawResponse.text();
  }

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
 * Returns the standard compose flags for --project-name, -f, and --env-file.
 */
export function composeProjectArgs(): string[] {
  const stateHome = defaultStateHome();
  const configHome = defaultConfigHome();
  return [
    '--project-name',
    'openpalm',
    '-f',
    join(stateHome, 'artifacts', 'docker-compose.yml'),
    '--env-file',
    join(configHome, 'secrets.env'),
    '--env-file',
    join(stateHome, 'artifacts', 'stack.env'),
  ];
}

/**
 * Ensures the opencode config and system config directories exist with defaults.
 */
export async function ensureOpenCodeConfig(configHome: string): Promise<void> {
  const opencodeDir = join(configHome, 'assistant');
  const configFile = join(opencodeDir, 'opencode.json');
  if (!(await Bun.file(configFile).exists())) {
    await Bun.write(configFile, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  }
  await mkdir(join(opencodeDir, 'tools'), { recursive: true });
  await mkdir(join(opencodeDir, 'plugins'), { recursive: true });
  await mkdir(join(opencodeDir, 'skills'), { recursive: true });
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const existing = await file.text();
    if (existing === content) {
      return;
    }
  }
  await Bun.write(path, content);
}

export async function ensureOpenCodeSystemConfig(dataHome: string): Promise<void> {
  const opencodeSystemDir = join(dataHome, 'assistant');
  await mkdir(opencodeSystemDir, { recursive: true });

  const systemConfig = join(opencodeSystemDir, 'opencode.jsonc');
  const systemConfigContent =
    JSON.stringify(
      {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["@openpalm/assistant-tools", "akm-opencode"],
        "permission": {
          "read": {
            "/home/opencode/.local/share/opencode/auth.json": "deny",
            "/home/opencode/.local/share/opencode/mcp-auth.json": "deny"
          }
        }
      },
      null,
      2,
    ) + "\n";
  await writeIfChanged(systemConfig, systemConfigContent);

  const agentsFile = join(opencodeSystemDir, 'AGENTS.md');
  const assetsAgentsPath = join(import.meta.dir, '..', '..', '..', 'assets', 'AGENTS.md');
  let agentsContent: string;
  if (await Bun.file(assetsAgentsPath).exists()) {
    agentsContent = await Bun.file(assetsAgentsPath).text();
  } else {
    agentsContent =
      '# OpenPalm Assistant\n\n' +
      'This file defines the assistant persona.\n' +
      'It is seeded by the CLI on first install and managed by the admin on subsequent updates.\n';
  }
  await writeIfChanged(agentsFile, agentsContent);
}

/**
 * Opens a URL in the user's default browser. Best-effort, never throws.
 */
export async function openBrowser(url: string): Promise<void> {
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
