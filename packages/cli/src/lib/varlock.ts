import { copyFile, mkdir, mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VARLOCK_VERSION = '0.4.0';

const VARLOCK_CHECKSUMS: Record<string, string> = {
  'varlock-linux-x64.tar.gz': '820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab',
  'varlock-linux-arm64.tar.gz': 'e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8',
  'varlock-macos-x64.tar.gz': 'e6abf0d97da8ff7c98b0e9044a8b71f48fbf74a0d7bfc2543a81575a07b7a03b',
  'varlock-macos-arm64.tar.gz': '228e4c2666b9fa50a83a8713a848e7a0f0044d7fd7c9d441d43e6ebccad2f4a3',
};

function varlockArtifactName(): string {
  const platformMap: Record<string, string> = {
    linux: 'linux',
    darwin: 'macos',
  };
  const archMap: Record<string, string> = {
    x64: 'x64',
    arm64: 'arm64',
  };

  const os = platformMap[process.platform];
  const arch = archMap[process.arch];

  if (!os || !arch) {
    throw new Error(
      `Unsupported platform/arch for varlock: ${process.platform}/${process.arch}. ` +
        `Supported: linux/x64, linux/arm64, darwin/x64, darwin/arm64.`,
    );
  }

  return `varlock-${os}-${arch}.tar.gz`;
}

/**
 * Co-locate a schema and env file in a temp directory so varlock can discover them.
 */
export async function prepareVarlockDir(schemaPath: string, envPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'varlock-'));
  await copyFile(schemaPath, join(dir, '.env.schema'));
  await copyFile(envPath, join(dir, '.env'));
  return dir;
}

/**
 * Downloads varlock binary and caches it in data/bin/.
 * Skips download if binary already exists.
 */
export async function ensureVarlock(dataDir: string): Promise<string> {
  const binDir = join(dataDir, 'bin');
  const varlockBin = join(binDir, 'varlock');

  if (await Bun.file(varlockBin).exists()) {
    return varlockBin;
  }

  await mkdir(binDir, { recursive: true });

  const artifact = varlockArtifactName();
  const expectedHash = VARLOCK_CHECKSUMS[artifact];
  if (!expectedHash) {
    throw new Error(
      `No SHA-256 checksum on record for ${artifact}. ` +
        `Cannot verify download integrity.`,
    );
  }

  const tarballUrl = `https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/${artifact}`;
  const tarballPath = join(binDir, 'varlock.tar.gz');

  const downloadProc = Bun.spawn(
    ['curl', '-fsSL', '--retry', '5', '--retry-delay', '10', '--retry-all-errors', tarballUrl, '-o', tarballPath],
    {
      env: { ...process.env, HOME: process.env.HOME ?? '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const downloadCode = await downloadProc.exited;
  if (downloadCode !== 0) {
    throw new Error(`Failed to download varlock tarball (curl exited with code ${downloadCode})`);
  }

  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(tarballPath).arrayBuffer());
  const actualHash = hasher.digest('hex');
  if (actualHash !== expectedHash) {
    try { await unlink(tarballPath); } catch { /* best effort */ }
    throw new Error(
      `varlock tarball SHA-256 verification failed — download may be corrupted.\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}`,
    );
  }

  const extractProc = Bun.spawn(
    ['tar', 'xzf', tarballPath, '--strip-components=1', '-C', binDir],
    {
      env: { ...process.env, HOME: process.env.HOME ?? '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const extractCode = await extractProc.exited;
  if (extractCode !== 0) {
    throw new Error(`Failed to extract varlock tarball (tar exited with code ${extractCode})`);
  }

  try { await unlink(tarballPath); } catch { /* best effort */ }

  const chmodProc = Bun.spawn(['chmod', '+x', varlockBin]);
  const chmodCode = await chmodProc.exited;
  if (chmodCode !== 0) {
    throw new Error(`chmod +x failed for varlock binary (exit code ${chmodCode})`);
  }

  // macOS: clear quarantine flag and ad-hoc codesign so Gatekeeper does not kill the binary
  if (process.platform === 'darwin') {
    const xattr = Bun.spawn(['xattr', '-cr', varlockBin], { stdout: 'ignore', stderr: 'ignore' });
    await xattr.exited;
    const codesign = Bun.spawn(['codesign', '--force', '--sign', '-', varlockBin], { stdout: 'ignore', stderr: 'ignore' });
    await codesign.exited;
  }

  if (!(await Bun.file(varlockBin).exists())) {
    throw new Error(`varlock binary not found at ${varlockBin} after install`);
  }

  return varlockBin;
}
