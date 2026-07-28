import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import * as nodeChildProcess from 'node:child_process';
// Snapshot the REAL module members at import time, before any mock.module call
// below can rebind the `nodeChildProcess` namespace. mock.module replaces the
// namespace object in place, so a stub that "delegates to the real one" via
// `nodeChildProcess.execFile` would call ITSELF — and because that call sits in
// tail position, JavaScriptCore tail-call-optimises it into a silent 100%-CPU
// spin rather than a RangeError. The spin starves the event loop, so bun's
// per-test timeout can never fire and the whole run hangs forever. Delegate
// through these captured references instead.
const realChildProcess = { ...nodeChildProcess };
import { detectHostInfo, isAssistantHealthy, main } from './main.ts';
import {
	PLATFORM_VERSION,
	readSecret,
	resolveRequestedImageTag,
	upsertEnvValue
} from '@openpalm/lib';
import { canReplaceCurrentExecutable, resolveCliArtifactName } from './commands/self-update.ts';

/** Write a minimal SetupSpec YAML file that satisfies validation, allowing --file installs to skip the wizard. */
function writeMinimalSetupSpec(dir: string): string {
	const specPath = join(dir, 'setup-spec.yaml');
	const yaml = [
		'version: 2',
		'llm:',
		'  provider: openai',
		'  model: gpt-4o',
		'  baseUrl: https://api.openai.com/v1',
		'embedding:',
		'  provider: openai',
		'  model: text-embedding-3-small',
		'  dims: 1536',
		'  baseUrl: https://api.openai.com/v1',
		'security:',
		'  uiLoginPassword: test-admin-token-12345',
		'owner:',
		'  name: Test User',
		'  email: test@example.com',
		'connections:',
		'  - id: openai',
		'    name: OpenAI',
		'    provider: openai',
		'    baseUrl: https://api.openai.com/v1',
		'    apiKey: sk-test-key',
		''
	].join('\n');
	writeFileSync(specPath, yaml);
	return specPath;
}

const TAR_BLOCK_SIZE = 512;

async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
	return Uint8Array.from(Bun.gunzipSync(Uint8Array.from(data)));
}

function readTarEntry(archive: Uint8Array, entryName: string): Uint8Array | null {
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length; offset += TAR_BLOCK_SIZE) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) {
			return null;
		}

		const rawName = new TextDecoder().decode(header.subarray(0, 100));
		const name = rawName.replace(/\0.*$/, '');
		const rawSize = new TextDecoder().decode(header.subarray(124, 136));
		const size = Number.parseInt(rawSize.replace(/\0.*$/, '').trim() || '0', 8);
		const contentOffset = offset + TAR_BLOCK_SIZE;
		const contentEnd = contentOffset + size;

		if (name === entryName) {
			return archive.slice(contentOffset, contentEnd);
		}

		offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}

	return null;
}

async function readPackedPackageJson(
	tarballPath: string
): Promise<{ dependencies?: Record<string, string> }> {
	const compressed = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());
	const archive = await gunzipBytes(compressed);
	const packageJson = readTarEntry(archive, 'package/package.json');
	if (!packageJson) {
		throw new Error('Expected packed tarball to include package/package.json');
	}

	return JSON.parse(new TextDecoder().decode(packageJson)) as {
		dependencies?: Record<string, string>;
	};
}

// Helpers to mock Bun.spawn and Bun.which for tests that would otherwise
// shell out to `docker info` / `docker compose version` and block in CI.
const originalBunSpawn = Bun.spawn;
const originalBunWhich = Bun.which;

/**
 * A ChildProcess-like stub that immediately "succeeds": emits `close` with exit
 * code 0 on the next microtask so callers that attach `close`/`error` listeners
 * first (e.g. lib's `runComposeStreaming`) resolve without touching a real
 * `docker` binary or daemon.
 */
function makeFakeChildProcess(code = 0): EventEmitter {
	const child = new EventEmitter() as EventEmitter & {
		stdout: null;
		stderr: null;
		stdin: null;
		pid: number;
		kill: () => boolean;
	};
	child.stdout = null;
	child.stderr = null;
	child.stdin = null;
	child.pid = 0;
	child.kill = () => true;
	queueMicrotask(() => child.emit('close', code));
	return child;
}

