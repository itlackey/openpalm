import { existsSync } from 'node:fs';
import { dockerBin } from '@openpalm/lib';

export interface HostInfo {
  platform: string;
  arch: string;
  docker: { available: boolean; running: boolean };
  ollama: { running: boolean; url: string };
  lmstudio: { running: boolean; url: string };
  llamacpp: { running: boolean; url: string };
  timestamp: string;
}

/**
 * Resolve whether the configured docker binary ({@link dockerBin}, honoring
 * OP_DOCKER_BIN) is actually available. A bare name (the "docker" default, or
 * an override like "podman" with no path separator) needs PATH resolution —
 * `Bun.which`. An explicit path (OP_DOCKER_BIN pointed at a specific binary
 * or shim) is checked directly with `existsSync`: `Bun.which` only resolves
 * bare command names against PATH and does not confirm an absolute/relative
 * path actually exists.
 */
export function dockerBinAvailable(bin: string): boolean {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  return Boolean(Bun.which(bin));
}

/**
 * Detects host system information including platform, Docker availability,
 * and local AI service endpoints.
 */
export async function detectHostInfo(): Promise<HostInfo> {
  const bin = dockerBin();
  const dockerAvailable = dockerBinAvailable(bin);
  let dockerRunning = false;
  if (dockerAvailable) {
    const proc = Bun.spawn([bin, 'info'], { stdout: 'ignore', stderr: 'ignore' });
    dockerRunning = (await proc.exited) === 0;
  }

  async function probeHttp(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  const [ollamaRunning, lmstudioRunning, llamacppRunning] = await Promise.all([
    probeHttp('http://localhost:11434/api/tags'),
    probeHttp('http://localhost:1234/v1/models'),
    probeHttp('http://localhost:8080/health'),
  ]);

  return {
    platform: process.platform,
    arch: process.arch,
    docker: { available: dockerAvailable, running: dockerRunning },
    ollama: { running: ollamaRunning, url: 'http://localhost:11434' },
    lmstudio: { running: lmstudioRunning, url: 'http://localhost:1234' },
    llamacpp: { running: llamacppRunning, url: 'http://localhost:8080' },
    timestamp: new Date().toISOString(),
  };
}
