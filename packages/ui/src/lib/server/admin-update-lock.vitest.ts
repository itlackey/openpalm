import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlPlaneState } from '@openpalm/lib';
import { withAdminUpdateLock } from './admin-update-lock.js';

const homes: string[] = [];

function makeState(): ControlPlaneState {
	const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-admin-update-lock-'));
	homes.push(homeDir);
	return {
		homeDir,
		configDir: join(homeDir, 'config'),
		stashDir: join(homeDir, 'knowledge'),
		workspaceDir: join(homeDir, 'workspace'),
		dataDir: join(homeDir, 'data'),
		stackDir: join(homeDir, 'system', 'stack'),
		services: {},
		artifacts: { compose: '' },
		artifactMeta: []
	};
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('withAdminUpdateLock', () => {
	test('returns a structured 409 and does not run the mutation when the lifecycle lock is held', async () => {
		const state = makeState();
		const lockPath = join(state.dataDir, '.install.lock');
		mkdirSync(state.dataDir, { recursive: true });
		writeFileSync(lockPath, `1\n${Date.now()}\n`);
		const mutation = vi.fn(() => new Response(null, { status: 204 }));

		const response = await withAdminUpdateLock(state, 'req-lock-held', mutation);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: 'install_in_progress',
			requestId: 'req-lock-held'
		});
		expect(mutation).not.toHaveBeenCalled();
	});

	test('holds and releases the lifecycle lock around the mutation', async () => {
		const state = makeState();
		const lockPath = join(state.dataDir, '.install.lock');

		const response = await withAdminUpdateLock(state, 'req-lock-free', () => {
			expect(existsSync(lockPath)).toBe(true);
			return new Response(null, { status: 204 });
		});

		expect(response.status).toBe(204);
		expect(existsSync(lockPath)).toBe(false);
	});

	test('rejects a concurrent request in the same UI process without waiting or deadlocking', async () => {
		const state = makeState();
		let releaseFirst!: () => void;
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = Promise.withResolvers<void>();

		const first = withAdminUpdateLock(state, 'req-first', async () => {
			firstStarted.resolve();
			await firstMayFinish;
			return new Response(null, { status: 204 });
		});
		await firstStarted.promise;

		const secondMutation = vi.fn(() => new Response(null, { status: 204 }));
		const second = await withAdminUpdateLock(state, 'req-second', secondMutation);
		expect(second.status).toBe(409);
		expect(secondMutation).not.toHaveBeenCalled();

		releaseFirst();
		expect((await first).status).toBe(204);
	});

	test('releases the lock after a synchronous mutation failure', async () => {
		const state = makeState();
		const lockPath = join(state.dataDir, '.install.lock');

		await expect(withAdminUpdateLock(state, 'req-throws', () => {
			throw new Error('mutation failed');
		})).rejects.toThrow('mutation failed');
		expect(existsSync(lockPath)).toBe(false);
	});

	test('can retain the lock until detached work finishes', async () => {
		const state = makeState();
		const lockPath = join(state.dataDir, '.install.lock');
		const background = Promise.withResolvers<void>();

		const response = await withAdminUpdateLock(state, 'req-background', (_lock, deferReleaseUntil) => {
			deferReleaseUntil(background.promise);
			return new Response(null, { status: 202 });
		});

		expect(response.status).toBe(202);
		expect(existsSync(lockPath)).toBe(true);
		expect((await withAdminUpdateLock(state, 'req-concurrent', () => new Response())).status).toBe(409);

		background.resolve();
		await background.promise;
		await Promise.resolve();
		expect(existsSync(lockPath)).toBe(false);
	});
});
