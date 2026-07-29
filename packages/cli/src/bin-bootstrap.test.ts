import { describe, expect, it } from 'bun:test';
import {
	ensureCachedBinary,
	parseExpectedChecksum,
	resolveArtifactName,
	resolveCacheRoot,
	resolvePackageVersion,
	runBinary
} from '../bin/openpalm.js';

describe('resolveArtifactName', () => {
	it('maps supported platform/arch pairs to their release binary name', () => {
		expect(resolveArtifactName('linux', 'x64')).toBe('openpalm-cli-linux-x64');
		expect(resolveArtifactName('linux', 'arm64')).toBe('openpalm-cli-linux-arm64');
		expect(resolveArtifactName('darwin', 'x64')).toBe('openpalm-cli-darwin-x64');
		expect(resolveArtifactName('darwin', 'arm64')).toBe('openpalm-cli-darwin-arm64');
		expect(resolveArtifactName('win32', 'x64')).toBe('openpalm-cli-windows-x64.exe');
		expect(resolveArtifactName('win32', 'arm64')).toBe('openpalm-cli-windows-x64.exe');
	});

	it('errors clearly for any other unpublished platform/arch', () => {
		expect(() => resolveArtifactName('freebsd', 'x64')).toThrow(
			/Unsupported platform: freebsd\/x64/
		);
		expect(() => resolveArtifactName('linux', 'ia32')).toThrow(/Unsupported platform: linux\/ia32/);
	});
});