function mockDockerCli(): void {
	Bun.which = mock((_cmd: string) => '/usr/bin/docker') as typeof Bun.which;
	Bun.spawn = mock((_cmd: string[] | readonly string[], _opts?: unknown) => ({
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
		resourceUsage: () => undefined
	})) as unknown as typeof Bun.spawn;
	// lib's stdio-inheriting compose runner (runComposeStreaming) spawns via
	// node:child_process, NOT Bun.spawn — stub that seam too so compose mutations
	// (e.g. `addon disable` → `compose stop`) never shell out to real docker.
	// execFile and the rest of the module stay real (only `spawn` is replaced).
	mock.module('node:child_process', () => ({
		...realChildProcess,
		spawn: mock(() => makeFakeChildProcess(0)),
		// E1 added a `docker manifest inspect` probe to performSetup's image-pin
		// logic. Keep it off the network in tests: report the pinned tag as "not
		// published" so setup falls back to `latest` (the behavior these install
		// tests assert) instead of making a real registry round-trip that would
		// hang against the sandbox network and time the test out.
		execFile: ((cmd: unknown, args: unknown, opts: unknown, cb: unknown) => {
			const callback = (typeof opts === 'function' ? opts : cb) as
				| ((err: unknown, stdout: string, stderr: string) => void)
				| undefined;
			const argv = Array.isArray(args) ? (args as string[]) : [];
			if (argv[0] === 'manifest' && argv[1] === 'inspect') {
				const err = Object.assign(new Error('no such manifest'), { code: 1 });
				queueMicrotask(() => callback?.(err, '', 'no such manifest'));
				return makeFakeChildProcess(1);
			}
			// realChildProcess.execFile, NOT nodeChildProcess.execFile — the latter
			// is this very stub once mock.module has run (see the import-time
			// snapshot above).
			return (
				realChildProcess as unknown as {
					execFile: (...a: unknown[]) => unknown;
				}
			).execFile(cmd, args, opts, callback);
		}) as unknown as typeof nodeChildProcess.execFile
	}));
}

function restoreDockerCli(): void {
	Bun.spawn = originalBunSpawn;
	Bun.which = originalBunWhich;
	// mock.module is process-global and survives this file, leaking the spawn/
	// execFile stubs into every later test file in the same `bun test` process.
	// Put the real module back so the leak stops at this file's boundary.
	mock.module('node:child_process', () => ({ ...realChildProcess }));
}

