import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalBunSpawn = Bun.spawn;
const originalBunWhich = Bun.which;

type DeployStatusEntry = {
  service: string;
  status: string;
  label: string;
};

function createSpawnResult() {
  return {
    pid: 0,
    exited: Promise.resolve(0),
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => {},
    ref: () => {},
    unref: () => {},
    [Symbol.asyncDispose]: async () => {},
    resourceUsage: () => undefined,
  };
}

describe('bootstrapInstall', () => {
  let tempBase: string;
  let configHome: string;
  let dataHome: string;
  let stateHome: string;
  let workDir: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'openpalm-install-command-'));
    configHome = join(tempBase, 'config');
    dataHome = join(tempBase, 'data');
    stateHome = join(tempBase, 'state');
    workDir = join(tempBase, 'work');

    Bun.which = mock((_cmd: string) => '/usr/bin/docker') as typeof Bun.which;
    Bun.spawn = mock((_cmd: string[] | readonly string[], _opts?: unknown) => (
      createSpawnResult()
    )) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalBunSpawn;
    Bun.which = originalBunWhich;
    rmSync(tempBase, { recursive: true, force: true });
  });

  it('initializes setup deploy status before pulling services', async () => {
    const updateDeployStatus = mock((_entries: DeployStatusEntry[]) => {});
    const setDeployError = mock((_error: string) => {});
    const markAllRunning = mock(() => {});
    const stop = mock(() => {});
    const runDockerCompose = mock(async (_args: string[]) => {});

    mock.module('citty', () => ({
      defineCommand: <T>(command: T) => command,
    }));

    mock.module('../lib/paths.ts', () => ({
      defaultConfigHome: () => configHome,
      defaultDataHome: () => dataHome,
      defaultStateHome: () => stateHome,
      defaultWorkDir: () => workDir,
    }));

    mock.module('../lib/env.ts', () => ({
      ensureSecrets: async (targetConfigHome: string) => {
        writeFileSync(join(targetConfigHome, 'secrets.env'), 'OPENPALM_ADMIN_TOKEN=\n');
      },
      ensureStackEnv: async () => {},
      loadAdminToken: async () => null,
    }));

    mock.module('../lib/admin.ts', () => ({
      isAdminReachable: async () => false,
      adminRequest: async () => ({ ok: true }),
    }));

    mock.module('../lib/docker.ts', () => ({
      ensureDirectoryTree: async () => {
        for (const dir of [
          configHome,
          dataHome,
          join(dataHome, 'admin'),
          join(dataHome, 'assistant'),
          join(dataHome, 'automations'),
          join(dataHome, 'caddy'),
          stateHome,
          join(stateHome, 'artifacts'),
          join(stateHome, 'bin'),
          workDir,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
      },
      fetchAsset: async (_repoRef: string, filename: string) => `${filename}\n`,
      runDockerCompose,
      openBrowser: async () => {},
    }));

    mock.module('@openpalm/lib', () => ({
      ensureOpenCodeConfig: () => {},
      ensureOpenCodeSystemConfig: () => {},
      ensureAdminOpenCodeConfig: () => {},
      FilesystemAssetProvider: class FilesystemAssetProvider {},
    }));

    mock.module('../lib/varlock.ts', () => ({
      ensureVarlock: async () => join(tempBase, 'varlock'),
      prepareVarlockDir: async () => {
        const varlockDir = join(tempBase, 'varlock-dir');
        mkdirSync(varlockDir, { recursive: true });
        return varlockDir;
      },
    }));

    mock.module('../lib/host-info.ts', () => ({
      detectHostInfo: async () => ({ platform: 'linux' }),
    }));

    mock.module('../lib/staging.ts', () => ({
      ensureStagedState: async () => ({}),
      fullComposeArgs: () => ['--project-name', 'openpalm'],
      buildManagedServiceNames: () => ['caddy', 'memory'],
    }));

    mock.module('../setup-wizard/server.ts', () => ({
      createSetupServer: () => ({
        server: { port: 8100 },
        waitForComplete: async () => ({ ok: true }),
        stop,
        updateDeployStatus,
        setDeployError,
        markAllRunning,
      }),
    }));

    const { bootstrapInstall } = await import('./install.ts');

    await expect(
      bootstrapInstall({
        force: true,
        version: 'main',
        noStart: false,
        noOpen: true,
      }),
    ).resolves.toBeUndefined();

    expect(updateDeployStatus).toHaveBeenCalledTimes(2);
    expect(updateDeployStatus.mock.calls[0]?.[0]).toEqual([
      { service: 'caddy', status: 'pending', label: 'Waiting...' },
      { service: 'memory', status: 'pending', label: 'Waiting...' },
      { service: 'admin', status: 'pending', label: 'Waiting...' },
      { service: 'docker-socket-proxy', status: 'pending', label: 'Waiting...' },
    ]);
    expect(runDockerCompose.mock.calls[0]?.[0]).toEqual([
      '--project-name',
      'openpalm',
      '--profile',
      'admin',
      'pull',
      'caddy',
      'memory',
      'admin',
      'docker-socket-proxy',
    ]);
    expect(markAllRunning).toHaveBeenCalledTimes(1);
    expect(setDeployError).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
