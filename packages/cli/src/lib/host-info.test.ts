import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostInfo, dockerBinAvailable } from './host-info.ts';

/**
 * #655.1: host-info.ts used to check Docker availability with a hardcoded
 * `Bun.which('docker')` / `Bun.spawn(['docker', 'info'])` — bypassing
 * `dockerBin()`/`OP_DOCKER_BIN` entirely, so a host running a Docker-compatible
 * engine under a different binary name (podman, a shim) was reported as
 * "Docker not available" even though the engine the rest of OpenPalm would use
 * was right there. These tests cover the fixed dockerBin()-routed resolution.
 */
describe('dockerBinAvailable', () => {
  let scriptDir: string;

  beforeEach(() => {
    scriptDir = mkdtempSync(join(tmpdir(), 'openpalm-host-info-'));
  });

  afterEach(() => {
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it('resolves a bare binary name via PATH (Bun.which)', () => {
    // "sh" is present on PATH in every environment this runs in.
    expect(dockerBinAvailable('sh')).toBe(true);
  });

  it('reports a bare name that is not on PATH as unavailable', () => {
    expect(dockerBinAvailable('openpalm-definitely-not-a-real-binary')).toBe(false);
  });

  it('resolves an explicit path with existsSync, not PATH lookup', () => {
    const scriptPath = join(scriptDir, 'fake-docker.sh');
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n');
    chmodSync(scriptPath, 0o755);
    expect(dockerBinAvailable(scriptPath)).toBe(true);
  });

  it('reports a non-existent explicit path as unavailable, even though it looks like a path', () => {
    expect(dockerBinAvailable(join(scriptDir, 'does-not-exist'))).toBe(false);
  });

  it('resolves a Windows-style backslash path via existsSync semantics (not PATH)', () => {
    // Not a real Windows path on this platform, but proves the backslash
    // branch routes to existsSync (and therefore reports false) rather than
    // silently falling through to a PATH lookup.
    expect(dockerBinAvailable('C:\\nonexistent\\docker.exe')).toBe(false);
  });
});

describe('detectHostInfo (routes through dockerBin()/OP_DOCKER_BIN, not a hardcoded "docker")', () => {
  const savedBin = process.env.OP_DOCKER_BIN;
  let scriptDir: string;

  beforeEach(() => {
    scriptDir = mkdtempSync(join(tmpdir(), 'openpalm-host-info-detect-'));
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.OP_DOCKER_BIN;
    else process.env.OP_DOCKER_BIN = savedBin;
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it('reports docker available+running when OP_DOCKER_BIN points at a working engine shim', async () => {
    const scriptPath = join(scriptDir, 'fake-docker.sh');
    writeFileSync(scriptPath, ['#!/bin/sh', 'if [ "$1" = "info" ]; then exit 0; fi', 'exit 1', ''].join('\n'));
    chmodSync(scriptPath, 0o755);
    process.env.OP_DOCKER_BIN = scriptPath;

    const info = await detectHostInfo();
    expect(info.docker.available).toBe(true);
    expect(info.docker.running).toBe(true);
  });

  it('reports docker available but NOT running when the shim exists but `info` fails (daemon down)', async () => {
    const scriptPath = join(scriptDir, 'fake-docker-stopped.sh');
    writeFileSync(scriptPath, ['#!/bin/sh', 'exit 1', ''].join('\n'));
    chmodSync(scriptPath, 0o755);
    process.env.OP_DOCKER_BIN = scriptPath;

    const info = await detectHostInfo();
    expect(info.docker.available).toBe(true);
    expect(info.docker.running).toBe(false);
  });

  it('reports docker unavailable when OP_DOCKER_BIN points at nothing', async () => {
    process.env.OP_DOCKER_BIN = join(scriptDir, 'does-not-exist');

    const info = await detectHostInfo();
    expect(info.docker.available).toBe(false);
    expect(info.docker.running).toBe(false);
  });
});
