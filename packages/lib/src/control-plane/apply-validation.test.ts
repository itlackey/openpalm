/**
 * S.2.2 — the deploy apply path runs the secret-boundary audit + runtime
 * validation BEFORE it touches containers, and refuses when a compose overlay
 * grants an unauthorized secret.
 *
 * Before S.2.2, neither auditComposeSecrets nor validateProposedState was
 * invoked outside the manual `openpalm audit-secrets` command, so an apply
 * could silently grant a secret across the boundary. auditApplyState is the
 * gate runDeploy calls; these tests pin both branches:
 *   - the shipped stack's own overlays audit clean (guards the S.2.1
 *     false-positive regression at the apply gate), and
 *   - an overlay that grants an unauthorized secret produces a blocking error.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditApplyState } from './deploy.js';
import type { ControlPlaneState } from './types.js';

const SHIPPED_STACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skeleton', 'system', 'stack');

const homes: string[] = [];

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** A temp OP_HOME seeded with the shipped compose overlays + a valid stack env. */
function seedHome(): { state: ControlPlaneState; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'apply-validation-'));
  homes.push(home);

  const managedStack = join(home, 'system', 'stack');
  mkdirSync(managedStack, { recursive: true });
  for (const name of readdirSync(SHIPPED_STACK_DIR)) {
    if (name.endsWith('.compose.yml')) copyFileSync(join(SHIPPED_STACK_DIR, name), join(managedStack, name));
  }

  // validateProposedState needs the stack env file present and OP_UI_LOGIN_PASSWORD set.
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=v0.12.0\n');
  const secretsDir = join(home, 'knowledge', 'secrets');
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, 'op_ui_login_password'), 'test-password\n', { mode: 0o600 });

  const state = {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
    stackDir: managedStack,
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  } as unknown as ControlPlaneState;

  return { state, home };
}

describe('auditApplyState', () => {
  it('returns zero errors for the shipped stack overlays (S.2.1 false-positive guard)', async () => {
    const { state } = seedHome();
    const result = await auditApplyState(state);
    expect(result.errors).toEqual([]);
  });

  it('refuses when a compose overlay grants an unauthorized secret', async () => {
    const { state, home } = seedHome();
    const customDir = join(home, 'config', 'stack');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'custom.compose.yml'),
      'services:\n  myaddon:\n    image: example/myaddon:1.0\n    secrets:\n      - guardian_admin_token\n',
    );

    const result = await auditApplyState(state);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join('\n')).toMatch(/myaddon is not allowed to mount secret guardian_admin_token/);
  });
});
