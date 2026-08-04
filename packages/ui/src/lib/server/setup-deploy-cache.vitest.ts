import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlPlaneState, DeployProgress } from '@openpalm/lib';
import type { RequestEvent } from '@sveltejs/kit';

const runDeployMock = vi.hoisted(() => vi.fn());

vi.mock('@openpalm/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...actual,
    runDeploy: runDeployMock,
    composePs: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 })),
  };
});

import { getDeployState, resetDeployState, startDeploy } from './setup-deploy.js';
import { getCachedLocalInstallState, resolveRequestLanding, _resetLaunchCache } from './landing.js';
import { _replaceState } from './state.js';

let homeDir = '';

afterEach(() => {
  runDeployMock.mockReset();
  resetDeployState();
  _resetLaunchCache();
  delete process.env.OP_ENABLE_ADMIN;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

describe('setup deployment launch transition', () => {
  test('successful completion invalidates a cached not_installed classification', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-setup-deploy-cache-'));
    const state: ControlPlaneState = {
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
    _replaceState(state);
    process.env.OP_ENABLE_ADMIN = '1';
    const url = new URL('http://localhost:3880/host');
    const event = {
      url,
      request: new Request(url, { headers: { host: 'localhost:3880', accept: 'text/html' } }),
    } as RequestEvent;
    expect(getCachedLocalInstallState(state.stackDir, homeDir)).toBe('not_installed');
    // Nothing installed and nothing recorded: this is a client, so it lands on
    // onboarding rather than a host surface.
    await expect(resolveRequestLanding(event)).resolves.toBe('/connections/new');

    runDeployMock.mockImplementation(async (
      _state: ControlPlaneState,
      options: {
        markSetupComplete?: () => void;
        onUpdate?: (progress: DeployProgress) => void;
      },
    ) => {
      mkdirSync(state.stackDir, { recursive: true });
      writeFileSync(join(state.stackDir, 'core.compose.yml'), 'services: {}\n');
      options.markSetupComplete?.();
      const progress: DeployProgress = {
        deploying: false,
        setupComplete: true,
        deployStatus: [],
        deployError: null,
        imageWarning: null,
        phase: 'ready',
        startedAt: null,
        pid: null,
      };
      options.onUpdate?.(progress);
      return progress;
    });

    startDeploy(state);
    await vi.waitFor(() => expect(getDeployState().setupComplete).toBe(true));
    expect(getCachedLocalInstallState(state.stackDir, homeDir)).toBe('installed');
    await expect(resolveRequestLanding(event)).resolves.toBe('/host');
  });
});
