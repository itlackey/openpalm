/**
 * Preferred-model persistence (`opencode.json`) — three ways it used to lie.
 *
 * 1. The admin UI co-process runs INSIDE the assistant container, where the
 *    entrypoint deliberately injects no OP_HOME. `configPath()` resolved
 *    `OP_HOME ?? ''` to a RELATIVE path against the server's cwd, so a
 *    preferred-model save either threw (missing cwd subdirs) or wrote a
 *    phantom file the assistant never reads — while the best-effort live
 *    PATCH made the save look successful until the next restart dropped it.
 *    The container-side file is the RW bind mount at
 *    `~/.config/opencode/opencode.json`.
 * 2. Clearing a model never persisted: patchConfig starts its merge from what
 *    is ON DISK, so a key the caller deleted from its in-memory copy was
 *    resurrected by the spread. Removals are now explicit (`removeKeys`).
 * 3. setMainModel round-tripped the FULL getCurrentConfig() — which falls
 *    back to OpenCode's live /config when the disk file is unreadable — so a
 *    save could bake the whole runtime-merged config into the operator's
 *    file. Saves are now deltas merged over the disk state.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./http.js', () => ({ opencodeFetch: vi.fn() }));

import { opencodeFetch } from './http.js';
import { setMainModel, unsetMainModel } from './config.js';

const mockedFetch = vi.mocked(opencodeFetch);

let root: string;
let savedOpHome: string | undefined;
let savedHome: string | undefined;

function opConfigPath(): string {
	return join(root, 'config', 'assistant', 'opencode.json');
}

function seed(config: Record<string, unknown>): void {
	mkdirSync(join(root, 'config', 'assistant'), { recursive: true });
	writeFileSync(opConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function readDisk(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'opencode-config-'));
	savedOpHome = process.env.OP_HOME;
	savedHome = process.env.HOME;
	process.env.OP_HOME = root;
	mockedFetch.mockResolvedValue({} as never);
});

afterEach(() => {
	if (savedOpHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = savedOpHome;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe('setMainModel', () => {
	test('persists the preference without clobbering unrelated keys, and PATCHes the live process', async () => {
		seed({
			model: 'openai/old',
			provider: { lmstudio: { options: { baseURL: 'http://192.168.1.175:1234' } } },
			disabled_providers: [],
		});

		await setMainModel('openai', 'gpt-5.3-codex-spark', 'model');

		const disk = readDisk(opConfigPath());
		expect(disk.model).toBe('openai/gpt-5.3-codex-spark');
		expect(disk.provider).toEqual({ lmstudio: { options: { baseURL: 'http://192.168.1.175:1234' } } });
		expect(disk.disabled_providers).toEqual([]);
		expect(mockedFetch).toHaveBeenCalledWith('/config', {
			method: 'PATCH',
			body: JSON.stringify({ model: 'openai/gpt-5.3-codex-spark' }),
		});
	});

	test('writes only the delta when the disk file is missing — never the live-config fallback', async () => {
		mkdirSync(join(root, 'config', 'assistant'), { recursive: true });
		// If the save still round-tripped getCurrentConfig(), THIS runtime
		// snapshot is what would land in the operator's file.
		mockedFetch.mockResolvedValue({ model: 'live/runtime', agent: { build: {} } } as never);

		await setMainModel('openai', 'gpt', 'small_model');

		expect(readDisk(opConfigPath())).toEqual({ small_model: 'openai/gpt' });
	});

	test('resolves the container mount (~/.config/opencode) when OP_HOME is absent', async () => {
		delete process.env.OP_HOME;
		process.env.HOME = root; // the container's HOME=/home/opencode analogue
		const mountPath = join(root, '.config', 'opencode', 'opencode.json');
		mkdirSync(join(root, '.config', 'opencode'), { recursive: true });
		writeFileSync(mountPath, `${JSON.stringify({ small_model: 'openai/tiny' }, null, 2)}\n`);

		await setMainModel('openai', 'gpt-5.6-luna', 'model');

		const disk = readDisk(mountPath);
		expect(disk.model).toBe('openai/gpt-5.6-luna');
		expect(disk.small_model).toBe('openai/tiny');
		// And nothing appeared at the old relative phantom location.
		expect(existsSync(join(process.cwd(), 'config', 'assistant', 'opencode.json'))).toBe(false);
	});
});

describe('unsetMainModel', () => {
	test('actually removes the key from disk (the merge used to resurrect it)', async () => {
		seed({ model: 'openai/keep', small_model: 'openai/clear-me' });

		await unsetMainModel('small_model');

		const disk = readDisk(opConfigPath());
		expect(disk.small_model).toBeUndefined();
		expect(disk.model).toBe('openai/keep');
	});
});
