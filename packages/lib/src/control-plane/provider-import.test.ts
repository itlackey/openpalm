import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';
import { GUARDIAN_INGRESS_ADDON_IDS } from './addon-ids.js';
import type { ControlPlaneState } from './types.js';

const realCheckDocker = realDocker.checkDocker;
const realComposeRestart = realDocker.composeRestart;
let homeDir = '';

afterEach(() => {
  mock.restore();
  mock.module('./docker.js', () => ({
    ...realDocker,
    checkDocker: realCheckDocker,
    composeRestart: realComposeRestart,
  }));
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

function makeState(enabledAddons = ''): ControlPlaneState {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-provider-import-'));
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(join(homeDir, 'state', 'stack.env'), `OP_ENABLED_ADDONS=${enabledAddons}\n`);
  return {
    homeDir,
    configDir: join(homeDir, 'config'),
    stashDir: join(homeDir, 'knowledge'),
    workspaceDir: join(homeDir, 'workspace'),
    dataDir: join(homeDir, 'data'),
    stackDir: join(homeDir, 'system', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

async function loadWithDockerMocks(input?: {
  dockerOk?: boolean;
  restart?: (services: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;
}) {
  const checkDockerMock = mock(async () => ({
    ok: input?.dockerOk ?? true,
    stdout: '',
    stderr: input?.dockerOk === false ? 'daemon unavailable' : '',
    code: input?.dockerOk === false ? 1 : 0,
  }));
  const composeRestartMock = mock(input?.restart ?? (async () => ({ ok: true, stdout: '', stderr: '', code: 0 })));
  mock.module('./docker.js', () => ({
    ...realDocker,
    checkDocker: checkDockerMock,
    composeRestart: composeRestartMock,
  }));
  const module = await import(`./provider-import.js?provider-import-test=${Math.random()}`);
  return { ...module, checkDockerMock, composeRestartMock };
}

describe('restartProviderConsumers', () => {
  test('restarts only assistant when no guardian-ingress addon is enabled', async () => {
    const state = makeState('voice');
    const { restartProviderConsumers, composeRestartMock } = await loadWithDockerMocks();

    expect(await restartProviderConsumers(state, { config: true, auth: false })).toEqual({ restarted: ['assistant'], failed: [] });
    expect(composeRestartMock).toHaveBeenCalledTimes(1);
    expect(composeRestartMock).toHaveBeenCalledWith(['assistant'], expect.any(Object));
  });

  test('restarts guardian for every guardian-ingress addon', async () => {
    const state = makeState();
    const { restartProviderConsumers, composeRestartMock } = await loadWithDockerMocks();

    for (const addon of GUARDIAN_INGRESS_ADDON_IDS) {
      writeFileSync(join(homeDir, 'state', 'stack.env'), `OP_ENABLED_ADDONS=${addon}\n`);
      composeRestartMock.mockClear();
      expect(await restartProviderConsumers(state, { config: false, auth: true })).toEqual({
        restarted: ['assistant', 'guardian'],
        failed: [],
      });
      expect(composeRestartMock).toHaveBeenNthCalledWith(1, ['assistant'], expect.any(Object));
      expect(composeRestartMock).toHaveBeenNthCalledWith(2, ['guardian'], expect.any(Object));
    }
  });

  test('reports every required consumer when Docker is unavailable', async () => {
    const state = makeState('discord');
    const { restartProviderConsumers, composeRestartMock } = await loadWithDockerMocks({ dockerOk: false });

    expect(await restartProviderConsumers(state, { config: false, auth: true })).toEqual({
      restarted: [],
      failed: [
        { service: 'assistant', error: 'docker unavailable' },
        { service: 'guardian', error: 'docker unavailable' },
      ],
    });
    expect(composeRestartMock).not.toHaveBeenCalled();
  });

  test('continues after an individual restart failure', async () => {
    const state = makeState('discord');
    const { restartProviderConsumers } = await loadWithDockerMocks({
      restart: async (services) => services[0] === 'assistant'
        ? { ok: false, stdout: '', stderr: 'assistant restart failed', code: 1 }
        : { ok: true, stdout: '', stderr: '', code: 0 },
    });

    expect(await restartProviderConsumers(state, { config: false, auth: true })).toEqual({
      restarted: ['guardian'],
      failed: [{ service: 'assistant', error: 'assistant restart failed' }],
    });
  });

  test('does not touch Docker when the import changed no durable input', async () => {
    const state = makeState('discord');
    const { restartProviderConsumers, checkDockerMock, composeRestartMock } = await loadWithDockerMocks();

    expect(await restartProviderConsumers(state, { config: false, auth: false })).toEqual({
      restarted: [],
      failed: [],
    });
    expect(checkDockerMock).not.toHaveBeenCalled();
    expect(composeRestartMock).not.toHaveBeenCalled();
  });

  test('does not restart Guardian for an Assistant-only config change', async () => {
    const state = makeState('discord');
    const { restartProviderConsumers, composeRestartMock } = await loadWithDockerMocks();

    expect(await restartProviderConsumers(state, { config: true, auth: false })).toEqual({
      restarted: ['assistant'],
      failed: [],
    });
    expect(composeRestartMock).toHaveBeenCalledTimes(1);
    expect(composeRestartMock).toHaveBeenCalledWith(['assistant'], expect.any(Object));
  });
});
