/** The deploy apply path runs narrow runtime validation before container mutation. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProposedState } from './validate.js';
import type { ControlPlaneState } from './types.js';

const homes: string[] = [];

afterEach(() => {
  let home = homes.pop();
  while (home) {
    rmSync(home, { recursive: true, force: true });
    home = homes.pop();
  }
});

/** A temp OP_HOME seeded with valid runtime configuration. */
function seedHome(): { state: ControlPlaneState; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'apply-validation-'));
  homes.push(home);

  const managedStack = join(home, 'system', 'stack');
  mkdirSync(managedStack, { recursive: true });
  // validateProposedState needs the stack env file present and OP_UI_LOGIN_PASSWORD set.
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_IMAGE_TAG=v0.12.0\n');
  // §G1: op_ui_login_password is a delegated secret — private/secrets/, not
  // knowledge/secrets/ (which is bind-mounted wholesale into the assistant).
  const privateSecretsDir = join(home, 'private', 'secrets');
  mkdirSync(privateSecretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(privateSecretsDir, 'op_ui_login_password'), 'test-password\n', { mode: 0o600 });

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

describe('deploy runtime validation', () => {
	it('returns zero errors for a valid setup state', async () => {
		const { state } = seedHome();
		const result = await validateProposedState(state);
		expect(result.errors).toEqual([]);
	});

	it('does not enforce the removed Compose secret audit', async () => {
		const { state, home } = seedHome();
		const customDir = join(home, 'config', 'stack');
		mkdirSync(customDir, { recursive: true });
		writeFileSync(
			join(customDir, 'custom.compose.yml'),
			'services:\n  custom:\n    image: example/custom:1\n    environment:\n      CUSTOM_PASSWORD: operator-managed\n'
		);

		const result = await validateProposedState(state);
		expect(result.errors).toEqual([]);
	});
});
