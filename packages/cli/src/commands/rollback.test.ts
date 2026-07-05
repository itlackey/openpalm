import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realLib from '@openpalm/lib';
import * as realCliState from '../lib/cli-state.ts';
import * as realCliCompose from '../lib/cli-compose.ts';
import * as realPrompt from '../lib/prompt.ts';

const moduleUrls = {
  cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
  cliCompose: new URL('../lib/cli-compose.ts', import.meta.url).href,
  prompt: new URL('../lib/prompt.ts', import.meta.url).href,
};
const rollbackModuleUrl = new URL('./rollback.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
  // mock.restore() does NOT undo mock.module(); re-point to the real modules
  // so these mocks do not leak into other test files in the shared bun test process.
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
  mock.module(moduleUrls.cliCompose, () => ({ ...realCliCompose }));
  mock.module(moduleUrls.prompt, () => ({ ...realPrompt }));
});

describe('runRollbackAction (0.3 — non-destructive rollback confirmation)', () => {
  test('restores the snapshot when the user confirms', async () => {
    let restoreCalled = false;
    mock.module('@openpalm/lib', () => ({
      hasSnapshot: () => true,
      snapshotTimestamp: () => '2026-01-01T00:00:00.000Z',
      createState: () => ({ homeDir: '/tmp/home' }),
      restoreSnapshot: () => { restoreCalled = true; },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/home' }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({
      runComposeWithPreflight: async () => {},
    }));
    mock.module(moduleUrls.prompt, () => ({
      promptYesNo: async () => true,
    }));

    const { runRollbackAction } = await import(`${rollbackModuleUrl}?t=${Math.random()}`);
    await runRollbackAction({ yes: false });

    expect(restoreCalled).toBe(true);
  });

  test('aborts without restoring when the user declines confirmation', async () => {
    let restoreCalled = false;
    mock.module('@openpalm/lib', () => ({
      hasSnapshot: () => true,
      snapshotTimestamp: () => '2026-01-01T00:00:00.000Z',
      createState: () => ({ homeDir: '/tmp/home' }),
      restoreSnapshot: () => { restoreCalled = true; },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/home' }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({
      runComposeWithPreflight: async () => {},
    }));
    mock.module(moduleUrls.prompt, () => ({
      promptYesNo: async () => false,
    }));

    const { runRollbackAction } = await import(`${rollbackModuleUrl}?t=${Math.random()}`);
    await runRollbackAction({ yes: false });

    expect(restoreCalled).toBe(false);
  });

  test('--yes skips the confirmation prompt entirely', async () => {
    let restoreCalled = false;
    let promptCalled = false;
    mock.module('@openpalm/lib', () => ({
      hasSnapshot: () => true,
      snapshotTimestamp: () => '2026-01-01T00:00:00.000Z',
      createState: () => ({ homeDir: '/tmp/home' }),
      restoreSnapshot: () => { restoreCalled = true; },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/home' }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({
      runComposeWithPreflight: async () => {},
    }));
    mock.module(moduleUrls.prompt, () => ({
      promptYesNo: async () => { promptCalled = true; return true; },
    }));

    const { runRollbackAction } = await import(`${rollbackModuleUrl}?t=${Math.random()}`);
    await runRollbackAction({ yes: true });

    expect(restoreCalled).toBe(true);
    expect(promptCalled).toBe(false);
  });
});
