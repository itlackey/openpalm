import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineCommand } from 'citty';

const REPO = 'itlackey/openpalm';

function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

async function resolveLatestVersion(): Promise<string> {
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const match = (res.headers.get('location') ?? '').match(/\/tag\/(v[0-9]+\.[0-9]+\.[0-9]+[^\s]*)$/);
    if (match?.[1]) return match[1];
  } catch {
    // fall through
  }

  throw new Error('Unable to resolve the latest OpenPalm release.');
}

export function resolveCliArtifactName(platform = process.platform, arch = process.arch): string {
  if (platform === 'linux' && arch === 'x64') return 'openpalm-cli-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'openpalm-cli-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'openpalm-cli-darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'openpalm-cli-darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'openpalm-cli-windows-x64.exe';
  if (platform === 'win32' && arch === 'arm64') return 'openpalm-cli-windows-arm64.exe';
  throw new Error(`Unsupported platform for self-update: ${platform}/${arch}`);
}

export function canReplaceCurrentExecutable(execPath = process.execPath): boolean {
  const execName = basename(execPath).toLowerCase();
  return execName !== 'bun' && execName !== 'bun.exe';
}

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseExpectedChecksum(checksums: string, artifact: string): string {
  const line = checksums
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(` ${artifact}`) || entry.endsWith(`  ${artifact}`));

  if (!line) throw new Error(`No published checksum found for ${artifact}.`);
  const checksum = line.split(/\s+/)[0]?.trim();
  if (!checksum) throw new Error(`Published checksum entry for ${artifact} is invalid.`);
  return checksum;
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function downloadVerifiedBinary(version: string, artifact: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'openpalm-self-update-'));
  const artifactPath = join(tempDir, artifact);
  const binaryUrl = `https://github.com/${REPO}/releases/download/${version}/${artifact}`;
  const checksumUrl = `https://github.com/${REPO}/releases/download/${version}/checksums-sha256.txt`;

  const [binaryRes, checksumRes] = await Promise.all([
    fetch(binaryUrl, { signal: AbortSignal.timeout(60_000) }),
    fetch(checksumUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);

  if (!binaryRes.ok) throw new Error(`Failed to download ${artifact} (${binaryRes.status}).`);
  if (!checksumRes.ok) throw new Error(`Failed to download release checksums (${checksumRes.status}).`);

  const binaryBytes = new Uint8Array(await binaryRes.arrayBuffer());
  const expected = parseExpectedChecksum(await checksumRes.text(), artifact);
  const actual = sha256Hex(binaryBytes);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${artifact}: expected ${expected}, got ${actual}.`);
  }

  await Bun.write(artifactPath, binaryBytes);
  await chmod(artifactPath, 0o755);
  return artifactPath;
}

async function schedulePosixReplacement(sourcePath: string, targetPath: string): Promise<void> {
  const scriptDir = await mkdtemp(join(tmpdir(), 'openpalm-self-update-script-'));
  const scriptPath = join(scriptDir, 'replace.sh');
  const script = [
    '#!/usr/bin/env sh',
    'set -eu',
    'sleep 1',
    `tmp=${posixShellQuote(sourcePath)}`,
    `dest=${posixShellQuote(targetPath)}`,
    'chmod +x "$tmp"',
    'mv "$tmp" "$dest"',
    `rm -rf ${posixShellQuote(scriptDir)}`,
  ].join('\n') + '\n';

  await Bun.write(scriptPath, script);
  await chmod(scriptPath, 0o755);

  const proc = Bun.spawn(['sh', scriptPath], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  proc.unref();
}

export default defineCommand({
  meta: {
    name: 'self-update',
    description: 'Replace the installed OpenPalm CLI binary with the latest release build',
  },
  args: {
    version: {
      type: 'string',
      description: 'Install a specific release tag instead of the latest release',
    },
  },
  async run({ args }) {
    if (process.platform === 'win32') {
      throw new Error('Self-update is not supported on Windows yet because running executables cannot be replaced reliably while they are in use. Download and run setup.ps1 with --cli-only to refresh only the CLI binary.');
    }

    if (!canReplaceCurrentExecutable()) {
      throw new Error('Self-update requires the compiled OpenPalm binary. Reinstall with setup.sh --cli-only instead.');
    }

    const version = args.version ? normalizeVersion(args.version) : await resolveLatestVersion();
    const artifact = resolveCliArtifactName();
    const executablePath = process.execPath;
    const tempBinary = await downloadVerifiedBinary(version, artifact);

    try {
      await schedulePosixReplacement(tempBinary, executablePath);
    } catch (err) {
      await rm(dirname(tempBinary), { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    console.log(`Downloaded ${artifact} for ${version}.`);
    console.log(`The CLI at ${executablePath} will be replaced after this command exits.`);
  },
});