describe('resolvePackageVersion', () => {
	it('resolves the version via an injected require (ESM-safe createRequire path)', () => {
		const fakeRequire = ((id: string) => {
			expect(id).toBe('../package.json');
			return { version: '9.9.9-test' };
		}) as unknown as NodeJS.Require;
		expect(resolvePackageVersion(fakeRequire)).toBe('9.9.9-test');
	});

	it("resolves the CLI package's real published version by default", () => {
		// Exercises the actual createRequire(import.meta.url) path against the
		// real package.json sitting next to bin/openpalm.js.
		expect(resolvePackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe('resolveCacheRoot', () => {
	it('honors an explicit OPENPALM_CACHE_DIR override', () => {
		expect(
			resolveCacheRoot({ OPENPALM_CACHE_DIR: '/tmp/custom-cache' }, 'linux', '/home/user')
		).toBe('/tmp/custom-cache');
	});

	it('uses XDG_CACHE_HOME on linux when set', () => {
		expect(resolveCacheRoot({ XDG_CACHE_HOME: '/home/user/.cache' }, 'linux', '/home/user')).toBe(
			'/home/user/.cache/openpalm'
		);
	});

	it('falls back to ~/.cache on linux', () => {
		expect(resolveCacheRoot({}, 'linux', '/home/user')).toBe('/home/user/.cache/openpalm');
	});

	it('uses Library/Caches on darwin', () => {
		expect(resolveCacheRoot({}, 'darwin', '/Users/user')).toBe(
			'/Users/user/Library/Caches/openpalm'
		);
	});

	it('uses LOCALAPPDATA on win32 when set', () => {
		expect(
			resolveCacheRoot(
				{ LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' },
				'win32',
				'C:\\Users\\user'
			)
		).toBe('C:\\Users\\user\\AppData\\Local/openpalm/Cache');
	});
});

describe('parseExpectedChecksum', () => {
	const checksums = [
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  openpalm-cli-linux-x64',
		'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  openpalm-cli-darwin-arm64'
	].join('\n');

	it('extracts the checksum for the requested artifact', () => {
		expect(parseExpectedChecksum(checksums, 'openpalm-cli-linux-x64')).toBe('a'.repeat(64));
		expect(parseExpectedChecksum(checksums, 'openpalm-cli-darwin-arm64')).toBe('b'.repeat(64));
	});

	it('throws when no line matches the artifact', () => {
		expect(() => parseExpectedChecksum(checksums, 'openpalm-cli-windows-x64.exe')).toThrow(
			/No published checksum found/
		);
	});
});

describe('ensureCachedBinary', () => {
	const version = '1.2.3';
	const artifact = 'openpalm-cli-linux-x64';
	const cacheRoot = '/fake/cache/root';
	const finalPath = `${cacheRoot}/bin/${version}/${artifact}`;

	function fakeFs(overrides: Partial<Record<string, unknown>> = {}) {
		const calls: Record<string, unknown[][]> = {
			existsSync: [],
			mkdirSync: [],
			writeFileSync: [],
			renameSync: [],
			rmSync: [],
			chmodSync: []
		};
		return {
			calls,
			existsSync: (...args: unknown[]) => {
				calls.existsSync.push(args);
				return false;
			},
			mkdirSync: (...args: unknown[]) => {
				calls.mkdirSync.push(args);
			},
			writeFileSync: (...args: unknown[]) => {
				calls.writeFileSync.push(args);
			},
			renameSync: (...args: unknown[]) => {
				calls.renameSync.push(args);
			},
			rmSync: (...args: unknown[]) => {
				calls.rmSync.push(args);
			},
			chmodSync: (...args: unknown[]) => {
				calls.chmodSync.push(args);
			},
			...overrides
		};
	}

	it('returns the cached path immediately on a cache hit — no network involved', async () => {
		let fetchCalled = false;
		const fs = fakeFs({ existsSync: () => true });
		const path = await ensureCachedBinary({
			version,
			artifact,
			cacheRoot,
			fetchImpl: () => {
				fetchCalled = true;
				throw new Error('must not be called on a cache hit');
			},
			fs
		});
		expect(path).toBe(finalPath);
		expect(fetchCalled).toBe(false);
	});

	it('downloads, verifies checksum, and caches the binary on a cache miss (fetch/fs fully stubbed)', async () => {
		const bytes = new TextEncoder().encode('fake-binary-contents');
		const expectedHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
		const checksumsBody = `${expectedHash}  ${artifact}\n`;
		const fs = fakeFs();

		const fetchImpl = (async (url: string) => {
			if (url.endsWith('checksums-sha256.txt')) {
				return { ok: true, text: async () => checksumsBody } as Response;
			}
			if (url.endsWith(artifact)) {
				return { ok: true, arrayBuffer: async () => bytes.buffer } as Response;
			}
			throw new Error(`unexpected url ${url}`);
		}) as typeof fetch;

		const path = await ensureCachedBinary({ version, artifact, cacheRoot, fetchImpl, fs });

		expect(path).toBe(finalPath);
		expect(fs.calls.mkdirSync[0]?.[0]).toBe(`${cacheRoot}/bin/${version}`);
		expect(fs.calls.writeFileSync).toHaveLength(1);
		expect(fs.calls.chmodSync[0]?.[1]).toBe(0o755);
		expect(fs.calls.renameSync[0]?.[1]).toBe(finalPath);
	});

	it('fails closed on a checksum mismatch and does not cache the binary', async () => {
		const bytes = new TextEncoder().encode('tampered-contents');
		const wrongHash = 'f'.repeat(64);
		const checksumsBody = `${wrongHash}  ${artifact}\n`;
		const fs = fakeFs();

		const fetchImpl = (async (url: string) => {
			if (url.endsWith('checksums-sha256.txt')) {
				return { ok: true, text: async () => checksumsBody } as Response;
			}
			return { ok: true, arrayBuffer: async () => bytes.buffer } as Response;
		}) as typeof fetch;

		await expect(
			ensureCachedBinary({ version, artifact, cacheRoot, fetchImpl, fs })
		).rejects.toThrow(/Checksum mismatch/);
		expect(fs.calls.writeFileSync).toHaveLength(0);
		expect(fs.calls.renameSync).toHaveLength(0);
	});

	it('fails closed when the binary download itself 404s', async () => {
		const fs = fakeFs();
		const fetchImpl = (async (url: string) => {
			if (url.endsWith('checksums-sha256.txt')) {
				return { ok: true, text: async () => '' } as Response;
			}
			return { ok: false, status: 404 } as Response;
		}) as typeof fetch;

		await expect(
			ensureCachedBinary({ version, artifact, cacheRoot, fetchImpl, fs })
		).rejects.toThrow(/Failed to download openpalm-cli-linux-x64 \(404\)/);
	});
});

describe('runBinary', () => {
	it('propagates the child process exit code', () => {
		const spawn = () =>
			({ status: 3, error: undefined, signal: null }) as ReturnType<
				typeof import('node:child_process').spawnSync
			>;
		expect(runBinary('/fake/bin', [], spawn)).toBe(3);
	});

	it('returns 0 for a clean exit', () => {
		const spawn = () =>
			({ status: 0, error: undefined, signal: null }) as ReturnType<
				typeof import('node:child_process').spawnSync
			>;
		expect(runBinary('/fake/bin', [], spawn)).toBe(0);
	});

	it('rethrows a spawn error (e.g. ENOENT)', () => {
		const spawn = () =>
			({ status: null, error: new Error('spawn ENOENT'), signal: null }) as ReturnType<
				typeof import('node:child_process').spawnSync
			>;
		expect(() => runBinary('/fake/bin', [], spawn)).toThrow(/spawn ENOENT/);
	});

	it('returns a non-zero code when the child died from a signal', () => {
		const spawn = () =>
			({ status: null, error: undefined, signal: 'SIGKILL' }) as ReturnType<
				typeof import('node:child_process').spawnSync
			>;
		expect(runBinary('/fake/bin', [], spawn)).toBe(1);
	});
});