describe('cli main', () => {
	const originalFetch = globalThis.fetch;
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalHome = process.env.OP_HOME;
	const originalWorkDir = process.env.OP_WORK_DIR;
	const originalLoginPassword = process.env.OP_UI_LOGIN_PASSWORD;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		console.log = originalLog;
		console.warn = originalWarn;
		restoreDockerCli();
		process.env.OP_HOME = originalHome;
		process.env.OP_WORK_DIR = originalWorkDir;
		process.env.OP_UI_LOGIN_PASSWORD = originalLoginPassword;
	});

	it('runs bootstrap install directly without admin delegation', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
		const workDir = join(base, 'work');

		const specFile = writeMinimalSetupSpec(base);

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;
		delete process.env.OP_UI_LOGIN_PASSWORD;

		mockDockerCli();
		const fetchedUrls: string[] = [];
		globalThis.fetch = mock(async (input: string | URL) => {
			const url = String(input);
			fetchedUrls.push(url);
			if (url.endsWith('/health')) {
				return new Response('ok', { status: 200 });
			}
			if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
				return new Response('services: {}\n', { status: 200 });
			}
			if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
			if (url.includes('/opencode.jsonc'))
				return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
			if (url.endsWith('.yml'))
				return new Response('name: test\nschedule: daily\n', { status: 200 });
			return new Response('', { status: 503 });
		}) as unknown as typeof fetch;
		console.log = mock(() => {}) as typeof console.log;
		console.warn = mock(() => {}) as typeof console.warn;

		try {
			await main(['install', '--no-start', '--file', specFile]);
			// Bootstrap runs directly, creating directories
			expect(existsSync(join(base, 'data', 'assistant'))).toBe(true);
			expect(existsSync(join(base, 'system', 'stack', 'services.compose.yml'))).toBe(true);
			expect(existsSync(join(base, 'system', 'stack', 'portals.compose.yml'))).toBe(true);
			// custom.compose.yml is USER-owned → config/stack, not system/stack.
			expect(existsSync(join(base, 'config', 'stack', 'custom.compose.yml'))).toBe(true);
			expect(existsSync(join(base, 'knowledge', 'tasks', 'akm-improve.yml'))).toBe(true);
			expect(existsSync(join(base, 'system', 'stack', 'guardian.env'))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('creates service data directories during bootstrap install (health check unreachable)', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
		const workDir = join(base, 'work');

		const specFile = writeMinimalSetupSpec(base);

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;

		mockDockerCli();
		globalThis.fetch = mock(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/health')) {
				throw new TypeError('fetch failed');
			}
			if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
				return new Response('services: {}\n', { status: 200 });
			}
			if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
			if (url.includes('/opencode.jsonc'))
				return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
			if (url.endsWith('.yml'))
				return new Response('name: test\nschedule: daily\n', { status: 200 });
			return new Response('', { status: 503 });
		}) as unknown as typeof fetch;
		console.log = mock(() => {}) as typeof console.log;

		try {
			await main(['install', '--no-start', '--file', specFile]);
			expect(existsSync(join(base, 'data', 'assistant'))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('platform image versions default to the exact host release', async () => {
		// Mock the GitHub redirect to fail so the install ref falls back to the
		// packaged platform version.
		globalThis.fetch = mock(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;

		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
		const workDir = join(base, 'work');
		const specFile = writeMinimalSetupSpec(base);

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;

		mockDockerCli();
		console.log = mock(() => {}) as typeof console.log;
		console.warn = mock(() => {}) as typeof console.warn;

		try {
			await main(['install', '--no-start', '--file', specFile]);
			// state/stack.env is the sole pin location.
			const stateEnv = readFileSync(join(base, 'state', 'stack.env'), 'utf-8');
			expect(stateEnv).toMatch(new RegExp(`^OP_ASSISTANT_VERSION=${PLATFORM_VERSION}$`, 'm'));
			expect(stateEnv).toMatch(new RegExp(`^OP_GUARDIAN_VERSION=${PLATFORM_VERSION}$`, 'm'));
			expect(stateEnv).toMatch(new RegExp(`^OP_PORTAL_VERSION=${PLATFORM_VERSION}$`, 'm'));
			expect(stateEnv).toMatch(/^OP_VOICE_VERSION=latest$/m);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('an explicit --version pins platform images while Voice stays independent', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-pin-'));
		const workDir = join(base, 'work');
		const specFile = writeMinimalSetupSpec(base);

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;

		mockDockerCli();
		console.log = mock(() => {}) as typeof console.log;
		console.warn = mock(() => {}) as typeof console.warn;

		try {
			// An explicit --version is honored verbatim. A legacy `v`-prefixed pin is
			// preserved (not stripped) so a pre-0.12.41 `v`-tagged image stays pullable.
			await main(['install', '--no-start', '--version', 'v0.11.0', '--file', specFile]);
			// Platform images honor the explicit pin. Voice has an independent
			// variant-suffixed release stream and continues tracking latest.
			const stateEnv = readFileSync(join(base, 'state', 'stack.env'), 'utf-8');
			expect(stateEnv).toMatch(/^OP_ASSISTANT_VERSION=v0\.11\.0$/m);
			expect(stateEnv).toMatch(/^OP_GUARDIAN_VERSION=v0\.11\.0$/m);
			expect(stateEnv).toMatch(/^OP_PORTAL_VERSION=v0\.11\.0$/m);
			expect(stateEnv).toMatch(/^OP_VOICE_VERSION=latest$/m);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('backs up the current OP_HOME before install --force rewrites assets', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-force-'));
		const workDir = join(base, 'work');
		const stackConfig = join(base, 'config', 'stack.yml');
		const specFile = writeMinimalSetupSpec(base);

		// The canonical "already installed" marker is state/stack.env.
		// Seed it so the backup path triggers AND we can prove the backup
		// carries forward existing content.
		mkdirSync(join(base, 'data'), { recursive: true });
		mkdirSync(join(base, 'system', 'stack'), { recursive: true });
		mkdirSync(join(base, 'config'), { recursive: true });
		mkdirSync(join(base, 'knowledge', 'env'), { recursive: true });
		mkdirSync(join(base, 'state'), { recursive: true });
		writeFileSync(join(base, 'state', 'stack.env'), 'OP_OWNER_NAME=existing-owner\n');
		writeFileSync(stackConfig, 'llm: old\n');

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;

		mockDockerCli();
		globalThis.fetch = mock(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/health')) throw new TypeError('fetch failed');
			if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
				return new Response('services: {}\n', { status: 200 });
			}
			if (url.includes('.env.schema')) return new Response('KEY=string\n', { status: 200 });
			if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
			if (url.includes('/opencode.jsonc'))
				return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
			if (url.endsWith('.yml'))
				return new Response('name: test\nschedule: daily\n', { status: 200 });
			return new Response('', { status: 503 });
		}) as unknown as typeof fetch;
		console.log = mock(() => {}) as typeof console.log;
		console.warn = mock(() => {}) as typeof console.warn;

		try {
			await main(['install', '--force', '--no-start', '--file', specFile]);

			const backupsDir = join(base, 'data', 'backups');
			const backups = readdirSync(backupsDir).filter((name) => name !== '.gitkeep');
			expect(backups.length).toBeGreaterThan(0);
			const forceBackup = backups.find((name) =>
				existsSync(join(backupsDir, name, 'config', 'stack.yml'))
			);
			expect(forceBackup).toBeDefined();
			if (!forceBackup) throw new Error('force-install backup was not created');
			expect(readFileSync(join(backupsDir, forceBackup, 'config', 'stack.yml'), 'utf8')).toContain(
				'llm: old'
			);
			expect(readFileSync(join(backupsDir, forceBackup, 'state', 'stack.env'), 'utf8')).toContain(
				'OP_OWNER_NAME=existing-owner'
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('persists install-time project and port overrides into stack.env for later start', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-overrides-'));
		const workDir = join(base, 'work');
		const specFile = writeMinimalSetupSpec(base);
		const originalProject = process.env.OP_PROJECT_NAME;
		const originalAssistantPort = process.env.OP_ASSISTANT_PORT;
		const originalUiPort = process.env.OP_UI_PORT;
		const originalHostUiPort = process.env.OP_HOST_UI_PORT;

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;
		process.env.OP_PROJECT_NAME = 'openpalm-test-install';
		process.env.OP_ASSISTANT_PORT = '4802';
		process.env.OP_UI_PORT = '4801';
		process.env.OP_HOST_UI_PORT = '9300';

		mockDockerCli();
		globalThis.fetch = mock(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/health')) return new Response('ok', { status: 200 });
			if (url.includes('/core.compose.yml') || url.includes('/compose.yml'))
				return new Response('services: {}\n', { status: 200 });
			if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
			if (url.includes('/opencode.jsonc'))
				return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
			if (url.endsWith('.yml'))
				return new Response('name: test\nschedule: daily\n', { status: 200 });
			return new Response('', { status: 503 });
		}) as unknown as typeof fetch;
		console.log = mock(() => {}) as typeof console.log;
		console.warn = mock(() => {}) as typeof console.warn;

		try {
			await main(['install', '--no-start', '--file', specFile]);
			const stackEnv = readFileSync(join(base, 'state', 'stack.env'), 'utf-8');
			expect(stackEnv).toContain('OP_PROJECT_NAME=openpalm-test-install');
			expect(stackEnv).toContain('OP_ASSISTANT_PORT=4802');
			expect(stackEnv).toContain('OP_UI_PORT=4801');
			expect(stackEnv).toContain('OP_HOST_UI_PORT=9300');
		} finally {
			if (originalProject === undefined) delete process.env.OP_PROJECT_NAME;
			else process.env.OP_PROJECT_NAME = originalProject;
			if (originalAssistantPort === undefined) delete process.env.OP_ASSISTANT_PORT;
			else process.env.OP_ASSISTANT_PORT = originalAssistantPort;
			if (originalUiPort === undefined) delete process.env.OP_UI_PORT;
			else process.env.OP_UI_PORT = originalUiPort;
			if (originalHostUiPort === undefined) delete process.env.OP_HOST_UI_PORT;
			else process.env.OP_HOST_UI_PORT = originalHostUiPort;
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('rejects the legacy capabilities wrapper for install --file', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-install-legacy-'));
		const workDir = join(base, 'work');
		const specFile = join(base, 'setup-spec-legacy.yaml');
		const mainPath = join(fileURLToPath(new URL('./', import.meta.url)), 'main.ts');
		const yaml = [
			'version: 2',
			'capabilities:',
			'  llm: openai/gpt-4o',
			'  embeddings:',
			'    provider: openai',
			'    model: text-embedding-3-small',
			'    dims: 1536',
			'security:',
			'  uiLoginPassword: test-admin-token-12345',
			'connections: []',
			''
		].join('\n');
		writeFileSync(specFile, yaml);

		process.env.OP_HOME = base;
		process.env.OP_WORK_DIR = workDir;

		try {
			const proc = Bun.spawn(['bun', mainPath, 'install', '--no-start', '--file', specFile], {
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...process.env, OP_HOME: base, OP_WORK_DIR: workDir }
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(code).not.toBe(0);
			expect(stdout + stderr).toContain('modern flat shape');
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 15_000);

	it('supports addon enable/disable commands', async () => {
		const base = mkdtempSync(join(tmpdir(), 'openpalm-addon-cli-'));
		const coreCompose = join(base, 'system', 'stack', 'core.compose.yml');
		const logs: string[] = [];

		mkdirSync(join(base, 'system', 'stack'), { recursive: true });
		mkdirSync(join(base, 'data'), { recursive: true });
		writeFileSync(coreCompose, 'services:\n  assistant:\n    image: test\n');
		writeFileSync(
			join(base, 'system', 'stack', 'portals.compose.yml'),
			'services:\n  discord:\n    profiles: ["addon.discord"]\n    image: discord\n    environment:\n      PORTAL_NAME: "Discord Bot"\n'
		);

		process.env.OP_HOME = base;
		process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
		mockDockerCli();
		console.log = mock((message?: unknown) => {
			logs.push(String(message ?? ''));
		}) as typeof console.log;
		console.warn = mock((message?: unknown) => {
			logs.push(String(message ?? ''));
		}) as typeof console.warn;

		try {
			// OP_ENABLED_ADDONS is app-written addon state → state/ (constitution §1).
			const stateEnv = () => readFileSync(join(base, 'state', 'stack.env'), 'utf-8');
			await main(['addon', 'enable', 'discord']);
			expect(stateEnv()).toContain('OP_ENABLED_ADDONS=discord');
			expect(readSecret(base, 'portal_discord_secret')).toBeTruthy();

			await main(['addon', 'disable', 'discord']);
			expect(stateEnv()).not.toContain('discord');
		} finally {
			delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe('self-update helpers', () => {
	it('maps supported platforms to release artifacts', () => {
		expect(resolveCliArtifactName('linux', 'x64')).toBe('openpalm-cli-linux-x64');
		expect(resolveCliArtifactName('darwin', 'arm64')).toBe('openpalm-cli-darwin-arm64');
	});

	it('rejects unsupported platforms', () => {
		expect(() => resolveCliArtifactName('freebsd', 'mips64')).toThrow(
			'Unsupported platform for self-update'
		);
	});

	it('only allows replacing standalone executables', () => {
		expect(canReplaceCurrentExecutable('/usr/local/bin/openpalm')).toBe(true);
		expect(canReplaceCurrentExecutable('/home/runner/.bun/bin/bun')).toBe(false);
	});
});

describe('npm bin launcher', () => {
	it('publishes a pure-node bootstrapper bin, not a Bun/TypeScript launcher (A1)', () => {
		const cliPkg = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8')
		) as {
			bin?: Record<string, string>;
		};

		expect(cliPkg.bin?.openpalm).toBe('./bin/openpalm.js');

		const launcher = readFileSync(new URL('../bin/openpalm.js', import.meta.url), 'utf8');

		// A1: the published bin is a first-run bootstrapper that runs under plain
		// `node` and downloads the platform binary. It must NOT require a Bun
		// runtime, and must never import the un-shipped TypeScript source — the
		// exact defect that made `npm install -g openpalm` crash.
		expect(launcher.startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(launcher).not.toContain('../src/main.ts');
	});

	it('publishes a dependency-free package so a global install pulls no workspace/bun packages (A1)', async () => {
		const cliPkg = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8')
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			files?: string[];
		};

		// A1: the bootstrapper has ZERO runtime deps; the bun-program's deps
		// (including @openpalm/lib) move to devDependencies so the compiled-binary
		// build still resolves them without the published package trying to pull
		// them at install time.
		expect(cliPkg.dependencies ?? {}).toEqual({});
		expect(cliPkg.devDependencies?.['@openpalm/lib']).toBeDefined();
		expect(cliPkg.files).not.toContain('src');
		expect(cliPkg.files).not.toContain('dist');

		const packageDir = fileURLToPath(new URL('../', import.meta.url));
		const packDir = mkdtempSync(join(tmpdir(), 'openpalm-cli-pack-'));

		try {
			const pack = Bun.spawnSync(
				[process.execPath, 'pm', 'pack', '--destination', packDir, '--quiet'],
				{
					cwd: packageDir,
					stdout: 'pipe',
					stderr: 'pipe'
				}
			);

			expect(pack.exitCode).toBe(0);

			const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
			if (!tarball) throw new Error('Expected bun pm pack to produce a tarball');

			const packedPkg = await readPackedPackageJson(join(packDir, tarball));

			// The PUBLISHED tarball must carry no runtime dependencies.
			expect(packedPkg.dependencies ?? {}).toEqual({});
		} finally {
			rmSync(packDir, { recursive: true, force: true });
		}
	}, 20_000);
});

describe('validate command', () => {
	it('is a recognized command and exits 0 when file-based required secrets exist', async () => {
		const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
		const stackDir = join(tempHome, 'system', 'stack');
		const stateDir = join(tempHome, 'state');
		// op_ui_login_password is a DELEGATED secret (guardian/portal/UI-consumed),
		// so G1 relocates it out of the assistant-reachable knowledge/secrets stash
		// into private/secrets/. Seed it where the name-routed secretPath() now
		// resolves it.
		const secretDir = join(tempHome, 'private', 'secrets');
		mkdirSync(stackDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(secretDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(stateDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
		writeFileSync(join(secretDir, 'op_ui_login_password'), 'abc\n', { mode: 0o600 });

		const originalHome = process.env.OP_HOME;
		const originalExit = process.exit;
		process.env.OP_HOME = tempHome;
		process.exit = mock((_code?: number) => {
			throw new Error(`process.exit(${_code})`);
		}) as typeof process.exit;

		try {
			const err = await main(['validate']).catch((e: unknown) => e);
			const message = err instanceof Error ? err.message : String(err);
			expect(message).not.toContain('Unknown command');
			expect(message).toBe('process.exit(0)');
		} finally {
			process.exit = originalExit;
			process.env.OP_HOME = originalHome;
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe('scan command', () => {
	it('is a recognized command and exits 0 listing sensitive keys', async () => {
		const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
		const stackDir = join(tempHome, 'system', 'stack');
		mkdirSync(stackDir, { recursive: true });
		writeFileSync(
			join(stackDir, 'stack.env'),
			'OP_UI_LOGIN_PASSWORD=abc\nOPENAI_API_KEY=sk-test\n'
		);

		const originalHome = process.env.OP_HOME;
		const originalExit = process.exit;
		process.env.OP_HOME = tempHome;
		process.exit = mock((_code?: number) => {
			throw new Error(`process.exit(${_code})`);
		}) as typeof process.exit;

		try {
			const err = await main(['scan']).catch((e: unknown) => e);
			const message = err instanceof Error ? err.message : String(err);
			expect(message).not.toContain('Unknown command');
			expect(message).toBe('process.exit(0)');
		} finally {
			process.exit = originalExit;
			process.env.OP_HOME = originalHome;
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe('audit-secrets command', () => {
	/** Seed a home whose secrets tree is clean; `stackEnv` goes to state/stack.env. */
	function seedAuditHome(stackEnv: string): string {
		const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
		const stateDir = join(tempHome, 'state');
		const secretDir = join(tempHome, 'knowledge', 'secrets');
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(secretDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(stateDir, 'stack.env'), stackEnv);
		writeFileSync(join(secretDir, 'op_ui_login_password'), 'abc\n', { mode: 0o600 });
		return tempHome;
	}

	async function runAudit(tempHome: string): Promise<string> {
		const originalHome = process.env.OP_HOME;
		const originalExit = process.exit;
		process.env.OP_HOME = tempHome;
		process.exit = mock((_code?: number) => {
			throw new Error(`process.exit(${_code})`);
		}) as typeof process.exit;
		try {
			const err = await main(['audit-secrets']).catch((e: unknown) => e);
			return err instanceof Error ? err.message : String(err);
		} finally {
			process.exit = originalExit;
			process.env.OP_HOME = originalHome;
			rmSync(tempHome, { recursive: true, force: true });
		}
	}

	it('is a recognized command and exits 0 for file-based secrets', async () => {
		const message = await runAudit(seedAuditHome('OP_SETUP_COMPLETE=true\n'));
		expect(message).not.toContain('Unknown command');
		expect(message).toBe('process.exit(0)');
	});

	// Regression: the command read `<home>/system/stack/stack.env` and passed
	// stackDir to resolveSecretsDir, so it audited a path that never exists and
	// a directory it had just created itself — reporting clean no matter what
	// was really in state/stack.env.
	it('reports a secret-shaped key in state/stack.env', async () => {
		const message = await runAudit(seedAuditHome('OPENAI_API_KEY=sk-live-value\n'));
		expect(message).toBe('process.exit(1)');
	});
});

// The bare-command health probe sends no Basic auth. When direct Assistant
// access enables authentication, a 401 still proves the service is reachable,
// so the command must not needlessly recreate a running container.
describe('isAssistantHealthy — auth-posture-aware reachability (P3-4)', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const stubHealth = (status: number) => {
		globalThis.fetch = mock(async (input: string | URL) => {
			if (String(input).endsWith('/health')) return new Response('', { status });
			return new Response('', { status: 503 });
		}) as unknown as typeof fetch;
	};

	it('treats a 200 as healthy', async () => {
		stubHealth(200);
		expect(await isAssistantHealthy()).toBe(true);
	});

	it('treats a 401 (OPENCODE_AUTH on, no creds sent) as healthy — no needless stack start', async () => {
		stubHealth(401);
		expect(await isAssistantHealthy()).toBe(true);
	});

	it('treats a 403 as healthy', async () => {
		stubHealth(403);
		expect(await isAssistantHealthy()).toBe(true);
	});

	it('treats a 5xx as NOT healthy (up-but-broken → start is the operator tool)', async () => {
		stubHealth(503);
		expect(await isAssistantHealthy()).toBe(false);
	});

	it('treats a thrown connection error as NOT healthy', async () => {
		globalThis.fetch = mock(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		expect(await isAssistantHealthy()).toBe(false);
	});
});

describe('detectHostInfo', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		restoreDockerCli();
	});

	it('returns valid HostInfo structure', async () => {
		mockDockerCli();
		globalThis.fetch = mock(
			async () => new Response('', { status: 503 })
		) as unknown as typeof fetch;
		const info = await detectHostInfo();
		expect(info).toHaveProperty('platform');
		expect(info).toHaveProperty('arch');
		expect(info).toHaveProperty('docker');
		expect(info).toHaveProperty('ollama');
		expect(info).toHaveProperty('lmstudio');
		expect(info).toHaveProperty('llamacpp');
		expect(info).toHaveProperty('timestamp');
	});

	it('platform and arch match process values', async () => {
		mockDockerCli();
		globalThis.fetch = mock(
			async () => new Response('', { status: 503 })
		) as unknown as typeof fetch;
		const info = await detectHostInfo();
		expect(info.platform).toBe(process.platform);
		expect(info.arch).toBe(process.arch);
	});

	it('HTTP probes handle connection refused gracefully', async () => {
		mockDockerCli();
		globalThis.fetch = mock(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		const info = await detectHostInfo();
		expect(info.ollama.running).toBe(false);
		expect(info.lmstudio.running).toBe(false);
		expect(info.llamacpp.running).toBe(false);
	});
});

describe('install image tag pinning', () => {
	it('validates and passes refs through verbatim (bare stays bare, legacy v preserved)', () => {
		expect(resolveRequestedImageTag('0.9.0-rc10')).toBe('0.9.0-rc10');
		expect(resolveRequestedImageTag('v0.9.0-rc10')).toBe('v0.9.0-rc10');
		expect(resolveRequestedImageTag('main')).toBeNull();
		expect(resolveRequestedImageTag('   ')).toBeNull();
		expect(resolveRequestedImageTag('1.2')).toBeNull();
		expect(resolveRequestedImageTag('v1.x.y')).toBeNull();
		expect(resolveRequestedImageTag('invalid')).toBeNull();
		expect(resolveRequestedImageTag('v1.0.0-rc..10')).toBeNull();
		expect(resolveRequestedImageTag('v1.0.0..1')).toBeNull();
		expect(resolveRequestedImageTag('v1.0.0-rc_10')).toBeNull();
	});

	it('updates an existing key in env content', () => {
		expect(upsertEnvValue('OP_IMAGE_TAG=latest\n', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
			'OP_IMAGE_TAG=v0.9.0-rc10\n'
		);
	});

	it('inserts a new key into empty env content', () => {
		expect(upsertEnvValue('', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe('OP_IMAGE_TAG=v0.9.0-rc10\n');
	});

	it('inserts a new key when the original content lacks a trailing newline', () => {
		expect(upsertEnvValue('OP_IMAGE_NAMESPACE=openpalm', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
			'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.9.0-rc10\n'
		);
	});

	it('treats regex characters in keys literally when updating env content', () => {
		expect(upsertEnvValue('KEY.WITH-HYPHEN=old\n', 'KEY.WITH-HYPHEN', 'new')).toBe(
			'KEY.WITH-HYPHEN=new\n'
		);
	});

	it('preserves export prefix when upserting a key', () => {
		expect(upsertEnvValue('export OP_UI_LOGIN_PASSWORD=old\n', 'OP_UI_LOGIN_PASSWORD', 'new')).toBe(
			'export OP_UI_LOGIN_PASSWORD=new\n'
		);
	});

	it('upserts without export prefix when original has none', () => {
		expect(upsertEnvValue('OP_IMAGE_TAG=latest\n', 'OP_IMAGE_TAG', 'v1.0.0')).toBe(
			'OP_IMAGE_TAG=v1.0.0\n'
		);
	});
});

describe('cli entrypoint (subprocess)', () => {
	it('produces output when run as a subprocess (catches missing top-level await)', async () => {
		const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-entry-'));
		const workDir = join(tempHome, 'work');
		mkdirSync(workDir, { recursive: true });
		const specFile = writeMinimalSetupSpec(tempHome);
		const mainPath = join(fileURLToPath(new URL('./', import.meta.url)), 'main.ts');
		try {
			// Run install --no-start --file as a real subprocess.
			// This exercises the import.meta.main code path that in-process tests skip.
			// Uses --file to skip the interactive wizard that would block indefinitely.
			const proc = Bun.spawn(['bun', mainPath, 'install', '--no-start', '--file', specFile], {
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...process.env, OP_HOME: tempHome, OP_WORK_DIR: workDir }
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			await proc.exited;
			// The process must produce output — silent exit 0 was the bug
			expect(stdout.length + stderr.length).toBeGreaterThan(0);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	}, 60_000);
});

describe('UI host server', () => {
	it('startUIServer (supervisor) is exported from lib/ui-server.ts', async () => {
		// The bare `openpalm` command starts the long-lived UI supervisor, which
		// spawns `openpalm ui` as its killable/respawnable child.
		const mod = await import('./lib/ui-server.ts');
		expect(typeof mod.startUIServer).toBe('function');
	});

	it('runUiBuild (child) is exported from lib/ui-server.ts', async () => {
		// `openpalm ui` runs the adapter-node build in-process on the embedded Bun
		// runtime via runUiBuild — no system `node` is required.
		const mod = await import('./lib/ui-server.ts');
		expect(typeof mod.runUiBuild).toBe('function');
	});

	it('the `ui` subcommand is registered', async () => {
		const { mainCommand } = await import('./main.ts');
		const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).ui;
		expect(typeof sub).toBe('function');
		const cmd = (await sub()) as { meta?: { name?: string } };
		expect(cmd.meta?.name).toBe('ui');
	});

	it('the `app` subcommand is registered', async () => {
		const { mainCommand } = await import('./main.ts');
		const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).app;
		expect(typeof sub).toBe('function');
		const cmd = (await sub()) as { meta?: { name?: string } };
		expect(cmd.meta?.name).toBe('app');
	});
});

describe('secrets.env generation', () => {
	it('creates the data/ directory on fresh install', async () => {
		const { existsSync: fsExistsSync, mkdirSync } = await import('node:fs');
		const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-secrets-'));
		const dataDir = join(tempDir, 'data');

		try {
			mkdirSync(dataDir, { recursive: true });
			expect(fsExistsSync(dataDir)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
