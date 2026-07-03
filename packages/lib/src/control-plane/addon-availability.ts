/**
 * Host-capability detection for addon profiles.
 *
 * Split out from addons.ts: these probes inspect the *host* (docker runtimes,
 * GPU device nodes, published image manifests) rather than compose/state, so
 * they belong to their own cohesive module. Everything here uses execFile (no
 * shell) and never throws — errors collapse to `{ available: false, reason }`.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolveHardwareProfileVariant } from './profile-ids.js';
import type { AddonProfile } from './addons.js';

export type AddonProfileAvailability = { available: boolean; reason?: string };

const HOST_PROBE_TIMEOUT_MS = 2_000;

// Process-lifetime cache. Hardware presence does not change while the UI
// server is running, so probing once is enough.
const availabilityCache = new Map<string, AddonProfileAvailability>();

/**
 * Reset the host-capability cache. Test-only — hardware doesn't change at
 * runtime, so production code never needs to clear it.
 */
export function resetAvailabilityCache(): void {
  availabilityCache.clear();
}

/**
 * execFile wrapper that never throws and synthesises actionable stderr for
 * spawn errors.
 *
 * ENOENT (binary missing) surfaces here with no stderr — child_process never
 * gets to exec the program. Inject a synthetic stderr that matches the
 * translateDockerError ENOENT regex so callers get actionable copy instead of
 * "unknown error (no stderr)".
 */
export function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      let mergedStderr = stderr?.toString() ?? '';
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code && !mergedStderr) {
        if (code === 'ENOENT') {
          mergedStderr = `spawn ${cmd} ENOENT: command not found`;
        } else {
          mergedStderr = `spawn ${cmd} ${code}`;
        }
      }
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: mergedStderr,
      });
    });
  });
}

/**
 * Compute the openpalm/voice image ref for a given GPU variant, matching
 * the substitution chain in the addon compose file:
 *   ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_VERSION:-latest-<variant>}
 *
 * Voice images are published OUT OF BAND (publish-voice.yml), decoupled from the
 * other service images — they are heavy and rarely change. So the default is the
 * moving `latest-<variant>` voice tag; operators pin a specific build by setting
 * OP_VOICE_VERSION (e.g. `v1.0.0-cpu`). A bare `latest` (the seeded default) is
 * treated as "unset" so the GPU-variant default still applies.
 */
function voiceImageRef(variant: 'cpu' | 'cu121' | 'rocm6'): string {
  const namespace = process.env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
  const explicit = process.env.OP_VOICE_VERSION?.trim();
  if (explicit && explicit !== 'latest') return `${namespace}/voice:${explicit}`;
  return `${namespace}/voice:latest-${variant}`;
}

/**
 * `docker manifest inspect <ref>` returns 0 only when the registry can
 * resolve a manifest for that ref. We use it as the cheap "is this image
 * actually published?" check — no pull required. The retry handles
 * transient registry hiccups. Timeout is short because the manifest blob
 * is a few KB.
 */
async function dockerManifestExists(imageRef: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await execFileNoThrow(
      'docker',
      ['manifest', 'inspect', imageRef],
      5_000,
    );
    if (res.ok) return true;
    // If docker itself is missing (ENOENT), retrying won't help.
    if (/ENOENT/.test(res.stderr)) return false;
  }
  return false;
}

async function probeCuda(): Promise<AddonProfileAvailability> {
  // Two acceptance signals:
  //   1. `docker info` reports an `nvidia` runtime (toolkit installed +
  //      `nvidia-ctk runtime configure --runtime=docker` was run).
  //   2. `/etc/cdi/nvidia.yaml` exists (CDI-mode daemon with a generated
  //      spec). We don't require the runtime in this case — the route's
  //      CDI fallback can switch the compose to driver:cdi.
  try {
    if (existsSync('/etc/cdi/nvidia.yaml')) return { available: true };
  } catch {
    // existsSync only throws on path-syntax issues; ignore and probe docker.
  }

  const result = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    HOST_PROBE_TIMEOUT_MS,
  );
  if (result.ok && result.stdout.includes('"nvidia"')) {
    return { available: true };
  }
  return {
    available: false,
    reason: 'NVIDIA runtime not registered. Install nvidia-container-toolkit or enable CDI.',
  };
}

async function probeRocm(): Promise<AddonProfileAvailability> {
  // Hardware gate: ROCm needs both the KFD char device and the GPU DRI nodes.
  let devicesPresent = false;
  try {
    devicesPresent = existsSync('/dev/kfd') && existsSync('/dev/dri');
  } catch {
    devicesPresent = false;
  }
  if (!devicesPresent) {
    return {
      available: false,
      reason: 'AMD ROCm devices not present on this host.',
    };
  }

  // Image gate: the openpalm/voice:*-rocm6 image isn't published yet, so
  // even on a fully-functional ROCm host the compose-up would fail with a
  // manifest-unknown pull error. Refuse the profile until the image lands.
  const imageRef = voiceImageRef('rocm6');
  const published = await dockerManifestExists(imageRef);
  if (!published) {
    return {
      available: false,
      reason: 'AMD ROCm image not published yet. Check back in a future release or use the CPU profile.',
    };
  }
  return { available: true };
}

/**
 * Probe the host for the capabilities required by an addon profile.
 *
 * Results are cached for the lifetime of the process — hardware doesn't
 * change while the UI server runs. All probes use execFile (no shell)
 * and never throw: errors collapse to `{ available: false, reason }`.
 *
 * Unknown profile ids default to `available: true` so unrelated addons
 * (e.g. a future "high-mem" profile that doesn't probe hardware) keep
 * working without code changes here.
 */
export async function getAddonProfileAvailability(
  profile: Pick<AddonProfile, 'id'>,
): Promise<AddonProfileAvailability> {
  const cacheKey = profile.id;
  const cached = availabilityCache.get(cacheKey);
  if (cached) return cached;

  let result: AddonProfileAvailability;
  try {
    const variant = resolveHardwareProfileVariant(profile.id);
    if (variant === 'cpu') {
      result = { available: true };
    } else if (variant === 'cuda') {
      result = await probeCuda();
    } else if (variant === 'rocm') {
      result = await probeRocm();
    } else {
      // Unknown profile id — assume available; caller is responsible for
      // labelling profiles that need host capability gating.
      result = { available: true };
    }
  } catch (err) {
    // Belt-and-braces: any unexpected throw collapses to unavailable.
    const reason = err instanceof Error ? err.message : String(err);
    result = { available: false, reason: `probe failed: ${reason}` };
  }

  availabilityCache.set(cacheKey, result);
  return result;
}
