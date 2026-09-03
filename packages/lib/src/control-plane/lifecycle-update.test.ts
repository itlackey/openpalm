import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, createState } from './lifecycle.js';
import { PLATFORM_VERSION } from './versioning.js';
import { BACKUP_COMPLETE_MARKER } from './backup.js';

const originalEnv = {
	OP_HOME: process.env.OP_HOME,
	OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
	OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE,
	OP_UI_LOGIN_PASSWORD: process.env.OP_UI_LOGIN_PASSWORD
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
		else process.env[key as keyof NodeJS.ProcessEnv] = value;
	}
});

describe('lifecycle update state', () => {
	test('leaves image tags entirely alone, and creates a bounded safety backup', async () => {
		const home = mkdtempSync(join(tmpdir(), 'openpalm-lifecycle-update-'));
		process.env.OP_HOME = home;
		process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
		process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
		process.env.OP_UI_LOGIN_PASSWORD = 'lifecycle-update-test-password';
		try {
			mkdirSync(join(home, 'state'), { recursive: true });
			mkdirSync(join(home, 'knowledge'), { recursive: true });
			mkdirSync(join(home, 'workspace'), { recursive: true });
			writeFileSync(join(home, '.skeleton-version'), '0.12.0\n');
			writeFileSync(
				join(home, 'state', 'stack.env'),
				'OP_ASSISTANT_VERSION=0.12.0\nOP_GUARDIAN_VERSION=rollback-generation-old\nOP_PORTAL_VERSION=custom-pin\n'
			);
			writeFileSync(join(home, 'knowledge', 'large-user-tree-marker'), 'must not be copied\n');
			writeFileSync(join(home, 'workspace', 'large-workspace-marker'), 'must not be copied\n');

			await applyUpdate(createState());

			// #679: an update writes NO image tags. The tag comes from the `:-`
			// default in the compose files this release ships, which the same
			// update overwrote — so there is no "advance the versions" step left
			// that can be skipped, and no stored value that can outrank the
			// release. A row here can only be an operator's pin, and the v13->v14
			// migration deleted the ones past releases wrote.
			const stackEnv = readFileSync(join(home, 'state', 'stack.env'), 'utf8');
			expect(stackEnv).not.toMatch(/^OP_ASSISTANT_VERSION=/m);
			expect(stackEnv).not.toMatch(/^OP_GUARDIAN_VERSION=/m);
			expect(stackEnv).not.toMatch(/^OP_PORTAL_VERSION=/m);
			expect(stackEnv).not.toContain('OP_MANAGED_');
			const backupsDir = join(home, 'data', 'backups');
			const backups = existsSync(backupsDir)
				? readdirSync(backupsDir).filter((backup) =>
						existsSync(join(backupsDir, backup, BACKUP_COMPLETE_MARKER))
					)
				: [];
			expect(backups.length).toBeGreaterThan(0);
			expect(backups.length).toBeLessThanOrEqual(3);
			for (const backup of backups) {
				expect(existsSync(join(backupsDir, backup, 'knowledge', 'large-user-tree-marker'))).toBe(true);
				// #656/#648: workspace/ is the operator's own regenerable work area
				// (an unrelated cloned repo's .git/ has no business in an upgrade
				// safety snapshot) and is excluded from backup scope, same as
				// data/ and cache/ — see OP_HOME_TREES in home.ts.
				expect(existsSync(join(backupsDir, backup, 'workspace', 'large-workspace-marker'))).toBe(false);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
